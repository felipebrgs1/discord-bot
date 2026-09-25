import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, schemaVersion } from "./db.ts";
import { DEFAULT_SOUL, SoulStore } from "./souls.ts";

function memDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	migrate(db);
	return db;
}

describe("souls", () => {
	it("migra para v2 com as tabelas", () => {
		const db = memDb();
		expect(schemaVersion(db)).toBe(3);
		db.close();
	});

	it("seed cria a padrão, setChannel troca por canal", () => {
		const db = memDb();
		const souls = new SoulStore(db);
		souls.ensureSeed("corpo padrão");
		expect(souls.get(DEFAULT_SOUL)?.body).toBe("corpo padrão");
		souls.ensureSeed("outro"); // idempotente
		expect(souls.get(DEFAULT_SOUL)?.body).toBe("corpo padrão");

		expect(souls.channelSoul("c1")).toBe(DEFAULT_SOUL);
		expect(souls.bodyFor("c1")).toBe("corpo padrão");

		souls.save("serio", "corpo sério");
		souls.setChannel("c1", "serio");
		expect(souls.channelSoul("c1")).toBe("serio");
		expect(souls.bodyFor("c1")).toBe("corpo sério");
		expect(souls.bodyFor("c2")).toBe("corpo padrão");
		db.close();
	});

	it("rejeita soul desconhecida no canal", () => {
		const db = memDb();
		const souls = new SoulStore(db);
		souls.ensureSeed("x");
		expect(() => souls.setChannel("c1", "fantasma")).toThrow();
		db.close();
	});
});
