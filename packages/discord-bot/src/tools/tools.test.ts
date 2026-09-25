import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../db.ts";
import { discard, outboxDirFor, pendingAttachments } from "../outbox.ts";
import { LogBuffer } from "../weblog.ts";
import { searchHistoryTool } from "./history.ts";
import { type ToolCtx, toolsFor } from "./index.ts";
import { downloadMediaTool } from "./media.ts";
import { guardSSRF, htmlToText } from "./net.ts";
import { webFetchTool, webSearchTool } from "./web.ts";

const RSS = `<?xml version="1.0"?>
<rss><channel>
<item><title><![CDATA[Vasco vence - ge.globo]]></title><link>https://exemplo/noticia</link><pubDate>Tue, 08 Sep 2026 10:00:00 GMT</pubDate></item>
<item><title>Outro jogo - uol</title><link>https://exemplo/outra</link><pubDate>bad-date</pubDate></item>
</channel></rss>`;

const stubFetch = (routes: [RegExp, { status?: number; body: string }][]) =>
	vi.fn(async (url: unknown) => {
		const u = String(url);
		for (const [re, r] of routes) {
			if (re.test(u)) {
				return {
					ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
					status: r.status ?? 200,
					arrayBuffer: async () => new TextEncoder().encode(r.body).buffer as ArrayBuffer,
					json: async () => JSON.parse(r.body),
				};
			}
		}
		throw new Error(`rota não mockada: ${u}`);
	});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env["AGENT_ALLOW_PRIVATE"];
	delete process.env["YTDLP_BIN"];
});

function memDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	migrate(db);
	return db;
}

function ctx(channelId: string, db: DatabaseSync, outboxDir: string): ToolCtx {
	return { channelId, db, log: new LogBuffer(), outboxDir };
}

describe("web_search", () => {
	it("formata RSS com fonte e data", async () => {
		vi.stubGlobal("fetch", stubFetch([[/news\.google/, { body: RSS }]]));
		const tool = webSearchTool();
		const r = await tool.execute(
			"t",
			{ query: "vasco" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		const text = r.content[0]?.type === "text" ? r.content[0].text : "";
		expect(text).toContain("Notícias recentes:");
		expect(text).toContain("Vasco vence");
		expect(text).toContain("ge.globo");
		expect(text).toContain("08/09/2026");
		expect(text).toContain("https://exemplo/noticia");
	});

	it("recusa query vazia sem rede", async () => {
		const fetch = vi.fn(async () => {
			throw new Error("não deveria chamar rede");
		});
		vi.stubGlobal("fetch", fetch);
		const tool = webSearchTool();
		const r = await tool.execute("t", { query: "  " } as never, undefined as never, undefined as never, {} as never);
		expect(r.content[0]?.type === "text" ? r.content[0].text : "").toContain("vazia");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("cai para wiki+instant quando o RSS vem vazio", async () => {
		vi.stubGlobal(
			"fetch",
			stubFetch([
				[/news\.google/, { body: "<rss><channel></channel></rss>" }],
				[/wikipedia.*list=search/, { body: JSON.stringify({ query: { search: [{ title: "Vasco" }] } }) }],
				[
					/rest_v1\/page\/summary/,
					{
						body: JSON.stringify({
							title: "Vasco",
							extract: "Clube brasileiro",
							content_urls: { desktop: { page: "https://pt.wikipedia.org/wiki/Vasco" } },
						}),
					},
				],
				[
					/duckduckgo/,
					{ body: JSON.stringify({ AbstractText: "resumo ddg", AbstractURL: "https://ddg", Answer: "42" }) },
				],
			]),
		);
		const tool = webSearchTool();
		const r = await tool.execute(
			"t",
			{ query: "vasco" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		const text = r.content[0]?.type === "text" ? r.content[0].text : "";
		expect(text).toContain("Wikipedia — Vasco");
		expect(text).toContain("resumo ddg");
		expect(text).toContain("Resposta direta: 42");
	});
});

describe("web_fetch", () => {
	it("extrai título e texto, descarta script e linha curta", async () => {
		process.env["AGENT_ALLOW_PRIVATE"] = "1"; // pula DNS/SSRF (host fictício)
		vi.stubGlobal(
			"fetch",
			stubFetch([
				[
					/exemplo/,
					{
						body: "<html><head><title>Matéria Boa</title><script>var x=1;</script></head><body><p>Primeiro parágrafo com conteúdo suficiente para passar do corte mínimo de caracteres aqui.</p><p>oi</p></body></html>",
					},
				],
			]),
		);
		const tool = webFetchTool();
		const r = await tool.execute(
			"t",
			{ url: "https://exemplo/materia" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		const text = r.content[0]?.type === "text" ? r.content[0].text : "";
		expect(text).toContain("Título: Matéria Boa");
		expect(text).toContain("Primeiro parágrafo");
		expect(text).not.toContain("var x=1");
	});

	it("barra URL não-http sem rede", async () => {
		const tool = webFetchTool();
		const r = await tool.execute(
			"t",
			{ url: "ftp://x/y" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		expect(r.content[0]?.type === "text" ? r.content[0].text : "").toContain("inválida");
	});
});

describe("guardSSRF", () => {
	it("bloqueia localhost e metadata sem DNS", async () => {
		await expect(guardSSRF("localhost")).rejects.toThrow("bloqueado");
		await expect(guardSSRF("metadata.google.internal")).rejects.toThrow("bloqueado");
		await expect(guardSSRF("x.internal")).rejects.toThrow("bloqueado");
	});

	it("AGENT_ALLOW_PRIVATE libera", async () => {
		process.env["AGENT_ALLOW_PRIVATE"] = "1";
		await expect(guardSSRF("localhost")).resolves.toBeUndefined();
	});
});

describe("htmlToText", () => {
	it("remove script/style e filtra linha curta", () => {
		const { title, text } = htmlToText(
			"<html><head><title>T</title><style>.a{}</style></head><body>\n<p>linha longa o bastante para sobreviver ao filtro mínimo aplicado aqui</p>\n<p>curta</p>\n<script>var x=1;</script></body></html>",
		);
		expect(title).toBe("T");
		expect(text).toContain("linha longa");
		expect(text).not.toContain("var x=1");
		expect(text).not.toContain(".a{}");
		const lines = text.split("\n");
		expect(lines.every((l) => l.length > 40)).toBe(true);
	});
});

describe("download_media", () => {
	it("barra plataforma sem suporte sem baixar", async () => {
		const db = memDb();
		const tool = downloadMediaTool(ctx("c1", db, "/tmp/outbox-inexistente"));
		const r = await tool.execute(
			"t",
			{ url: "https://www.youtube.com/watch?v=abc" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		expect(r.content[0]?.type === "text" ? r.content[0].text : "").toContain("X/Twitter, TikTok");
		db.close();
	});

	it("barra URL inválida", async () => {
		const db = memDb();
		const tool = downloadMediaTool(ctx("c1", db, "/tmp/outbox-inexistente"));
		const r = await tool.execute(
			"t",
			{ url: "não-url" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		expect(r.content[0]?.type === "text" ? r.content[0].text : "").toContain("http/https");
		db.close();
	});

	it("falha honesta quando o yt-dlp quebra", async () => {
		process.env["AGENT_ALLOW_PRIVATE"] = "1"; // pula DNS/SSRF
		process.env["YTDLP_BIN"] = "/bin/false"; // falha imediata, sem rede
		const dir = await mkdtemp(join(tmpdir(), "outbox-"));
		const db = memDb();
		try {
			const tool = downloadMediaTool(ctx("c1", db, dir));
			const r = await tool.execute(
				"t",
				{ url: "https://x.com/u/status/1" } as never,
				undefined as never,
				undefined as never,
				{} as never,
			);
			expect(r.content[0]?.type === "text" ? r.content[0].text : "").toContain("erro no download");
		} finally {
			db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("search_history", () => {
	function seed(): DatabaseSync {
		const db = memDb();
		const ins = db.prepare(
			"INSERT INTO messages (channel_id, author_id, author_name, message_id, body, created_at) VALUES (?,?,?,?,?,?);",
		);
		ins.run("c1", "u1", "ana", "m1", "meu jogo favorito é Terraria", "2026-09-20T10:00:00.000Z");
		ins.run("c1", "u2", "bob", "m2", "Terraria é ótimo mesmo, joguei ontem", "2026-09-20T10:05:00.000Z");
		ins.run("c1", "u1", "ana", "m3", "alguém viu meu gato?", "2026-09-21T10:00:00.000Z");
		ins.run("c2", "u1", "ana", "m4", "Terraria no outro canal não conta", "2026-09-20T10:00:00.000Z");
		return db;
	}

	it("acha por FTS com autor, data e contexto", async () => {
		const db = seed();
		const tool = searchHistoryTool(ctx("c1", db, "/tmp/x"));
		const r = await tool.execute(
			"t",
			{ query: "Terraria" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		const text = r.content[0]?.type === "text" ? r.content[0].text : "";
		expect(text).toContain("ana");
		expect(text).toContain("meu jogo favorito é Terraria");
		expect(text).toContain("bob");
		expect(text).not.toContain("outro canal");
		db.close();
	});

	it("filtra por autor e respeita limite", async () => {
		const db = seed();
		const tool = searchHistoryTool(ctx("c1", db, "/tmp/x"));
		const r = await tool.execute(
			"t",
			{ query: "Terraria", author_id: "u2", limit: 1 } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		const text = r.content[0]?.type === "text" ? r.content[0].text : "";
		expect(text).toContain("• bob");
		expect(text).not.toContain("• ana"); // contexto (│) pode citar a ana
		db.close();
	});

	it("sem query lista recentes; sem nada avisa", async () => {
		const db = seed();
		const tool = searchHistoryTool(ctx("c1", db, "/tmp/x"));
		const recent = await tool.execute("t", {} as never, undefined as never, undefined as never, {} as never);
		expect(recent.content[0]?.type === "text" ? recent.content[0].text : "").toContain("gato");
		const empty = await tool.execute(
			"t",
			{ query: "zzz-nunca" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		expect(empty.content[0]?.type === "text" ? empty.content[0].text : "").toContain("nada encontrado");
		db.close();
	});
});

describe("toolsFor", () => {
	it("user e admin recebem as 5 tools do bot", () => {
		const db = memDb();
		for (const role of ["user", "admin"] as const) {
			const names = toolsFor(role, ctx("c1", db, "/tmp/x")).map((t) => t.name);
			expect(names).toEqual(["web_search", "web_fetch", "download_media", "search_history", "memory_search"]);
		}
		db.close();
	});
});

describe("outbox", () => {
	it("lista, ignora dotfile e descarta", async () => {
		const base = await mkdtemp(join(tmpdir(), "ob-"));
		const dir = outboxDirFor(base, "canal-1");
		const { mkdir, writeFile: wf } = await import("node:fs/promises");
		await mkdir(dir, { recursive: true });
		await wf(join(dir, "a.mp4"), "x");
		await wf(join(dir, ".tmp"), "x");
		expect(await pendingAttachments(base, "canal-1")).toEqual([join(dir, "a.mp4")]);
		await discard(join(dir, "a.mp4"));
		expect(await pendingAttachments(base, "canal-1")).toEqual([]);
		await rm(base, { recursive: true, force: true });
	});

	it("dir inexistente vira lista vazia", async () => {
		expect(await pendingAttachments("/tmp/nao-existe-xyz", "c")).toEqual([]);
	});

	it("sanitiza channel id no path", () => {
		expect(outboxDirFor("/b", "../../etc")).not.toContain("..");
	});
});
