/**
 * Discord gateway (Fase 1): events → sessions → replies.
 *
 * Same trigger rules as the Go bot:
 * - only allowlisted guild text channels (DMs, bots and webhooks ignored)
 * - reply when mentioned or when replying to one of our messages
 * - per-channel cooldown, FIFO queue of 8 pending replies
 */

import { Client, Events, GatewayIntentBits, type Message, type OmitPartialGroupDMChannel } from "discord.js";
import type { BotSettings } from "./config.ts";
import { roleOf } from "./roles.ts";
import { splitMessage } from "./split.ts";

export type Respond = (channelId: string, authorId: string, text: string) => Promise<string>;

type GuildMessage = OmitPartialGroupDMChannel<Message<boolean>>;

interface Incoming {
	message: GuildMessage;
	channelId: string;
	authorId: string;
	text: string;
}

export function isEligibleChannel(message: Message, settings: BotSettings): boolean {
	if (message.guildId == null) return false; // DMs ignored (like the Go bot)
	if (message.guildId !== settings.discord.guild_id && settings.discord.guild_id !== "") {
		return false;
	}
	return settings.discord.channel_ids.includes(message.channelId);
}

export function isTrigger(message: GuildMessage, botUserId: string): boolean {
	if (message.author.bot || message.author.system) return false;
	if (message.webhookId) return false;
	if (message.mentions.has(botUserId)) return true;
	const ref = message.reference;
	if (ref?.messageId) {
		const replied = message.channel.messages.cache.get(ref.messageId);
		if (replied?.author.id === botUserId) return true;
	}
	return false;
}

const MAX_QUEUE = 8;

const WORKING_EMOJI = "\u23F1\uFE0F"; // ⏱️ while working
const DONE_EMOJI = "\u2705"; // ✅ on success
const ERROR_EMOJI = "\u274C"; // ❌ on failure

interface Reactable {
	react(emoji: string): Promise<unknown>;
	reactions: { cache: Map<string, { users: { remove(id: string): Promise<unknown> } }> };
	channel: { sendTyping(): Promise<unknown> };
}

async function tryReact(message: Reactable, emoji: string): Promise<void> {
	try {
		await message.react(emoji);
	} catch {
		/* missing permission or unknown emoji: reply still goes through */
	}
}

async function tryUnreact(message: Reactable, botUserId: string, emoji: string): Promise<void> {
	try {
		await message.reactions.cache.get(emoji)?.users.remove(botUserId);
	} catch {
		/* best effort */
	}
}

/**
 * Working indicator: ⏱️ + typing while `work()` runs, swapped for ✅/❌ after.
 * Reactions never break the reply — every step is best-effort.
 */
export async function trackWorking<T>(message: Reactable, botUserId: string, work: () => Promise<T>): Promise<T> {
	await tryReact(message, WORKING_EMOJI);
	// Detached keep-alive: sendTyping expires after ~10s, so refresh until
	// work() settles. Fire-and-forget on purpose — awaiting it would delay
	// the reply by one sleep cycle.
	let typing = true;
	void (async () => {
		while (typing) {
			try {
				await message.channel.sendTyping();
			} catch {
				/* ignore */
			}
			await new Promise((r) => setTimeout(r, 9000));
		}
	})();
	try {
		const result = await work();
		typing = false;
		await tryUnreact(message, botUserId, WORKING_EMOJI);
		await tryReact(message, DONE_EMOJI);
		return result;
	} catch (err) {
		typing = false;
		await tryUnreact(message, botUserId, WORKING_EMOJI);
		await tryReact(message, ERROR_EMOJI);
		throw err;
	}
}

export class DiscordGateway {
	private readonly client: Client;
	private readonly queues = new Map<string, Incoming[]>();
	private readonly running = new Set<string>();
	private readonly lastReply = new Map<string, number>();
	private botUserId = "";

	private readonly getSettings: () => BotSettings;
	private readonly respond: Respond;
	private readonly onReady: ((tag: string) => void) | undefined;
	private readonly emit: (msg: string, attrs?: Record<string, unknown>) => void;

	constructor(
		getSettings: () => BotSettings,
		respond: Respond,
		client?: Client,
		onReady?: (tag: string) => void,
		emit: (msg: string, attrs?: Record<string, unknown>) => void = (m) => console.log(m),
	) {
		this.getSettings = getSettings;
		this.respond = respond;
		this.onReady = onReady;
		this.emit = emit;
		this.client =
			client ??
			new Client({
				intents: [
					GatewayIntentBits.Guilds,
					GatewayIntentBits.GuildMessages,
					// Privileged: enable "Message Content Intent" in the dev portal (like the Go bot).
					GatewayIntentBits.MessageContent,
				],
			});
	}

	settings(): BotSettings {
		return this.getSettings();
	}

	/** Test hook: last reply timestamp per channel. */
	lastReplyAt(channelId: string): number {
		return this.lastReply.get(channelId) ?? 0;
	}

	/** Test hook: pending queue depth per channel. */
	queueDepth(channelId: string): number {
		return this.queues.get(channelId)?.length ?? 0;
	}

	async start(token: string): Promise<void> {
		this.client.once(Events.ClientReady, (c) => {
			this.botUserId = c.user.id;
			this.onReady?.(c.user.tag);
		});
		this.client.on(Events.MessageCreate, (m) => {
			void this.onMessage(m as Message);
		});
		await this.client.login(token);
	}

	async stop(): Promise<void> {
		this.client.destroy();
		this.queues.clear();
		this.running.clear();
	}

	private async onMessage(message: Message): Promise<void> {
		const settings = this.getSettings();
		const eligible = isEligibleChannel(message, settings);
		this.emit(
			`msg canal=${message.channelId} autor=${message.author?.id} guild=${message.guildId} eligible=${eligible}`,
		);
		if (!eligible) return;
		const m = message as GuildMessage;
		const trigger = this.botUserId !== "" && isTrigger(m, this.botUserId);
		this.emit(`msg trigger=${trigger} mencoes=${m.mentions.users.size}`);
		if (!trigger) return;

		const incoming: Incoming = {
			message: m,
			channelId: m.channelId,
			authorId: m.author.id,
			text: m.content,
		};
		let queue = this.queues.get(m.channelId);
		if (!queue) {
			queue = [];
			this.queues.set(m.channelId, queue);
		}
		if (queue.length >= MAX_QUEUE) return; // full: drop (like the Go bot)
		queue.push(incoming);
		void this.pump(m.channelId);
	}

	private async pump(channelId: string): Promise<void> {
		if (this.running.has(channelId)) return;
		this.running.add(channelId);
		try {
			for (;;) {
				const queue = this.queues.get(channelId);
				const next = queue?.shift();
				if (!next) break;
				await this.replyOne(next);
			}
		} finally {
			this.running.delete(channelId);
		}
	}

	private async replyOne(incoming: Incoming): Promise<void> {
		const settings = this.getSettings();
		const now = Date.now();
		const cooldown = settings.bot.reply_cooldown_ms;
		const elapsed = now - (this.lastReply.get(incoming.channelId) ?? 0);
		if (elapsed < cooldown) {
			await new Promise((r) => setTimeout(r, cooldown - elapsed));
		}
		try {
			const role = roleOf(incoming.authorId, settings);
			this.emit(`resposta canal=${incoming.channelId} role=${role} len=${incoming.text.length}`);
			const answer = await trackWorking(incoming.message, this.botUserId, () =>
				this.respond(incoming.channelId, incoming.authorId, incoming.text),
			);
			this.emit(`resposta ok canal=${incoming.channelId} len=${answer.length}`);
			this.lastReply.set(incoming.channelId, Date.now());
			const chunks = splitMessage(answer);
			let first = true;
			for (const chunk of chunks) {
				if (first) {
					await incoming.message.reply(chunk);
					first = false;
				} else {
					await incoming.message.channel.send(chunk);
				}
			}
		} catch (err) {
			this.emit(`resposta ERRO canal=${incoming.channelId}: ${err instanceof Error ? err.message : String(err)}`);
			await incoming.message
				.reply(`falhei aqui: ${err instanceof Error ? err.message : String(err)}`)
				.catch(() => undefined);
		}
	}
}
