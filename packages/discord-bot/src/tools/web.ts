/**
 * web_search + web_fetch (port de internal/agent/web.go): sem chave.
 * Google News RSS (pt-BR) → Wikipedia → DuckDuckGo Instant.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { textResult } from "./index.ts";
import { fetchJson, fetchText, guardSSRF, htmlToText } from "./net.ts";

function splitNewsTitle(t: string): [string, string] {
	const i = t.lastIndexOf(" - ");
	if (i > 0 && i < t.length - 3) return [t.slice(0, i).trim(), t.slice(i + 3).trim()];
	return [t.trim(), "?"];
}

async function searchNews(query: string, max: number): Promise<string> {
	const u = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=pt-BR&gl=BR&ceid=BR%3Apt-419`;
	const { status, text } = await fetchText(u, 1 << 20);
	if (status !== 200) return "";
	const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, max);
	if (items.length === 0) return "";
	const out = ["Notícias recentes:"];
	items.forEach((m, n) => {
		const part = m[1] as string;
		const tag = (t: string): string => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(part)?.[1]?.trim() ?? "";
		const [title, source] = splitNewsTitle(tag("title").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1"));
		let date = tag("pubDate");
		const parsed = Date.parse(date);
		if (!Number.isNaN(parsed)) {
			const d = new Date(parsed);
			date = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
		}
		out.push(`${n + 1}. ${title}\n   Fonte: ${source} | ${date}\n   Link: ${tag("link")}`);
	});
	return out.join("\n");
}

async function searchWiki(query: string): Promise<string> {
	const found = await fetchJson<{
		query?: { search?: { title?: string }[] };
	}>(
		`https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json`,
	);
	const title = found.query?.search?.[0]?.title;
	if (!title) return "";
	const page = await fetchJson<{
		title?: string;
		extract?: string;
		content_urls?: { desktop?: { page?: string } };
	}>(`https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
	if (!page.extract) return "";
	return `Wikipedia — ${page.title}: ${page.extract}\nLink: ${page.content_urls?.desktop?.page ?? ""}\n`;
}

async function searchInstant(query: string): Promise<string> {
	const r = await fetchJson<{ AbstractText?: string; AbstractURL?: string; Answer?: string }>(
		`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&kl=br-pt`,
	);
	const out: string[] = [];
	if (r.AbstractText) out.push(`Resumo: ${r.AbstractText}\nFonte: ${r.AbstractURL ?? ""}`);
	if (r.Answer) out.push(`Resposta direta: ${r.Answer}`);
	return out.join("\n");
}

export function webSearchTool(): ToolDefinition {
	return defineTool({
		name: "web_search",
		label: "Pesquisa web",
		description:
			"Pesquisa notícias recentes e conhecimento geral na web, sem chave. Use para fatos atuais (jogos, placares, notícias). Retorna títulos, fontes, datas e links.",
		parameters: Type.Object({
			query: Type.String({ description: "O que pesquisar" }),
			max_results: Type.Optional(Type.Number({ description: "Máximo de resultados (1-10, padrão 5)" })),
		}),
		async execute(_id, params) {
			const query = (params.query ?? "").trim();
			if (!query) return textResult("erro: query vazia");
			const max = Math.min(Math.max(params.max_results ?? 5, 1), 10);
			try {
				let out = await searchNews(query, max);
				if (!out.trim()) {
					const wiki = await searchWiki(query).catch(() => "");
					const instant = await searchInstant(query).catch(() => "");
					out = [wiki, instant].filter((s) => s.trim()).join("\n");
				}
				return textResult(out.trim() || "(sem resultados para essa busca)");
			} catch (err) {
				return textResult(`erro na pesquisa: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}

export function webFetchTool(): ToolDefinition {
	return defineTool({
		name: "web_fetch",
		label: "Ler página",
		description:
			"Baixa uma página pública e devolve o texto legível. Use para ler a matéria completa após web_search.",
		parameters: Type.Object({
			url: Type.String({ description: "URL http/https pública" }),
			max_bytes: Type.Optional(Type.Number({ description: "Teto do texto (padrão 8000, máx 20000)" })),
		}),
		async execute(_id, params) {
			const raw = (params.url ?? "").trim();
			let u: URL;
			try {
				u = new URL(raw);
			} catch {
				return textResult("erro: URL inválida (use http/https)");
			}
			if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.host) {
				return textResult("erro: URL inválida (use http/https)");
			}
			try {
				await guardSSRF(u.host);
				const max = Math.min(Math.max(params.max_bytes ?? 8000, 1), 20000);
				const { status, text: page } = await fetchText(u.toString());
				if (status < 200 || status >= 300) {
					return textResult(`erro: HTTP ${status}`);
				}
				const { title, text } = htmlToText(page);
				if (!text.trim()) return textResult("erro: página sem texto extraível");
				const full = title ? `Título: ${title}\n\n${text}` : text;
				return textResult(full.slice(0, max));
			} catch (err) {
				return textResult(`erro: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}
