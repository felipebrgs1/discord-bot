/**
 * memory_search: busca profunda nas memórias duráveis via FTS5.
 * Escopo = canal da conversa; filtro de status sempre ativo.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type ToolCtx, textResult } from "./index.ts";

interface MemRow {
	key: string;
	kind: string;
	scope: string;
	person_id: string;
	content: string;
	updated_at: string;
}

export function memorySearchTool(ctx: ToolCtx): ToolDefinition {
	return defineTool({
		name: "memory_search",
		label: "Buscar memórias",
		description:
			"Busca nas memórias duráveis do grupo e suas (fatos, preferências, lições, piadas internas). Use quando a resposta precisar de algo aprendido antes que não está na conversa atual.",
		parameters: Type.Object({
			query: Type.String({ description: "O que procurar" }),
			limit: Type.Optional(Type.Number({ description: "Máximo (padrão 5, máx 8)" })),
		}),
		async execute(_id, params) {
			const q = ((params.query ?? "") as string).trim();
			if (!q) return textResult("erro: query vazia");
			const limit = Math.min(Math.max((params.limit as number) ?? 5, 1), 8);
			const match = q
				.split(/\s+/)
				.map((t) => `"${t.replace(/"/g, '""')}"`)
				.join(" ");
			try {
				const rows = ctx.db
					.prepare(
						`SELECT m.key, m.kind, m.scope, m.person_id, m.content, m.updated_at
             FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
             WHERE m.status = 'active' AND m.channel_id IN (?, '')
               AND memories_fts MATCH ?
             ORDER BY rank LIMIT ?;`,
					)
					.all(ctx.channelId, match, limit) as unknown as MemRow[];
				if (rows.length === 0) return textResult("(nada nas memórias sobre isso)");
				const out = rows.map(
					(r) => `• [${r.scope}${r.person_id ? `/${r.person_id}` : ""}] (${r.kind}) ${r.content} — chave ${r.key}`,
				);
				return textResult(out.join("\n"));
			} catch (err) {
				return textResult(`erro na busca: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}
