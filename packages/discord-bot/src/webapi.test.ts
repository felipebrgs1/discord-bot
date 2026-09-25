import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "./config.ts";
import { migrate } from "./db.ts";
import { ChannelSessions, type SessionFactory } from "./sessions.ts";
import { SoulStore } from "./souls.ts";
import { createWebHandler, type WebDeps } from "./webapi.ts";
import { LogBuffer } from "./weblog.ts";

function deps(password = ""): WebDeps & { db: DatabaseSync } {
	const db = new DatabaseSync(":memory:");
	migrate(db);
	const factory: SessionFactory = {
		async create() {
			return {
				prompt: vi.fn(async () => undefined),
				waitForIdle: async () => undefined,
				getLastAssistantText: () => "resposta bot",
				subscribe: (cb: (e: unknown) => void) => {
					cb({ type: "tool_execution_start", toolCallId: "c1", toolName: "web_search", args: { query: "x" } });
					cb({
						type: "tool_execution_end",
						toolCallId: "c1",
						toolName: "web_search",
						result: { content: [{ type: "text", text: "achado" }] },
					});
					return () => undefined;
				},
				dispose: () => undefined,
			} as never;
		},
		dispose: () => undefined,
	};
	return {
		db,
		config: new ConfigStore(db),
		sessions: new ChannelSessions(factory),
		log: new LogBuffer(),
		webDir: "/nao-existe",
		password,
		souls: new SoulStore(db),
	};
}

interface Resp {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

function request(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
	method: string,
	url: string,
	opts?: { body?: unknown; cookie?: string },
): Promise<Resp> {
	return new Promise((resolve, reject) => {
		const req = new EventEmitter() as unknown as IncomingMessage;
		(req as unknown as Record<string, unknown>)["method"] = method;
		(req as unknown as Record<string, unknown>)["url"] = url;
		(req as unknown as Record<string, unknown>)["headers"] = opts?.cookie ? { cookie: opts.cookie } : {};
		let status = 200;
		const headers: Resp["headers"] = {};
		let raw = "";
		const res = {
			writeHead: (s: number, h?: Resp["headers"]) => {
				status = s;
				Object.assign(headers, h ?? {});
			},
			setHeader: (k: string, v: string) => {
				headers[k.toLowerCase()] = v;
			},
			write: (c: string) => {
				raw += c;
			},
			end: (d?: unknown) => {
				if (typeof d === "string") raw += d;
				resolve({ status, headers, body: raw });
			},
		} as unknown as ServerResponse;
		handler(req, res);
		if (opts?.body !== undefined) {
			req.emit("data", JSON.stringify(opts.body));
		}
		req.emit("end");
	});
}

const j = (r: Resp): unknown => (r.body ? JSON.parse(r.body) : null);

function frames(r: Resp): { event: string; data: unknown }[] {
	return r.body
		.split("\n\n")
		.filter((f) => f.includes("data:"))
		.map((f) => {
			const event = (/event:\s*(\S+)/.exec(f) ?? [])[1] ?? "message";
			const data = JSON.parse(
				f
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5).trim())
					.join(""),
			);
			return { event, data };
		});
}

describe("webapi envelopes (contrato do front)", () => {
	it("memories -> {items}, learnings -> {events}, logs -> {entries,next}", async () => {
		const d = deps();
		const handler = createWebHandler(d);
		const mem = await request(handler, "GET", "/api/memories");
		expect(mem.status).toBe(200);
		expect(Array.isArray((j(mem) as { items: unknown[] }).items)).toBe(true);
		const learn = await request(handler, "GET", "/api/learnings");
		expect(Array.isArray((j(learn) as { events: unknown[] }).events)).toBe(true);
		const logs = await request(handler, "GET", "/api/logs");
		const lj = j(logs) as { entries: unknown[]; next: number };
		expect(Array.isArray(lj.entries)).toBe(true);
		expect(typeof lj.next).toBe("number");
		const meta = await request(handler, "GET", "/api/meta");
		expect(j(meta)).toMatchObject({ chat: true, agent: true });
		const metrics = await request(handler, "GET", "/api/metrics");
		for (const k of ["summary", "series", "models", "recent", "options"]) {
			expect((j(metrics) as Record<string, unknown>)[k], k).toBeDefined();
		}
		d.config.dispose();
		d.db.close();
	});
});

describe("webapi auth", () => {
	it("sem senha tudo abre; com senha exige login", async () => {
		const open = deps("");
		const hOpen = createWebHandler(open);
		expect((await request(hOpen, "GET", "/auth/session")).status).toBe(200);
		expect((await request(hOpen, "GET", "/api/meta")).status).toBe(200);
		open.config.dispose();
		open.db.close();

		const pw = `pw-${Date.now()}`;
		const d = deps(pw);
		const h = createWebHandler(d);
		expect((await request(h, "GET", "/api/meta")).status).toBe(401);
		const bad = await request(h, "POST", "/auth/login", { body: { password: "errada" } });
		expect(bad.status).toBe(401);
		const ok = await request(h, "POST", "/auth/login", { body: { password: pw } });
		expect(ok.status).toBe(200);
		const cookie = String(ok.headers["set-cookie"] ?? "").split(";")[0] as string;
		expect(cookie).toContain("db_session=");
		expect((await request(h, "GET", "/api/meta", { cookie })).status).toBe(200);
		const out = await request(h, "POST", "/auth/logout", { cookie });
		expect(out.status).toBe(200);
		expect((await request(h, "GET", "/api/meta", { cookie })).status).toBe(401);
		d.config.dispose();
		d.db.close();
	});
});

describe("webapi chat", () => {
	it("POST faz SSE accepted/step/done e persiste; GET lista; DELETE apaga", async () => {
		const d = deps();
		const h = createWebHandler(d);
		const post = await request(h, "POST", "/api/chat/sessions/sABC123/messages", {
			body: { content: "oi" },
		});
		expect(post.status).toBe(200);
		const evs = frames(post);
		expect(evs.map((e) => e.event)).toEqual(["accepted", "step", "done"]);
		const done = evs[2]?.data as { message: { content: string }; steps: { tool: string }[] };
		expect(done.message.content).toBe("resposta bot");
		expect(done.steps[0]?.tool).toBe("web_search");

		const list = (await request(h, "GET", "/api/chat/sessions").then((r) => j(r))) as {
			sessions: { id: string; messages: number }[];
		};
		expect(list.sessions).toHaveLength(1);
		expect(list.sessions[0]?.id).toBe("sABC123");
		expect(list.sessions[0]?.messages).toBe(2);

		const msgs = (await request(h, "GET", "/api/chat/sessions/sABC123/messages").then((r) => j(r))) as {
			messages: { content: string; is_bot: boolean }[];
		};
		expect(msgs.messages.map((m) => m.content)).toEqual(["oi", "resposta bot"]);

		const del = await request(h, "DELETE", "/api/chat/sessions/sABC123");
		expect(del.status).toBe(204);
		const list2 = (await request(h, "GET", "/api/chat/sessions").then((r) => j(r))) as {
			sessions: unknown[];
		};
		expect(list2.sessions).toHaveLength(0);
		d.config.dispose();
		d.db.close();
	});

	it("rejeita sessão inválida e mensagem vazia", async () => {
		const d = deps();
		const h = createWebHandler(d);
		expect((await request(h, "POST", "/api/chat/sessions/bad!id/messages", { body: { content: "oi" } })).status).toBe(
			400,
		);
		expect((await request(h, "POST", "/api/chat/sessions/s1/messages", { body: { content: "  " } })).status).toBe(
			400,
		);
		d.config.dispose();
		d.db.close();
	});
});

describe("webapi memories", () => {
	function seedMem(db: DatabaseSync): number {
		db.prepare("INSERT INTO memories (key, kind, scope, person_id, channel_id, content) VALUES (?,?,?,?,?,?);").run(
			"jogo-favorito",
			"preference",
			"user",
			"u1",
			"c1",
			"Terraria",
		);
		const row = db.prepare("SELECT rowid AS id FROM memories;").get() as { id: number };
		return row.id;
	}

	it("lista, versões, forget/restore e correct", async () => {
		const d = deps();
		const h = createWebHandler(d);
		const id = seedMem(d.db);

		const list = (await request(h, "GET", "/api/memories").then((r) => j(r))) as {
			items: { id: number; content: string; version: number }[];
		};
		expect(list.items).toHaveLength(1);
		expect(list.items[0]?.content).toBe("Terraria");

		const forget = await request(h, "POST", `/api/memories/${id}/forget`, { body: { reason: "teste" } });
		expect((j(forget) as { changed: boolean }).changed).toBe(true);
		const list2 = (await request(h, "GET", "/api/memories").then((r) => j(r))) as { items: unknown[] };
		expect(list2.items).toHaveLength(0); // suppressed some da lista

		const versions = (await request(h, "GET", `/api/memories/${id}/versions`).then((r) => j(r))) as {
			versions: { reason: string }[];
		};
		expect(versions.versions.some((v) => v.reason === "teste")).toBe(true);

		await request(h, "POST", `/api/memories/${id}/restore`, { body: {} });
		const correct = await request(h, "PUT", `/api/memories/${id}`, {
			body: { content: "Stardew Valley", reason: "mudou" },
		});
		expect((j(correct) as { changed: boolean }).changed).toBe(true);
		const list3 = (await request(h, "GET", "/api/memories").then((r) => j(r))) as {
			items: { content: string; version: number }[];
		};
		expect(list3.items[0]?.content).toBe("Stardew Valley");
		expect(list3.items[0]?.version).toBe(3);
		d.config.dispose();
		d.db.close();
	});

	it("404 em memória inexistente; PUT vazio é 400", async () => {
		const d = deps();
		const h = createWebHandler(d);
		expect((await request(h, "GET", "/api/memories/999/versions")).status).toBe(404);
		expect((await request(h, "PUT", "/api/memories/999", { body: { content: "x" } })).status).toBe(404);
		d.db
			.prepare("INSERT INTO memories (key, kind, scope, person_id, channel_id, content) VALUES (?,?,?,?,?,?);")
			.run("k", "fact", "group", "", "", "c");
		const id = (d.db.prepare("SELECT rowid AS id FROM memories;").get() as { id: number }).id;
		expect((await request(h, "PUT", `/api/memories/${id}`, { body: { content: "  " } })).status).toBe(400);
		d.config.dispose();
		d.db.close();
	});
});

describe("webapi config", () => {
	it("GET/PUT do formulário discord (sem YAML)", async () => {
		const d = deps();
		const h = createWebHandler(d);
		const before = (await request(h, "GET", "/api/config/discord").then((r) => j(r))) as Record<string, unknown>;
		expect(before["guild_id"]).toBe("");
		const put = await request(h, "PUT", "/api/config/discord", {
			body: {
				guild_id: "g9",
				channel_ids: ["c9"],
				admin_ids: ["a9"],
				moderator_ids: "ignorado",
				web_user_id: "a9",
				personality: "mente nova",
			},
		});
		expect((j(put) as { saved: boolean }).saved).toBe(true);
		const after = (await request(h, "GET", "/api/config/discord").then((r) => j(r))) as Record<string, unknown>;
		expect(after).toMatchObject({
			guild_id: "g9",
			channel_ids: ["c9"],
			admin_ids: ["a9"],
			web_user_id: "a9",
			personality: "mente nova",
		});
		d.config.dispose();
		d.db.close();
	});

	it("model: GET mostra atual, PUT troca", async () => {
		const d = deps();
		const h = createWebHandler(d);
		const put = await request(h, "PUT", "/api/model", { body: { model: "x-model" } });
		expect((j(put) as { model: string }).model).toBe("x-model");
		const cat = (await request(h, "GET", "/api/models").then((r) => j(r))) as { model: string; models: unknown[] };
		expect(cat.model).toBe("x-model");
		expect(Array.isArray(cat.models)).toBe(true);
		d.config.dispose();
		d.db.close();
	});
});

describe("webapi static", () => {
	it("sem dist mostra página de instrução; traversal é 403", async () => {
		const d = deps();
		const h = createWebHandler(d);
		const home = await request(h, "GET", "/");
		expect(home.status).toBe(200);
		expect(home.body).toContain("Painel sem build");
		expect((await request(h, "GET", "/%2e%2e%2fpackage.json")).status).toBe(403);
		expect((await request(h, "GET", "/api/rota-xyz")).status).toBe(404);
		d.config.dispose();
		d.db.close();
	});
});
