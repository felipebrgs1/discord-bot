/**
 * Extração de aprendizado (port do extrator do Go, sem embeddings):
 * um lote de mensagens vira {summary, memories[], episodes[]} via o
 * próprio endpoint de chat (response_format json_object).
 */

export interface MsgInput {
	rowid: number;
	author_id: string;
	author_name: string;
	body: string;
	created_at: string;
}

export type MemoryKind = "fact" | "preference" | "lesson" | "culture";
export type MemoryScope = "group" | "user";

export interface ExtractedMemory {
	key: string;
	kind: MemoryKind;
	scope: MemoryScope;
	person_id: string;
	content: string;
}

export interface ExtractedEpisode {
	key: string;
	title: string;
	summary: string;
}

export interface Extraction {
	summary: string;
	memories: ExtractedMemory[];
	episodes: ExtractedEpisode[];
}

const KINDS: MemoryKind[] = ["fact", "preference", "lesson", "culture"];
const SCOPES: MemoryScope[] = ["group", "user"];

function slug(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

/** Validação na borda (regras do Go, sem a parte vetorial). */
export function validateExtraction(raw: unknown, batch: MsgInput[]): Extraction {
	const v = (raw ?? {}) as Record<string, unknown>;
	const summary = typeof v["summary"] === "string" ? v["summary"].slice(0, 2000) : "";
	const authors = new Set(batch.map((m) => m.author_id));
	const memories: ExtractedMemory[] = [];
	if (Array.isArray(v["memories"])) {
		for (const c of v["memories"] as Record<string, unknown>[]) {
			const kind = c["kind"];
			const scope = c["scope"];
			if (!KINDS.includes(kind as MemoryKind)) continue;
			if (!SCOPES.includes(scope as MemoryScope)) continue;
			const person = typeof c["person_id"] === "string" ? c["person_id"] : "";
			// Memória individual só da própria pessoa, que precisa estar no lote.
			if (scope === "user" && (!person || !authors.has(person))) continue;
			const content = typeof c["content"] === "string" ? c["content"].trim() : "";
			if (!content || content.length > 1000) continue;
			const key = typeof c["key"] === "string" && c["key"].trim() ? slug(String(c["key"])) : slug(content);
			if (!key) continue;
			memories.push({
				key,
				kind: kind as MemoryKind,
				scope: scope as MemoryScope,
				person_id: scope === "user" ? person : "",
				content,
			});
		}
	}
	const episodes: ExtractedEpisode[] = [];
	if (Array.isArray(v["episodes"])) {
		for (const e of v["episodes"] as Record<string, unknown>[]) {
			const title = typeof e["title"] === "string" ? e["title"].trim().slice(0, 200) : "";
			const summary = typeof e["summary"] === "string" ? e["summary"].trim().slice(0, 1000) : "";
			if (!title || !summary) continue;
			const key = typeof e["key"] === "string" && e["key"].trim() ? slug(String(e["key"])) : slug(title);
			if (!key) continue;
			episodes.push({ key, title, summary });
		}
	}
	return { summary, memories, episodes };
}

export function extractionPrompt(channelId: string, batch: MsgInput[]): string {
	const lines = batch.map(
		(m) =>
			`[${m.created_at.slice(0, 16).replace("T", " ")}] ${m.author_name} (${m.author_id}): ${m.body.slice(0, 800)}`,
	);
	return `Você extrai aprendizado durável de conversa de Discord (canal ${channelId}).
Responda SÓ com JSON: {"summary": "resumo do lote em 2-4 linhas", "memories": [...], "episodes": [...]}.
Cada memory: {"key": "slug-estavel", "kind": "fact|preference|lesson|culture", "scope": "group|user", "person_id": "id ou vazio", "content": "frase autocontida"}.
Regras:
- Só o que é DURÁVEL (fato, gosto, correção ao bot, piada interna com significado). Conversa casual = nada.
- scope user SOMENTE para declaração da própria pessoa (person_id = autor dela); resto é group.
- lesson só de correção concreta ao que o bot fez. culture sempre group.
- Reutilize a mesma key quando o fato atualizar (ex. jogo-favorito).
- episodes: histórias do grupo com começo/meio (título + resumo). Vazio se não houver.
Mensagens:
${lines.join("\n")}`;
}

export type LlmCaller = (prompt: string) => Promise<unknown>;

/** Chamada direta ao endpoint de chat (OpenAI-compatible, json_object). */
export function apiLlmCaller(baseUrl: string, apiKey: string, model: string): LlmCaller {
	return async (prompt: string) => {
		const { randomUUID } = await import("node:crypto");
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				// O endpoint zen (opencode-go) exige sessão p/ rotear; sem ela dá 400.
				"x-opencode-session": randomUUID(),
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				response_format: { type: "json_object" },
			}),
			signal: AbortSignal.timeout(80_000),
		});
		if (!res.ok) throw new Error(`extração HTTP ${res.status}`);
		const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		const content = data.choices?.[0]?.message?.content ?? "{}";
		return JSON.parse(content) as unknown;
	};
}

export async function extractBatch(caller: LlmCaller, channelId: string, batch: MsgInput[]): Promise<Extraction> {
	const raw = await caller(extractionPrompt(channelId, batch));
	return validateExtraction(raw, batch);
}
