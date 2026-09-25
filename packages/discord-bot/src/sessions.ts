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
import { excludeToolsFor, type Role } from "./roles.ts";

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
				excludeTools: excludeToolsFor(role),
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

export class ChannelSessions {
	private readonly entries = new Map<string, Entry>();
	private readonly idleMs: number;

	private readonly factory: SessionFactory;

	constructor(factory: SessionFactory, idleMs = 30 * 60 * 1000) {
		this.factory = factory;
		this.idleMs = idleMs;
	}

	/** Get (creating if needed) the session for a channel+role. */
	async get(channelId: string, role: Role): Promise<AgentSession> {
		this.sweep();
		const existing = this.entries.get(channelId);
		if (existing) {
			if (existing.role !== role) {
				// Role changed (config edit): recreate so the tool allowlist applies.
				this.factory.dispose(existing.session);
				this.entries.delete(channelId);
			} else {
				existing.lastUsed = Date.now();
				return existing.session;
			}
		}
		const session = await this.factory.create(channelId, role);
		this.entries.set(channelId, { session, role, lastUsed: Date.now() });
		return session;
	}

	/** Ask the channel's session and return the final assistant text. */
	async ask(channelId: string, role: Role, message: string): Promise<string> {
		const session = await this.get(channelId, role);
		await session.prompt(message);
		if (typeof session.waitForIdle === "function") await session.waitForIdle();
		if (typeof session.getLastAssistantText === "function") {
			return session.getLastAssistantText() ?? "";
		}
		return "";
	}

	/** Channel ids with a live session (for the web session list). */
	keys(): string[] {
		this.sweep();
		return [...this.entries.keys()];
	}

	/** Drop a session (web session delete). Returns false when absent. */
	remove(channelId: string): boolean {
		const e = this.entries.get(channelId);
		if (!e) return false;
		this.factory.dispose(e.session);
		this.entries.delete(channelId);
		return true;
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
