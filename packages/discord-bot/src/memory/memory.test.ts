import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "../db.ts";
import type { ToolCtx } from "../tools/index.ts";
import { memorySearchTool } from "../tools/memory.ts";
import { LogBuffer } from "../weblog.ts";
import { consolidateChannel } from "./consolidate.ts";
import { type MsgInput, validateExtraction } from "./extract.ts";
import { familiarityBlock } from "./familiarity.ts";

function memDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	migrate(db);
	return db;
}

const batch: MsgInput[] = [
	{
		rowid: 1,
		author_id: "u1",
		author_name: "ana",
		body: "meu jogo favorito é Terraria",
		created_at: "2026-09-20T10:00:00Z",
	},
	{
		rowid: 2,
		author_id: "u2",
		author_name: "bob",
		body: "massa, o meu é Stardew",
		created_at: "2026-09-20T10:01:00Z",
	},
	{ rowid: 3, author_id: "u1", author_name: "ana", body: "kkk", created_at: "2026-09-20T10:02:00Z" },
];

describe("validateExtraction", () => {
	it("aceita memória válida e descarta atribuição errada", () => {
		const r = validateExtraction(
			{
				summary: "gostos de jogos",
				memories: [
					{ key: "jogo-favorito", kind: "preference", scope: "user", person_id: "u1", content: "ama Terraria" },
					{ key: "x", kind: "preference", scope: "user", person_id: "u9", content: "atribuído a quem não falou" },
					{ key: "y", kind: "meme", scope: "group", content: "kind inválido" },
					{ key: "", kind: "fact", scope: "group", content: "" },
				],
				episodes: [{ key: "e1", title: "A saga", summary: "resumo" }],
			},
			batch,
		);
		expect(r.summary).toBe("gostos de jogos");
		expect(r.memories).toHaveLength(1);
		expect(r.memories[0]).toMatchObject({ key: "jogo-favorito", person_id: "u1" });
		expect(r.episodes).toHaveLength(1);
	});

	it("tolera lixo sem quebrar", () => {
		expect(validateExtraction(null, batch)).toEqual({ summary: "", memories: [], episodes: [] });
		expect(validateExtraction({ memories: "não-array" }, batch).memories).toEqual([]);
	});
});

describe("consolidateChannel", () => {
	function seedDb(): DatabaseSync {
		const db = memDb();
		const ins = db.prepare(
			"INSERT INTO messages (channel_id, author_id, author_name, message_id, body, created_at) VALUES (?,?,?,?,?,?);",
		);
		batch.forEach((m, i) => ins.run("c1", m.author_id, m.author_name, `m${i}`, m.body, m.created_at));
		return db;
	}

	it("extrai, grava e avança cursor (atômico)", async () => {
		const db = seedDb();
		const caller = async () => ({
			summary: "s",
			memories: [
				{ key: "jogo-favorito", kind: "preference", scope: "user", person_id: "u1", content: "ama Terraria" },
			],
			episodes: [],
		});
		const r = await consolidateChannel(db, caller, "c1");
		expect(r).toEqual({ consolidated: true, memories: 1 });
		const mem = db.prepare("SELECT content FROM memories;").get() as { content: string };
		expect(mem.content).toBe("ama Terraria");
		// Segunda passada sem mensagens novas: não faz nada (sem reextração).
		const r2 = await consolidateChannel(db, caller, "c1");
		expect(r2.consolidated).toBe(false);
		const n = db.prepare("SELECT COUNT(*) AS n FROM memory_versions;").get() as { n: number };
		expect(n.n).toBe(1);
		db.close();
	});

	it("falha de extração não avança cursor", async () => {
		const db = seedDb();
		const caller = async () => {
			throw new Error("modelo caiu");
		};
		const r = await consolidateChannel(db, caller, "c1");
		expect(r.consolidated).toBe(false);
		const cur = db.prepare("SELECT COUNT(*) AS n FROM memory_cursors;").get() as { n: number };
		expect(cur.n).toBe(0);
		db.close();
	});

	it("atualiza fato pela mesma chave", async () => {
		const db = seedDb();
		const v1 = async () => ({
			summary: "s",
			memories: [{ key: "jogo", kind: "fact", scope: "group", person_id: "", content: "Terraria" }],
			episodes: [],
		});
		await consolidateChannel(db, v1, "c1");
		db.prepare("INSERT INTO messages (channel_id, author_id, author_name, message_id, body) VALUES (?,?,?,?,?);").run(
			"c1",
			"u1",
			"ana",
			"m9",
			"na verdade agora é Stardew",
		);
		const v2 = async () => ({
			summary: "s",
			memories: [{ key: "jogo", kind: "fact", scope: "group", person_id: "", content: "Stardew" }],
			episodes: [],
		});
		await consolidateChannel(db, v2, "c1", { minNew: 1 });
		const rows = db.prepare("SELECT content FROM memories;").all() as { content: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.content).toBe("Stardew");
		db.close();
	});
});

describe("familiarityBlock", () => {
	it(" Junta prefs suas + do grupo, ignora resto", () => {
		const db = memDb();
		const ins = db.prepare(
			"INSERT INTO memories (key, kind, scope, person_id, channel_id, content) VALUES (?,?,?,?,?,?);",
		);
		ins.run("a", "preference", "user", "u1", "c1", "ama Terraria");
		ins.run("b", "lesson", "user", "u1", "c1", "não resuma demais");
		ins.run("c", "fact", "user", "u1", "c1", "fato seco não entra");
		ins.run("d", "culture", "group", "", "c1", "sextou é sagrado");
		ins.run("e", "preference", "user", "u2", "c1", "do outro não entra");
		ins.run("f", "preference", "group", "", "c9", "de outro canal não entra");
		const text = familiarityBlock(db, { personId: "u1", channelId: "c1" });
		expect(text).toContain("ama Terraria");
		expect(text).toContain("não resuma demais");
		expect(text).toContain("sextou é sagrado");
		expect(text).not.toContain("fato seco");
		expect(text).not.toContain("do outro");
		expect(text).not.toContain("outro canal");
		db.close();
	});

	it("vazio vira string vazia", () => {
		const db = memDb();
		expect(familiarityBlock(db, { personId: "u1", channelId: "c1" })).toBe("");
		db.close();
	});
});

describe("memorySearchTool", () => {
	it("acha por FTS só ativas do canal", async () => {
		const db = memDb();
		const ins = db.prepare(
			"INSERT INTO memories (key, kind, scope, person_id, channel_id, content, status) VALUES (?,?,?,?,?,?,?);",
		);
		ins.run("a", "preference", "user", "u1", "c1", "ama Terraria", "active");
		ins.run("b", "fact", "group", "", "c1", "esquecido", "suppressed");
		const ctx: ToolCtx = { channelId: "c1", db, log: new LogBuffer(), outboxDir: "/tmp/x" };
		const tool = memorySearchTool(ctx);
		const hit = await tool.execute(
			"t",
			{ query: "Terraria" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		expect(hit.content[0]?.type === "text" ? hit.content[0].text : "").toContain("ama Terraria");
		const sup = await tool.execute(
			"t",
			{ query: "esquecido" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		expect(sup.content[0]?.type === "text" ? sup.content[0].text : "").toContain("nada nas memórias");
		db.close();
	});
});
