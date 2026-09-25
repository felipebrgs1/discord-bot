import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConfigStore, DEFAULTS } from "./config.ts";
import { migrate, openDatabase, schemaVersion } from "./db.ts";

function memDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	migrate(db);
	return db;
}

describe("migrations", () => {
	it("applies all migrations and reports the version", () => {
		const db = memDb();
		expect(schemaVersion(db)).toBe(2);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name;")
			.all() as { name: string }[];
		const names = new Set(tables.map((t) => t.name));
		for (const t of [
			"config",
			"messages",
			"messages_fts",
			"memories",
			"memories_fts",
			"memory_versions",
			"episodes",
			"rolling_summaries",
			"interaction_events",
			"skill_runs",
			"participation_actions",
			"open_loops",
			"ai_requests",
			"souls",
			"channel_soul",
			"schema_migrations",
		]) {
			expect(names.has(t), `missing ${t}`).toBe(true);
		}
		db.close();
	});

	it("is idempotent", () => {
		const db = memDb();
		migrate(db);
		expect(schemaVersion(db)).toBe(2);
		db.close();
	});

	it("openDatabase enables WAL", () => {
		const db = openDatabase(":memory:");
		const row = db.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
		expect(row.journal_mode.toLowerCase()).toBe("memory");
		db.close();
	});
});

describe("memories_fts", () => {
	it("finds inserted memories by keyword", () => {
		const db = memDb();
		db.prepare("INSERT INTO memories (key, kind, scope, person_id, channel_id, content) VALUES (?,?,?,?,?,?);").run(
			"jogo-favorito",
			"preference",
			"user",
			"u1",
			"c1",
			"Meu jogo favorito é Terraria",
		);
		const hits = db.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH ?;").all("Terraria") as {
			content: string;
		}[];
		expect(hits).toHaveLength(1);
		expect(hits[0]?.content).toContain("Terraria");
		db.close();
	});
});

describe("ConfigStore", () => {
	it("serves defaults on an empty database", () => {
		const db = memDb();
		const cfg = new ConfigStore(db);
		expect(cfg.all()).toEqual(DEFAULTS);
		expect(cfg.get("chat.model")).toBe("");
		cfg.dispose();
		db.close();
	});

	it("persists dotted keys and sections", () => {
		const db = memDb();
		const cfg = new ConfigStore(db);
		cfg.set("chat.model", "gpt-oss-120b");
		expect(cfg.get("chat.model")).toBe("gpt-oss-120b");
		cfg.set("discord", { channel_ids: ["c1"] });
		expect(cfg.all().discord.channel_ids).toEqual(["c1"]);
		// Defaults for untouched fields survive section overlay.
		expect(cfg.all().discord.guild_id).toBe("");
		expect(cfg.updatedAt("chat.model")).not.toBe("");
		cfg.dispose();
		db.close();
	});

	it("dotted keys win over whole-section keys", () => {
		const db = memDb();
		const cfg = new ConfigStore(db);
		cfg.set("discord", { channel_ids: ["c1", "c2"] });
		cfg.set("discord.channel_ids", ["c2"]);
		expect(cfg.all().discord.channel_ids).toEqual(["c2"]);
		cfg.dispose();
		db.close();
	});

	it("notifies subscribers on change", async () => {
		const db = memDb();
		const cfg = new ConfigStore(db, 20);
		const seen: string[] = [];
		const unsub = cfg.subscribe((k) => seen.push(k));
		cfg.set("bot.personality", "seco e direto");
		expect(seen).toContain("bot.personality");
		unsub();
		cfg.dispose();
		db.close();
	});
});
