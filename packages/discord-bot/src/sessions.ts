/**
 * One pi AgentSession per Discord channel (Fase 1).
 *
 * The factory is injectable so the gateway stays unit-testable and the
 * composition root owns auth/model selection. Sessions are created lazily
 * and disposed when idle past `idleMs` (swept on every access).
 */

import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type StatsTotals, statsOf, type TurnReport } from "./metrics.ts";
import { excludedToolsFor, type Role } from "./roles.ts";

export interface SessionFactory {
	create(channelId: string, role: Role): Promise<AgentSession>;
	dispose(session: AgentSession): void;
}

/** Production factory backed by the pi SDK (needs `pi auth` or a ModelRuntime). */
export function piSessionFactory(cwd: string): SessionFactory {
	return {
		async create(_channelId: string, role: Role): Promise<AgentSession> {
			const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
			await loader.reload();
			const { session } = await createAgentSession({
				cwd,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(),
				excludeTools: excludedToolsFor(role),
			});
			return session;
		},
		dispose(session: AgentSession): void {
			try {
				session.dispose();
			} catch {
				/* already gone */
			}
		},
	};
}

interface Entry {
	session: AgentSession;
	role: Role;
	lastUsed: number;
}

export interface AskOpts {
	source?: string;
	model?: string;
	provider?: string;
	onTurn?: (report: TurnReport) => void;
}

export class ChannelSessions {
	private readonly entries = new Map<string, Entry>();
	private readonly idleMs: number;

	private readonly factory: SessionFactory;

	constructor(factory: SessionFactory, idleMs = 30 * 60 * 1000) {
		this.factory = factory;
		this.idleMs = idleMs;
	}

	private key(channelId: string, role: Role): string {
		return `${channelId}::${role}`;
	}

	/**
	 * Get (creating if needed) the session for a channel+role.
	 * Keyed by BOTH: a user never reuses a session created with admin
	 * tools, and alternating roles don't thrash each other's context.
	 */
	async get(channelId: string, role: Role): Promise<AgentSession> {
		this.sweep();
		const existing = this.entries.get(this.key(channelId, role));
		if (existing) {
			// Keyed by channel+role (see key()): entry here always matches.
			existing.lastUsed = Date.now();
			return existing.session;
		}
		const session = await this.factory.create(channelId, role);
		this.entries.set(this.key(channelId, role), { session, role, lastUsed: Date.now() });
		return session;
	}

	/** Ask the channel's session and return the final assistant text. */
	async ask(channelId: string, role: Role, message: string, opts?: AskOpts): Promise<string> {
		const session = await this.get(channelId, role);
		const before = statsOf(session);
		const started = Date.now();
		try {
			await session.prompt(message);
			if (typeof session.waitForIdle === "function") await session.waitForIdle();
			const text = typeof session.getLastAssistantText === "function" ? (session.getLastAssistantText() ?? "") : "";
			opts?.onTurn?.(this.turnReport(session, before, statsOf(session), started, "success", opts));
			return text;
		} catch (err) {
			opts?.onTurn?.(this.turnReport(session, before, statsOf(session), started, "error", opts));
			throw err;
		}
	}

	private turnReport(
		session: AgentSession,
		before: StatsTotals | null,
		after: StatsTotals | null,
		started: number,
		status: "success" | "error",
		opts?: AskOpts,
	): TurnReport {
		let actualId = "";
		let actualProvider = "";
		try {
			const m = (session as unknown as { model?: { id?: unknown; provider?: unknown } }).model;
			if (m && typeof m === "object") {
				if (typeof m.id === "string") actualId = m.id;
				if (typeof m.provider === "string") actualProvider = m.provider;
			}
		} catch {
			/* mantém fallback do config */
		}
		return {
			operation: "chat",
			model: actualId || opts?.model || "",
			provider: actualProvider || opts?.provider || "",
			source: opts?.source ?? "discord",
			status,
			latency_ms: Date.now() - started,
			input_tokens: before && after ? Math.max(0, after.input - before.input) : null,
			output_tokens: before && after ? Math.max(0, after.output - before.output) : null,
			cost: before && after ? Math.max(0, after.cost - before.cost) : null,
		};
	}

	/** Channel ids with a live session (for the web session list). */
	keys(): string[] {
		this.sweep();
		const out = new Set<string>();
		for (const k of this.entries.keys()) out.add(k.split("::")[0] as string);
		return [...out];
	}

	/** Drop all sessions of a channel (web session delete). */
	remove(channelId: string): boolean {
		let dropped = false;
		for (const k of [...this.entries.keys()]) {
			if (k === channelId || k.startsWith(`${channelId}::`)) {
				const e = this.entries.get(k);
				if (e) this.factory.dispose(e.session);
				this.entries.delete(k);
				dropped = true;
			}
		}
		return dropped;
	}

	size(): number {
		return this.entries.size;
	}

	dispose(): void {
		for (const e of this.entries.values()) this.factory.dispose(e.session);
		this.entries.clear();
	}

	private sweep(): void {
		const now = Date.now();
		for (const [id, e] of this.entries) {
			if (now - e.lastUsed > this.idleMs) {
				this.factory.dispose(e.session);
				this.entries.delete(id);
			}
		}
	}
}
