import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "./config.ts";
import { DiscordGateway, isEligibleChannel, isTrigger } from "./gateway.ts";

const settings = () => ({
	...DEFAULTS,
	discord: { guild_id: "g1", channel_ids: ["c1"], admin_ids: [] },
	bot: { ...DEFAULTS.bot, reply_cooldown_ms: 0 },
});

function message(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		guildId: "g1",
		channelId: "c1",
		author: { id: "u1", username: "ana", bot: false, system: false },
		webhookId: null,
		content: "oi",
		mentions: { users: { size: 0 }, has: () => false },
		reference: undefined,
		channel: { messages: { cache: new Map() } },
		...over,
	};
}

describe("isEligibleChannel", () => {
	it("só canal allowlist de guild (DM/bot fora)", () => {
		expect(isEligibleChannel(message() as never, settings())).toBe(true);
		expect(isEligibleChannel(message({ guildId: null }) as never, settings())).toBe(false);
		expect(isEligibleChannel(message({ guildId: "outra" }) as never, settings())).toBe(false);
		expect(isEligibleChannel(message({ channelId: "c9" }) as never, settings())).toBe(false);
	});
});

describe("isTrigger", () => {
	it("menção dispara; bot/webhook/silêncio não", () => {
		const mentioned = message({ mentions: { users: { size: 1 }, has: () => true } });
		expect(isTrigger(mentioned as never, "bot")).toBe(true);
		expect(isTrigger(message({ author: { id: "b", bot: true } }) as never, "bot")).toBe(false);
		expect(isTrigger(message({ webhookId: "w" }) as never, "bot")).toBe(false);
		expect(isTrigger(message() as never, "bot")).toBe(false);
	});

	it("resposta a mensagem do bot dispara", () => {
		const cache = new Map([["m0", { author: { id: "bot" } }]]);
		const m = message({ reference: { messageId: "m0" }, channel: { messages: { cache } } });
		expect(isTrigger(m as never, "bot")).toBe(true);
		const m2 = message({ reference: { messageId: "zz" }, channel: { messages: { cache } } });
		expect(isTrigger(m2 as never, "bot")).toBe(false);
	});
});

function stubIncoming() {
	const sent: unknown[] = [];
	const reacted: string[] = [];
	const msg = {
		id: "m1",
		reply: vi.fn(async () => undefined),
		react: vi.fn(async (e: string) => void reacted.push(e)),
		reactions: { cache: new Map([["⏱️", { users: { remove: vi.fn(async () => undefined) } }]]) },
		channel: { send: vi.fn(async (c: unknown) => void sent.push(c)), sendTyping: vi.fn(async () => undefined) },
	};
	return { sent, reacted, msg };
}

describe("replyOne (integração com stubs)", () => {
	it("responde texto + drena anexo do outbox e apaga", async () => {
		const base = await mkdtemp(join(tmpdir(), "gw-"));
		const dir = join(base, "c1");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "v.mp4"), "dados");
		try {
			const gw = new DiscordGateway(
				settings,
				async () => "ok",
				undefined,
				undefined,
				() => undefined,
				undefined,
				base,
			);
			(gw as unknown as { botUserId: string }).botUserId = "bot";
			const { sent, reacted, msg } = stubIncoming();
			await (gw as unknown as { replyOne: (i: unknown) => Promise<void> }).replyOne({
				message: msg,
				channelId: "c1",
				authorId: "u1",
				text: "baixa isso",
			});
			expect(msg.reply).toHaveBeenCalledWith("ok");
			expect(reacted).toEqual(["⏱️", "✅"]);
			const fileSend = sent.find((c) => typeof c === "object" && c !== null && "files" in c) as
				| { files: { attachment: string }[] }
				| undefined;
			expect(fileSend?.files[0]?.attachment).toContain("v.mp4");
			const { stat } = await import("node:fs/promises");
			await expect(stat(join(dir, "v.mp4"))).rejects.toThrow(); // apagou
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("erro vira ❌ + mensagem de falha", async () => {
		const gw = new DiscordGateway(
			settings,
			async () => Promise.reject(new Error("quebrou")),
			undefined,
			undefined,
			() => undefined,
		);
		(gw as unknown as { botUserId: string }).botUserId = "bot";
		const { reacted, msg } = stubIncoming();
		await (gw as unknown as { replyOne: (i: unknown) => Promise<void> }).replyOne({
			message: msg,
			channelId: "c1",
			authorId: "u1",
			text: "oi",
		});
		expect(reacted).toEqual(["⏱️", "❌"]);
		const calls = (msg.reply as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
		expect(calls).toHaveLength(1);
		expect(calls.some((c) => c.includes("falhei aqui"))).toBe(true);
	});
});
