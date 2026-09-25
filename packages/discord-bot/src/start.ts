/**
 * Composition root (Fase 1): db → config → sessions → gateway.
 *
 * Secrets come from the environment only (DISCORD_TOKEN); everything else
 * lives in SQLite with code defaults. No YAML, no Postgres, no vectors.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { ConfigStore, secret } from "./config.ts";
import { openDatabase } from "./db.ts";
import { DiscordGateway } from "./gateway.ts";
import { roleOf } from "./roles.ts";
import { ChannelSessions, piSessionFactory } from "./sessions.ts";

export interface StartOptions {
	dbPath: string;
	cwd?: string;
}

export async function startBot(options: StartOptions): Promise<() => Promise<void>> {
	// Secrets live in packages/discord-bot/.env (gitignored) — never in SQLite.
	loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });
	const db = openDatabase(options.dbPath);
	const config = new ConfigStore(db);
	const sessions = new ChannelSessions(piSessionFactory(options.cwd ?? process.cwd()));

	const gateway = new DiscordGateway(
		() => config.all(),
		async (channelId, authorId, text) => {
			const role = roleOf(authorId, config.all());
			return sessions.ask(channelId, role, text);
		},
		undefined,
		(tag) => console.log(`logado no Discord como ${tag}`),
	);

	const token = secret("DISCORD_TOKEN");
	if (!token) throw new Error("DISCORD_TOKEN não definido no ambiente");

	await gateway.start(token);

	let stopping = false;
	return async () => {
		if (stopping) return;
		stopping = true;
		config.dispose();
		await gateway.stop();
		sessions.dispose();
		db.close();
	};
}
