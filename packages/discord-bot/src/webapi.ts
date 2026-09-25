/**
 * Painel web (migração do webapi Go): serve web/dist + API /api/*.
 *
 * Zero dependências além de node:http. Formas de resposta espelham o
 * contrato que o front React espera (api.ts) — o front veio quase
 * intacto do bot Go; o que mudou de conceito (YAML, multi-bot) virou
 * formulário sobre o SQLite em vez de editor de texto.
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, normalize, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ConfigStore } from "./config.ts";
import { recordTurn } from "./metrics.ts";
import { roleOf } from "./roles.ts";
import type { ChannelSessions } from "./sessions.ts";
import { DEFAULT_SOUL, type SoulStore } from "./souls.ts";
import type { LogBuffer } from "./weblog.ts";

export interface WebDeps {
	db: DatabaseSync;
	config: ConfigStore;
	sessions: ChannelSessions;
	log: LogBuffer;
	/** Diretório com o build do front (web/dist). */
	webDir: string;
	/** Senha do painel (DASHBOARD_PASSWORD); vazio = sem login. */
	password: string;
	souls: SoulStore;
}

const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
const tokens = new Set<string>();

function json(res: ServerResponse, status: number, data: unknown): void {
	const body = JSON.stringify(data);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(body);
}

function err(res: ServerResponse, status: number, message: string): void {
	json(res, status, { error: message });
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
			if (raw.length > 1_000_000) reject(new Error("corpo grande demais"));
		});
		req.on("end", () => {
			if (!raw.trim()) resolve(null);
			else {
				try {
					resolve(JSON.parse(raw));
				} catch {
					reject(new Error("JSON inválido"));
				}
			}
		});
		req.on("error", reject);
	});
}

function cookies(req: IncomingMessage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (req.headers.cookie ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
	}
	return out;
}

function sse(res: ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

function webKey(id: string): string {
	return `web:${id}`;
}

interface MsgRow {
	rowid: number;
	channel_id: string;
	author_id: string;
	author_name: string;
	message_id: string;
	body: string;
	reply_to: string | null;
	created_at: string;
}

function toChatMessage(r: MsgRow): Record<string, unknown> {
	return {
		id: r.message_id,
		author_id: r.author_id,
		author_name: r.author_name,
		content: r.body,
		reply_to: r.reply_to ?? undefined,
		is_bot: r.author_id === "bot",
		created_at: r.created_at,
	};
}

function newMsgId(): string {
	return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function emptyStats(): Record<string, unknown> {
	return {
		requests: 0,
		failures: 0,
		retries: 0,
		input_tokens: null,
		output_tokens: null,
		cached_tokens: null,
		cache_write_tokens: null,
		cache_input_tokens: null,
		cache_matched_tokens: null,
		cache_samples: 0,
		token_samples: 0,
		cost_usd: null,
		cost_samples: 0,
		avg_latency_ms: null,
		p95_latency_ms: null,
		effective_tps: null,
	};
}

export function createWebHandler(deps: WebDeps): (req: IncomingMessage, res: ServerResponse) => void {
	const { db, config, sessions, log, webDir, password, souls } = deps;

	const authed = (req: IncomingMessage): boolean => {
		if (!password) return true;
		const token = cookies(req)["db_session"];
		return !!token && tokens.has(token);
	};

	return (req, res) => {
		void handle(req, res).catch((e: unknown) => {
			log.log("error", "webapi", { error: e instanceof Error ? e.message : String(e) });
			if (!res.headersSent) err(res, 500, "erro interno");
			else res.end();
		});
	};

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://x");
		const path = url.pathname;
		const method = req.method ?? "GET";

		// ---- auth (contrato igual ao front espera) ----
		if (path === "/auth/session" && method === "GET") {
			if (!authed(req)) return err(res, 401, "sessão expirada — entre de novo");
			return json(res, 200, { ok: true });
		}
		if (path === "/auth/login" && method === "POST") {
			const body = (await readBody(req)) as { password?: unknown };
			if (!password || body?.password === password) {
				const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
				tokens.add(token);
				res.setHeader("Set-Cookie", `db_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
				return json(res, 200, { ok: true });
			}
			return err(res, 401, "senha incorreta");
		}
		if (path === "/auth/logout" && method === "POST") {
			tokens.delete(cookies(req)["db_session"] ?? "");
			return json(res, 200, { ok: true });
		}

		// ---- API autenticada ----
		if (path.startsWith("/api/")) {
			if (!authed(req)) return err(res, 401, "sessão expirada — entre de novo");
			return handleApi(url, path, method, req, res);
		}

		// ---- front estático + fallback SPA ----
		return serveStatic(path, res);
	}

	async function handleApi(
		url: URL,
		path: string,
		method: string,
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const settings = config.all();

		if (path === "/api/meta" && method === "GET") {
			const webUser = settings.dashboard.web_user_id;
			return json(res, 200, {
				chat: true,
				agent: true,
				model: settings.chat.model || "(padrão do pi)",
				role: roleOf(webUser, settings),
			});
		}

		if (path === "/api/logs" && method === "GET") {
			const after = Number(url.searchParams.get("after") ?? "0") || 0;
			const limit = Math.min(Number(url.searchParams.get("limit") ?? "300") || 300, 1000);
			const { entries, cursor } = log.after(after, limit);
			return json(res, 200, { entries, next: cursor });
		}

		// ---- chat web (sessões próprias, prefixo web:) ----
		if (path === "/api/chat/sessions" && method === "GET") {
			const ids = sessions.keys().filter((k) => k.startsWith("web:"));
			const list = ids.map((key) => {
				const id = key.slice(4);
				const rows = db
					.prepare("SELECT body, created_at FROM messages WHERE channel_id = ? ORDER BY rowid LIMIT 1000;")
					.all(key) as { body: string; created_at: string }[];
				const first = rows.find((r) => r.body)?.body ?? "";
				return {
					id,
					title: first.slice(0, 60) || id,
					updated_at: rows.length ? rows[rows.length - 1]?.created_at : new Date().toISOString(),
					messages: rows.length,
				};
			});
			return json(res, 200, { sessions: list });
		}

		let m = path.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
		if (m) {
			const id = m[1] as string;
			if (!SESSION_RE.test(id)) return err(res, 400, "sessão inválida");
			const key = webKey(id);
			if (method === "GET") {
				const rows = db
					.prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY rowid LIMIT 1000;")
					.all(key) as unknown as MsgRow[];
				return json(res, 200, { messages: rows.map(toChatMessage) });
			}
			if (method === "POST") {
				const body = (await readBody(req)) as { content?: unknown };
				const content = typeof body?.content === "string" ? body.content : "";
				if (!content.trim()) return err(res, 400, "mensagem vazia");
				return streamChat(key, content, res);
			}
			return err(res, 405, "método não permitido");
		}

		m = path.match(/^\/api\/chat\/sessions\/([^/]+)$/);
		if (m && method === "DELETE") {
			const id = m[1] as string;
			if (!SESSION_RE.test(id)) return err(res, 400, "sessão inválida");
			const key = webKey(id);
			sessions.remove(key);
			db.prepare("DELETE FROM messages WHERE channel_id = ?;").run(key);
			res.writeHead(204);
			res.end();
			return;
		}

		// ---- memórias ----
		if (path === "/api/memories" && method === "GET") {
			const limit = Math.min(Number(url.searchParams.get("limit") ?? "200") || 200, 500);
			const rows = db
				.prepare("SELECT * FROM memories WHERE status = 'active' ORDER BY rowid DESC LIMIT ?;")
				.all(limit) as Record<string, unknown>[];
			return json(res, 200, {
				items: rows.map((r) => ({
					id: r["rowid"],
					channel_id: r["channel_id"],
					scope: r["scope"],
					user_id: r["person_id"] || undefined,
					key: r["key"],
					kind: r["kind"],
					status: r["status"],
					content: r["content"],
					source_ids: [],
					version: versionCount(String(r["key"])),
					updated_at: r["updated_at"],
				})),
			});
		}

		m = path.match(/^\/api\/memories\/(\d+)\/versions$/);
		if (m && method === "GET") {
			const mem = db.prepare("SELECT * FROM memories WHERE rowid = ?;").get(Number(m[1])) as
				| Record<string, unknown>
				| undefined;
			if (!mem) return err(res, 404, "memória não encontrada");
			const versions = db
				.prepare(
					"SELECT rowid, content, reason, created_at FROM memory_versions WHERE memory_key = ? ORDER BY rowid;",
				)
				.all(String(mem["key"])) as { rowid: number; content: string; reason: string; created_at: string }[];
			return json(res, 200, {
				versions: versions.map((v) => ({
					version: v.rowid,
					kind: mem["kind"],
					status: mem["status"],
					content: v.content,
					source_ids: [],
					reason: v.reason,
					created_at: v.created_at,
				})),
			});
		}

		m = path.match(/^\/api\/memories\/(\d+)\/(forget|restore)$/);
		if (m && method === "POST") {
			const id = Number(m[1]);
			const status = m[2] === "forget" ? "suppressed" : "active";
			const body = (await readBody(req)) as { reason?: unknown };
			const reason = typeof body?.reason === "string" ? body.reason : "";
			const mem = db.prepare("SELECT * FROM memories WHERE rowid = ?;").get(id) as
				| Record<string, unknown>
				| undefined;
			if (!mem) return err(res, 404, "memória não encontrada");
			db.prepare(
				"UPDATE memories SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = ?;",
			).run(status, id);
			db.prepare(
				"INSERT INTO memory_versions (memory_key, scope, person_id, channel_id, content, reason) VALUES (?,?,?,?,?,?);",
			).run(
				String(mem["key"]),
				String(mem["scope"]),
				String(mem["person_id"]),
				String(mem["channel_id"]),
				String(mem["content"]),
				reason || (status === "suppressed" ? "esquecido pelo painel" : "restaurado pelo painel"),
			);
			return json(res, 200, { changed: true });
		}

		m = path.match(/^\/api\/memories\/(\d+)$/);
		if (m && method === "PUT") {
			const id = Number(m[1]);
			const body = (await readBody(req)) as { content?: unknown; reason?: unknown };
			if (typeof body?.content !== "string" || !body.content.trim()) {
				return err(res, 400, "conteúdo vazio");
			}
			const mem = db.prepare("SELECT * FROM memories WHERE rowid = ?;").get(id) as
				| Record<string, unknown>
				| undefined;
			if (!mem) return err(res, 404, "memória não encontrada");
			db.prepare(
				"UPDATE memories SET content = ?, status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = ?;",
			).run(body.content, id);
			db.prepare(
				"INSERT INTO memory_versions (memory_key, scope, person_id, channel_id, content, reason) VALUES (?,?,?,?,?,?);",
			).run(
				String(mem["key"]),
				String(mem["scope"]),
				String(mem["person_id"]),
				String(mem["channel_id"]),
				body.content,
				typeof body?.reason === "string" ? body.reason : "corrigido pelo painel",
			);
			return json(res, 200, { changed: true });
		}

		// ---- linha do tempo do aprendizado ----
		if (path === "/api/learnings" && method === "GET") {
			const limit = Math.min(Number(url.searchParams.get("limit") ?? "80") || 80, 200);
			const versions = db
				.prepare("SELECT created_at AS at, memory_key, reason FROM memory_versions ORDER BY rowid DESC LIMIT ?;")
				.all(limit) as { at: string; memory_key: string; reason: string }[];
			const skills = db
				.prepare(
					"SELECT created_at AS at, skill_name, usage, result, channel_id FROM skill_runs ORDER BY rowid DESC LIMIT ?;",
				)
				.all(limit) as { at: string; skill_name: string; usage: string; result: string; channel_id: string }[];
			const events = [
				...versions.map((v) => ({
					at: v.at,
					kind: "memory",
					channel_id: "",
					subject: v.memory_key,
					detail: v.reason || "versão registrada",
				})),
				...skills.map((s) => ({
					at: s.at,
					kind: "skill",
					channel_id: s.channel_id,
					subject: s.skill_name,
					detail: `${s.usage} (${s.result})`,
				})),
			]
				.sort((a, b) => (a.at < b.at ? 1 : -1))
				.slice(0, limit);
			return json(res, 200, { events });
		}

		// ---- métricas (lê ai_requests; escrita vem na Fase 2) ----
		if (path === "/api/metrics" && method === "GET") {
			return json(res, 200, metricsSnapshot());
		}

		// ---- config (formulário JSON sobre o SQLite — sem YAML) ----
		if (path === "/api/config/discord" && method === "GET") {
			const all = config.all();
			return json(res, 200, {
				...all.discord,
				web_user_id: all.dashboard.web_user_id,
				personality: souls.get(DEFAULT_SOUL)?.body ?? all.bot.personality,
			});
		}
		if (path === "/api/config/discord" && method === "PUT") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const strArr = (v: unknown): string[] =>
				Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
			const str = (v: unknown): string => (typeof v === "string" ? v : "");
			config.set("discord", {
				guild_id: str(body["guild_id"]),
				channel_ids: strArr(body["channel_ids"]),
				admin_ids: strArr(body["admin_ids"]),
				moderator_ids: strArr(body["moderator_ids"]),
			});
			if (typeof body["web_user_id"] === "string") {
				config.set("dashboard", { web_user_id: body["web_user_id"] });
			}
			if (typeof body["personality"] === "string" && body["personality"]) {
				// A mente vigente mora nas souls: edita a padrão e derruba
				// as sessões para a nova encarnar (vale na próxima resposta).
				souls.save(DEFAULT_SOUL, body["personality"]);
				for (const key of sessions.keys()) sessions.remove(key);
			}
			return json(res, 200, { saved: true, restart_required: true });
		}

		// ---- participação (Fase 3): stubs para o front não quebrar ----
		if (path === "/api/participation" && method === "GET") {
			return json(res, 200, { items: [] });
		}
		if (path.startsWith("/api/participation/") && method === "POST") {
			return json(res, 200, { changed: true });
		}

		if (path === "/api/models" && method === "GET") {
			return json(res, 200, { models: [], model: config.all().chat.model });
		}
		if (path === "/api/model" && method === "PUT") {
			const body = (await readBody(req)) as { model?: unknown };
			const model = typeof body?.model === "string" ? body.model : "";
			config.set("chat.model", model);
			return json(res, 200, { model, restart_required: false });
		}

		if (path === "/api" || path === "/api/") return err(res, 404, "rota desconhecida");
		return err(res, 404, "rota desconhecida");
	}

	function versionCount(key: string): number {
		const row = db.prepare("SELECT COUNT(*) AS n FROM memory_versions WHERE memory_key = ?;").get(key) as {
			n: number;
		};
		return row.n;
	}

	function metricsSnapshot(): Record<string, unknown> {
		const total = db.prepare("SELECT COUNT(*) AS n FROM ai_requests;").get() as { n: number };
		const failed = db.prepare("SELECT COUNT(*) AS n FROM ai_requests WHERE status <> 'success';").get() as {
			n: number;
		};
		const inSum = db.prepare("SELECT COALESCE(SUM(input_tokens),0) AS s FROM ai_requests;").get() as {
			s: number;
		};
		const outSum = db.prepare("SELECT COALESCE(SUM(output_tokens),0) AS s FROM ai_requests;").get() as {
			s: number;
		};
		const costSum = db.prepare("SELECT COALESCE(SUM(cost),0) AS s FROM ai_requests;").get() as {
			s: number;
		};
		const byModel = db
			.prepare(
				`SELECT model, provider, operation, source,
				 COUNT(*) AS requests, SUM(status <> 'success') AS failures,
				 COALESCE(SUM(input_tokens),0) AS input_tokens,
				 COALESCE(SUM(output_tokens),0) AS output_tokens,
				 COALESCE(SUM(cost),0) AS cost_usd,
				 AVG(latency_ms) AS avg_latency_ms
			 FROM ai_requests GROUP BY model, provider, operation, source;`,
			)
			.all() as Record<string, number | string>[];
		const recent = db.prepare("SELECT * FROM ai_requests ORDER BY rowid DESC LIMIT 50;").all() as Record<
			string,
			number | string | null
		>[];
		const now = new Date().toISOString();
		return {
			since: now,
			until: now,
			bucket_seconds: 3600,
			summary: {
				...emptyStats(),
				requests: total.n,
				failures: failed.n,
				input_tokens: inSum.s,
				output_tokens: outSum.s,
				cost_usd: costSum.s,
				token_samples: total.n,
				cost_samples: total.n,
			},
			series: [],
			models: byModel.map((r) => ({
				...emptyStats(),
				provider: r["provider"],
				model: r["model"],
				operation: r["operation"],
				source: r["source"],
				requests: r["requests"],
				failures: r["failures"],
				input_tokens: r["input_tokens"],
				output_tokens: r["output_tokens"],
				cost_usd: r["cost_usd"],
				avg_latency_ms: r["avg_latency_ms"],
				token_samples: r["requests"],
				cost_samples: r["requests"],
			})),
			recent: recent.map((r) => ({
				id: r["rowid"],
				started_at: r["created_at"],
				duration_ms: r["latency_ms"],
				operation: r["operation"],
				workflow: "",
				channel_id: "",
				source: r["source"],
				provider: r["provider"],
				model: r["model"],
				resolved_model: r["model"],
				request_id: String(r["rowid"]),
				success: r["status"] === "success",
				http_status: r["status"] === "success" ? 200 : 500,
				attempts: 1,
				error_kind: r["status"] === "success" ? "" : "error",
				input_tokens: r["input_tokens"],
				output_tokens: r["output_tokens"],
				total_tokens:
					typeof r["input_tokens"] === "number" && typeof r["output_tokens"] === "number"
						? (r["input_tokens"] as number) + (r["output_tokens"] as number)
						: null,
				cached_tokens: null,
				cache_write_tokens: null,
				cost_usd: r["cost"],
			})),
			options: { models: [], providers: [] },
			refresh_ms: 5000,
		};
	}

	async function streamChat(key: string, content: string, res: ServerResponse): Promise<void> {
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		const at = new Date().toISOString();
		const saveMsg = (authorId: string, authorName: string, body: string): MsgRow => {
			const message_id = newMsgId();
			db.prepare(
				"INSERT INTO messages (channel_id, author_id, author_name, message_id, body, created_at) VALUES (?,?,?,?,?,?);",
			).run(key, authorId, authorName, message_id, body, at);
			const row = db.prepare("SELECT * FROM messages WHERE message_id = ?;").get(message_id) as unknown as MsgRow;
			return row;
		};
		try {
			const userMsg = saveMsg("web", "você", content);
			sse(res, "accepted", { message: toChatMessage(userMsg) });

			const settings = config.all();
			const role = roleOf(settings.dashboard.web_user_id, settings);
			const steps: { tool: string; args: string; output: string; duration_ms: number }[] = [];
			const started = new Map<string, { tool: string; args: string; at: number }>();
			const session = await sessions.get(key, role);
			const unsub =
				typeof (session as { subscribe?: unknown }).subscribe === "function"
					? (session as unknown as { subscribe: (cb: (e: unknown) => void) => () => void }).subscribe(
							(event: unknown) => {
								const e = event as Record<string, unknown>;
								if (e["type"] === "tool_execution_start" && typeof e["toolCallId"] === "string") {
									started.set(e["toolCallId"], {
										tool: String(e["toolName"] ?? "tool"),
										args: JSON.stringify(e["args"] ?? {}).slice(0, 2000),
										at: Date.now(),
									});
								} else if (e["type"] === "tool_execution_end" && typeof e["toolCallId"] === "string") {
									const s = started.get(e["toolCallId"] as string);
									started.delete(e["toolCallId"] as string);
									const result = e["result"] as { content?: { type: string; text?: string }[] } | undefined;
									const output = (result?.content ?? [])
										.filter((b) => b.type === "text" && b.text)
										.map((b) => String(b.text))
										.join("\n")
										.slice(0, 4000);
									const step = {
										tool: String(e["toolName"] ?? s?.tool ?? "tool"),
										args: s?.args ?? "{}",
										output,
										duration_ms: s ? Date.now() - s.at : 0,
									};
									steps.push(step);
									try {
										sse(res, "step", step);
									} catch {
										/* cliente foi embora */
									}
								}
							},
						)
					: () => undefined;
			let answer: string;
			try {
				answer = await sessions.ask(key, role, content, {
					source: "web",
					model: settings.chat.model,
					systemExtra: souls.bodyFor(key),
					onTurn: (r) => recordTurn(db, r),
				});
			} finally {
				try {
					unsub();
				} catch {
					/* ignore */
				}
			}
			const botMsg = saveMsg("bot", "bot", answer);
			sse(res, "done", { message: toChatMessage(botMsg), steps });
		} catch (e: unknown) {
			try {
				sse(res, "error", { message: e instanceof Error ? e.message : String(e) });
			} catch {
				/* cliente foi embora */
			}
		} finally {
			res.end();
		}
	}

	async function serveStatic(path: string, res: ServerResponse): Promise<void> {
		const noDist = async (): Promise<void> => {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:2rem">
<h1>Painel sem build</h1>
<p>Rode <code>pnpm --filter discord-bot-web run build</code> em <code>packages/discord-bot/web</code>.</p>
</body></html>`);
		};
		let rel = decodeURIComponent(path);
		if (rel.endsWith("/")) rel += "index.html";
		const file = normalize(join(webDir, rel));
		if (!file.startsWith(webDir + sep) && file !== join(webDir, "index.html")) {
			res.writeHead(403);
			res.end();
			return;
		}
		try {
			const data = await readFile(file);
			const dot = file.lastIndexOf(".");
			const type = CONTENT_TYPES[file.slice(dot)] ?? "application/octet-stream";
			res.writeHead(200, { "Content-Type": type });
			res.end(data);
			return;
		} catch {
			/* tenta o fallback SPA */
		}
		try {
			const data = await readFile(join(webDir, "index.html"));
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(data);
			return;
		} catch {
			return noDist();
		}
	}
}

export function startDashboard(deps: WebDeps, port: number, host: string): Server {
	const server = createServer(createWebHandler(deps));
	server.listen(port, host);
	return server;
}
