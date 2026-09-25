/**
 * Worker de consolidação: a cada intervalo, por canal com mensagens novas,
 * extrai resumo + memórias + episódios e grava atomicamente com o cursor.
 * Sem embeddings, sem rerank: FTS5 indexa na escrita (triggers).
 */

import type { DatabaseSync } from "node:sqlite";
import { extractBatch, type LlmCaller, type MsgInput } from "./extract.ts";

export interface ConsolidateOpts {
	channels: string[];
	batchSize?: number;
	minNew?: number;
	onLog?: (msg: string, attrs?: Record<string, unknown>) => void;
}

interface CursorRow {
	last_rowid: number;
}

export function lastRowid(db: DatabaseSync, channelId: string): number {
	const row = db.prepare("SELECT last_rowid FROM memory_cursors WHERE channel_id = ?;").get(channelId) as
		| CursorRow
		| undefined;
	return row?.last_rowid ?? 0;
}

function readBatch(db: DatabaseSync, channelId: string, batchSize: number): MsgInput[] {
	return db
		.prepare(
			"SELECT rowid, author_id, author_name, body, created_at FROM messages WHERE channel_id = ? AND rowid > ? ORDER BY rowid LIMIT ?;",
		)
		.all(channelId, lastRowid(db, channelId), batchSize) as unknown as MsgInput[];
}

export async function consolidateChannel(
	db: DatabaseSync,
	caller: LlmCaller,
	channelId: string,
	opts?: { batchSize?: number; minNew?: number; onLog?: ConsolidateOpts["onLog"] },
): Promise<{ consolidated: boolean; memories: number }> {
	const batchSize = opts?.batchSize ?? 10;
	const minNew = opts?.minNew ?? 3;
	const batch = readBatch(db, channelId, batchSize);
	if (batch.length < minNew) return { consolidated: false, memories: 0 };
	const last = batch[batch.length - 1]?.rowid ?? 0;

	let extraction;
	try {
		extraction = await extractBatch(caller, channelId, batch);
	} catch (err) {
		opts?.onLog?.("consolidação falhou (extração)", {
			channel: channelId,
			error: err instanceof Error ? err.message : String(err),
		});
		return { consolidated: false, memories: 0 };
	}

	db.exec("BEGIN;");
	try {
		for (const mem of extraction.memories) {
			db.prepare(
				`INSERT INTO memories (key, kind, scope, person_id, channel_id, content, status)
         VALUES (?,?,?,?,?,?,'active')
         ON CONFLICT(key, scope, person_id, channel_id) DO UPDATE
         SET content = excluded.content, kind = excluded.kind,
             status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');`,
			).run(mem.key, mem.kind, mem.scope, mem.person_id, channelId, mem.content);
			db.prepare(
				"INSERT INTO memory_versions (memory_key, scope, person_id, channel_id, content, reason) VALUES (?,?,?,?,?,?);",
			).run(mem.key, mem.scope, mem.person_id, channelId, mem.content, "consolidação");
		}
		for (const ep of extraction.episodes) {
			db.prepare(
				`INSERT INTO episodes (key, title, summary, updated_at)
         VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE
         SET title = excluded.title, summary = excluded.summary,
             updated_at = excluded.updated_at;`,
			).run(ep.key, ep.title, ep.summary);
		}
		db.prepare(
			"INSERT INTO memory_cursors (channel_id, last_rowid) VALUES (?, ?) ON CONFLICT(channel_id) DO UPDATE SET last_rowid = excluded.last_rowid;",
		).run(channelId, last);
		db.exec("COMMIT;");
	} catch (err) {
		try {
			db.exec("ROLLBACK;");
		} catch {
			/* ignore */
		}
		throw err;
	}
	opts?.onLog?.("memory_consolidated", { channel: channelId, memories: extraction.memories.length });
	return { consolidated: true, memories: extraction.memories.length };
}

export async function consolidateAll(
	db: DatabaseSync,
	caller: LlmCaller,
	opts: ConsolidateOpts,
): Promise<{ channels: number; memories: number }> {
	let channels = 0;
	let memories = 0;
	for (const ch of opts.channels) {
		try {
			const r = await consolidateChannel(db, caller, ch, opts);
			if (r.consolidated) {
				channels += 1;
				memories += r.memories;
			}
		} catch (err) {
			opts.onLog?.("consolidação falhou (gravação)", {
				channel: ch,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return { channels, memories };
}

export function startConsolidation(
	db: DatabaseSync,
	caller: LlmCaller,
	opts: ConsolidateOpts & { intervalMs: number },
): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const tick = async (): Promise<void> => {
		if (stopped) return;
		try {
			await consolidateAll(db, caller, opts);
		} catch {
			/* próximo tick tenta de novo */
		} finally {
			if (!stopped) {
				timer = setTimeout(() => void tick(), opts.intervalMs);
				timer.unref?.();
			}
		}
	};
	timer = setTimeout(() => void tick(), opts.intervalMs);
	timer.unref?.();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	};
}
