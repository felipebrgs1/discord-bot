/**
 * Souls: a mente do bot, trocável por canal (só admin troca).
 *
 * - `souls`: personas nomeadas (corpo = system prompt extra da sessão).
 * - `channel_soul`: qual soul cada canal usa; sem linha = soul padrão.
 * - Na primeira subida, a soul padrão nasce de `bot.personality` (era o
 *   YAML do Go) — depois disso, a tabela manda e o config vira legado.
 */

import type { DatabaseSync } from "node:sqlite";

export const DEFAULT_SOUL = "elmatadore";

export interface Soul {
	name: string;
	body: string;
	updated_at: string;
}

export class SoulStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** Garante a soul padrão (idempotente, roda no boot). */
	ensureSeed(fallbackBody: string): void {
		const row = this.db.prepare("SELECT name FROM souls WHERE name = ?;").get(DEFAULT_SOUL) as
			| { name: string }
			| undefined;
		if (!row) {
			this.db.prepare("INSERT INTO souls (name, body) VALUES (?, ?);").run(DEFAULT_SOUL, fallbackBody);
		}
	}

	list(): Soul[] {
		return this.db.prepare("SELECT name, body, updated_at FROM souls ORDER BY name;").all() as unknown as Soul[];
	}

	get(name: string): Soul | undefined {
		return this.db.prepare("SELECT name, body, updated_at FROM souls WHERE name = ?;").get(name) as unknown as
			| Soul
			| undefined;
	}

	/** Cria ou substitui uma soul (admin). */
	save(name: string, body: string): void {
		const slug = name
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.slice(0, 40);
		if (!slug) throw new Error("nome inválido");
		this.db
			.prepare(
				`INSERT INTO souls (name, body, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(name) DO UPDATE
         SET body = excluded.body, updated_at = excluded.updated_at;`,
			)
			.run(slug, body);
	}

	channelSoul(channelId: string): string {
		const row = this.db.prepare("SELECT soul_name FROM channel_soul WHERE channel_id = ?;").get(channelId) as
			| { soul_name: string }
			| undefined;
		return row?.soul_name ?? DEFAULT_SOUL;
	}

	setChannel(channelId: string, soulName: string): void {
		if (!this.get(soulName)) throw new Error(`soul desconhecida: ${soulName}`);
		this.db
			.prepare(
				"INSERT INTO channel_soul (channel_id, soul_name) VALUES (?, ?) ON CONFLICT(channel_id) DO UPDATE SET soul_name = excluded.soul_name;",
			)
			.run(channelId, soulName);
	}

	/** Corpo da soul vigente no canal (com fallback seguro). */
	bodyFor(channelId: string): string {
		return this.get(this.channelSoul(channelId))?.body ?? "";
	}
}
