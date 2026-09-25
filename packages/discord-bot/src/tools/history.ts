/**
 * search_history: "lembra quando..." sobre o FTS de messages (+ contexto).
 * Episódios entram quando a Fase 3 existir; por enquanto, trechos puros.
 */

import type { SQLInputValue } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type ToolCtx, textResult } from "./index.ts";

interface MsgRow {
	rowid: number;
	author_name: string;
	body: string;
	created_at: string;
}

export function searchHistoryTool(ctx: ToolCtx): ToolDefinition {
	return defineTool({
		name: "search_history",
		label: "Buscar histórico",
		description:
			'Procura no histórico de conversas do canal por texto, período e pessoas — a memória do que foi dito, incluindo o que não virou memória durável. Retorna trechos com autor e data mais o que estava em volta. Use para "lembra quando...", links, piadas ou fatos antigos.',
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Texto (FTS em português)" })),
			days: Type.Optional(Type.Number({ description: "Só dos últimos N dias" })),
			author_id: Type.Optional(Type.String({ description: "Só mensagens deste autor (id do Discord)" })),
			limit: Type.Optional(Type.Number({ description: "Máximo de trechos (padrão 5, máx 10)" })),
		}),
		async execute(_id, params) {
			const limit = Math.min(Math.max(params.limit ?? 5, 1), 10);
			const clauses: string[] = ["channel_id = ?"];
			const args: unknown[] = [ctx.channelId];
			if (params.days && params.days > 0) {
				clauses.push(`created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`);
				args.push(`-${Math.floor(params.days)} days`);
			}
			if (params.author_id) {
				clauses.push("author_id = ?");
				args.push(params.author_id);
			}
			let hits: MsgRow[];
			const q = sanitizeFts((params.query ?? "").trim());
			try {
				if (q) {
					hits = ctx.db
						.prepare(
							`SELECT m.rowid, m.author_name, m.body, m.created_at FROM messages_fts f
               JOIN messages m ON m.rowid = f.rowid
               WHERE m.channel_id = ? AND messages_fts MATCH ?
               ${params.days && params.days > 0 ? "AND m.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)" : ""}
               ${params.author_id ? "AND m.author_id = ?" : ""}
               ORDER BY rank LIMIT ?;`,
						)
						.all(...(ftsArgs(ctx.channelId, q, params) as SQLInputValue[])) as unknown as MsgRow[];
				} else {
					hits = ctx.db
						.prepare(
							`SELECT rowid, author_name, body, created_at FROM messages WHERE ${clauses.join(" AND ")} ORDER BY rowid DESC LIMIT ?;`,
						)
						.all(...([...args, limit] as SQLInputValue[])) as unknown as MsgRow[];
					hits.reverse();
				}
			} catch (err) {
				return textResult(`erro na busca: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (hits.length === 0) return textResult("(nada encontrado no histórico)");
			const out: string[] = [];
			for (const h of hits) {
				const around = ctx.db
					.prepare(
						"SELECT author_name, body FROM messages WHERE channel_id = ? AND rowid BETWEEN ? AND ? AND rowid <> ? ORDER BY rowid LIMIT 4;",
					)
					.all(...([ctx.channelId, h.rowid - 2, h.rowid + 2, h.rowid] as SQLInputValue[])) as {
					author_name: string;
					body: string;
				}[];
				const ctxLines = around.map((a) => `   │ ${a.author_name}: ${a.body.slice(0, 200)}`).join("\n");
				out.push(
					`• ${h.author_name} (${h.created_at.slice(0, 16).replace("T", " ")}): ${h.body.slice(0, 500)}${ctxLines ? `\n${ctxLines}` : ""}`,
				);
			}
			return textResult(out.join("\n\n"));
		},
	});
}

/** Query do usuário vira AND de termos com aspas — sintaxe FTS inválida não quebra. */
function sanitizeFts(q: string): string {
	const terms = q
		.split(/\s+/)
		.map((t) => t.replace(/"/g, '""'))
		.filter(Boolean)
		.map((t) => `"${t}"`);
	return terms.join(" ");
}

function ftsArgs(channelId: string, q: string, params: { days?: number; author_id?: string }): unknown[] {
	const args: unknown[] = [channelId, q];
	if (params.days && params.days > 0) args.push(`-${Math.floor(params.days)} days`);
	if (params.author_id) args.push(params.author_id);
	return args;
}
