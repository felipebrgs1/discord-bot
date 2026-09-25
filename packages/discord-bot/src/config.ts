/**
 * Config backed by SQLite (Fase 0) — replaces config.yaml.
 *
 * - Every key has a default in code: a fresh database just works.
 * - Secrets (tokens, API keys) are NEVER stored here; see `secret()`.
 * - Hot reload: poll `updatedAt()` or call `subscribe()` for change events.
 */

import type { DatabaseSync } from "node:sqlite";

export interface DiscordConfig {
	guild_id: string;
	channel_ids: string[];
	admin_ids: string[];
	moderator_ids: string[];
}

export interface ChatConfig {
	base_url: string;
	model: string;
	reply_max_tokens: number;
}

export interface BotConfig {
	reply_cooldown_ms: number;
	context_max_bytes: number;
	backfill_window_min: number;
	personality: string;
}

export interface MemoryConfig {
	interval_ms: number;
	batch_size: number;
	context_max_tokens: number;
	shared_channel_ids: string[];
}

export interface JudgeConfig {
	enabled: boolean;
	threshold: number;
	timeout_ms: number;
}

export interface DashboardConfig {
	web_user_id: string;
}

export interface BotSettings {
	discord: DiscordConfig;
	chat: ChatConfig;
	bot: BotConfig;
	memory: MemoryConfig;
	judge: JudgeConfig;
	dashboard: DashboardConfig;
}

export const DEFAULTS: BotSettings = {
	discord: { guild_id: "", channel_ids: [], admin_ids: [], moderator_ids: [] },
	chat: {
		base_url: "https://openrouter.ai/api/v1",
		model: "",
		reply_max_tokens: 1024,
	},
	bot: {
		reply_cooldown_ms: 4000,
		context_max_bytes: 64000,
		backfill_window_min: 120,
		personality: "Você é um amigo do servidor: direto, bem-humorado, fala PT-BR.",
	},
	memory: {
		interval_ms: 90_000,
		batch_size: 50,
		context_max_tokens: 3000,
		shared_channel_ids: [],
	},
	judge: { enabled: false, threshold: 0.3, timeout_ms: 4000 },
	dashboard: { web_user_id: "" },
};

/** Read a secret from the environment only. Never falls back to the DB. */
export function secret(name: string): string {
	return process.env[name] ?? "";
}

function getPath(settings: BotSettings, key: string): unknown {
	const parts = key.split(".");
	let cur: unknown = settings;
	for (const p of parts) {
		if (typeof cur !== "object" || cur === null) return undefined;
		cur = (cur as Record<string, unknown>)[p];
	}
	return cur;
}

function setPath(settings: BotSettings, key: string, value: unknown): void {
	const parts = key.split(".");
	let cur = settings as unknown as Record<string, unknown>;
	for (let i = 0; i < parts.length - 1; i++) {
		const p = parts[i] as string;
		if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
		cur = cur[p] as Record<string, unknown>;
	}
	cur[parts[parts.length - 1] as string] = value;
}

export class ConfigStore {
	private readonly db: DatabaseSync;
	private cache: BotSettings;
	private cacheAt = 0;
	private readonly ttlMs: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly listeners = new Set<(key: string) => void>();
	private lastSeen = new Map<string, string>();

	constructor(db: DatabaseSync, ttlMs = 2000) {
		this.db = db;
		this.ttlMs = ttlMs;
		this.cache = this.load();
	}

	/** Full settings snapshot (cached for ttlMs). */
	all(): BotSettings {
		if (Date.now() - this.cacheAt > this.ttlMs) this.cache = this.load();
		return this.cache;
	}

	/** Single dotted key, e.g. "chat.model". */
	get<K extends string>(key: K): unknown {
		return getPath(this.all(), key);
	}

	/** Persist a dotted key; notifies subscribers. */
	set(key: string, value: unknown): void {
		this.db
			.prepare(
				`INSERT INTO config (key, value, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE
         SET value = excluded.value, updated_at = excluded.updated_at;`,
			)
			.run(key, JSON.stringify(value));
		this.cache = this.load();
		this.emit(key);
	}

	/** Last update timestamp of a key ('' when never set). */
	updatedAt(key: string): string {
		const row = this.db.prepare("SELECT updated_at AS u FROM config WHERE key = ?;").get(key) as
			| { u: string }
			| undefined;
		return row?.u ?? "";
	}

	/** Subscribe to config changes (polled every ttlMs). Returns unsubscribe. */
	subscribe(listener: (key: string) => void): () => void {
		this.listeners.add(listener);
		if (!this.timer) {
			this.timer = setInterval(() => this.poll(), this.ttlMs);
			this.timer.unref?.();
		}
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0 && this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
		};
	}

	/** Stop the polling timer. */
	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.listeners.clear();
	}

	private emit(key: string): void {
		for (const l of this.listeners) {
			try {
				l(key);
			} catch {
				/* listener errors must not break config writes */
			}
		}
	}

	private poll(): void {
		let rows: { key: string; updated_at: string }[];
		try {
			rows = this.db.prepare("SELECT key, updated_at AS updated_at FROM config;").all() as {
				key: string;
				updated_at: string;
			}[];
		} catch {
			return;
		}
		const seen = new Set<string>();
		for (const r of rows) {
			seen.add(r.key);
			if (this.lastSeen.get(r.key) !== r.updated_at) {
				this.lastSeen.set(r.key, r.updated_at);
				this.cache = this.load();
				this.emit(r.key);
			}
		}
		for (const k of [...this.lastSeen.keys()]) {
			if (!seen.has(k)) this.lastSeen.delete(k);
		}
	}

	private load(): BotSettings {
		this.cacheAt = Date.now();
		// Deep clone defaults, then overlay stored sections.
		const merged = JSON.parse(JSON.stringify(DEFAULTS)) as BotSettings;
		let rows: { key: string; value: string }[];
		try {
			rows = this.db.prepare("SELECT key, value FROM config;").all() as {
				key: string;
				value: string;
			}[];
		} catch {
			return merged;
		}
		// Whole-section keys ("discord") replace the section; dotted keys
		// ("chat.model") patch a single field. Sections apply FIRST so
		// dotted keys always win (most recent, most specific write).
		const dotted: [string, unknown][] = [];
		for (const r of rows) {
			let value: unknown;
			try {
				value = JSON.parse(r.value);
			} catch {
				continue;
			}
			if (r.key.includes(".")) {
				dotted.push([r.key, value]);
				continue;
			}
			if (value !== null && typeof value === "object" && r.key in merged) {
				Object.assign((merged as unknown as Record<string, unknown>)[r.key] as object, value);
			}
		}
		for (const [key, value] of dotted) setPath(merged, key, value);
		// Seed lastSeen so subscribe() only fires on real changes.
		try {
			const stamps = this.db.prepare("SELECT key, updated_at AS updated_at FROM config;").all() as {
				key: string;
				updated_at: string;
			}[];
			for (const s of stamps) this.lastSeen.set(s.key, s.updated_at);
		} catch {
			/* table may not exist yet in bare :memory: usage */
		}
		return merged;
	}
}
