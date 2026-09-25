/**
 * Familiaridade: preferências e lições que entram em TODA resposta,
 * mesmo sem busca profunda (port do social_context do Go).
 */

import type { DatabaseSync } from "node:sqlite";

export interface FamiliarOptions {
	personId: string;
	channelId: string;
	maxChars?: number;
}

export function familiarityBlock(db: DatabaseSync, opts: FamiliarOptions): string {
	const max = opts.personId ? (opts.maxChars ?? 1500) : 1500;
	const lines: string[] = [];
	try {
		const mine = db
			.prepare(
				`SELECT kind, content FROM memories
         WHERE status='active' AND scope='user' AND person_id = ?
           AND (kind='preference' OR kind='lesson')
         ORDER BY rowid DESC LIMIT 10;`,
			)
			.all(opts.personId) as { kind: string; content: string }[];
		for (const m of mine) lines.push(`- [sua] (${m.kind}) ${m.content}`);
		const group = db
			.prepare(
				`SELECT kind, content FROM memories
         WHERE status='active' AND scope='group' AND channel_id IN (?, '')
           AND (kind='preference' OR kind='lesson' OR kind='culture')
         ORDER BY rowid DESC LIMIT 10;`,
			)
			.all(opts.channelId) as { kind: string; content: string }[];
		for (const m of group) lines.push(`- [grupo] (${m.kind}) ${m.content}`);
	} catch {
		return "";
	}
	if (lines.length === 0) return "";
	let text = `[memória do grupo e suas preferências]\n${lines.join("\n")}`;
	if (text.length > max) text = text.slice(0, max) + "…";
	return text;
}
