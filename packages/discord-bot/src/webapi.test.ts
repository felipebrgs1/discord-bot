import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "./config.ts";
import { migrate } from "./db.ts";
import { ChannelSessions, type SessionFactory } from "./sessions.ts";
import { SoulStore } from "./souls.ts";
import { createWebHandler } from "./webapi.ts";
import { LogBuffer } from "./weblog.ts";

const nullFactory: SessionFactory = {
	async create() {
		throw new Error("sem sessão nos testes de contrato");
	},
	dispose: () => undefined,
};

function deps() {
	const db = new DatabaseSync(":memory:");
	migrate(db);
	return {
		db,
		config: new ConfigStore(db),
		sessions: new ChannelSessions(nullFactory),
		souls: new SoulStore(db),
		log: new LogBuffer(),
		webDir: "/nao-existe",
		password: "",
	};
}

async function get(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
	url: string,
): Promise<{ status: number; body: unknown }> {
	return new Promise((resolve, reject) => {
		const req = { method: "GET", url, headers: {} } as IncomingMessage;
		let status = 200;
		let raw = "";
		const res = {
			writeHead: (s: number) => {
				status = s;
			},
			end: (d?: unknown) => {
				raw = typeof d === "string" ? d : "";
				try {
					resolve({ status, body: raw ? JSON.parse(raw) : null });
				} catch (e) {
					reject(e);
				}
			},
		} as unknown as ServerResponse;
		handler(req, res);
	});
}

describe("webapi envelopes (contrato do front)", () => {
	it("memories -> {items}, learnings -> {events}, logs -> {entries,next}", async () => {
		const d = deps();
		const handler = createWebHandler(d);
		const mem = (await get(handler, "/api/memories")) as { status: number; body: { items: unknown[] } };
		expect(mem.status).toBe(200);
		expect(Array.isArray(mem.body.items)).toBe(true);
		const learn = (await get(handler, "/api/learnings")) as {
			status: number;
			body: { events: unknown[] };
		};
		expect(Array.isArray(learn.body.events)).toBe(true);
		const logs = (await get(handler, "/api/logs")) as {
			status: number;
			body: { entries: unknown[]; next: number };
		};
		expect(Array.isArray(logs.body.entries)).toBe(true);
		expect(typeof logs.body.next).toBe("number");
		const meta = (await get(handler, "/api/meta")) as { status: number; body: Record<string, unknown> };
		expect(meta.body).toMatchObject({ chat: true, agent: true });
		const metrics = (await get(handler, "/api/metrics")) as {
			status: number;
			body: Record<string, unknown>;
		};
		for (const k of ["summary", "series", "models", "recent", "options"]) {
			expect(metrics.body[k], k).toBeDefined();
		}
		d.config.dispose();
		d.db.close();
	});
});
