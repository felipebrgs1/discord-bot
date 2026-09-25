/**
 * Composition root: db → config → sessions → gateway (+ dashboard).
 *
 * Secrets come from the environment only (DISCORD_TOKEN, optional
 * DASHBOARD_PASSWORD); everything else lives in SQLite with code defaults.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { ConfigStore, secret } from "./config.ts";
import { openDatabase } from "./db.ts";
import { DiscordGateway } from "./gateway.ts";
import { recordTurn } from "./metrics.ts";
import { roleOf } from "./roles.ts";
import { ChannelSessions, piSessionFactory } from "./sessions.ts";
import { startDashboard } from "./webapi.ts";
import { LogBuffer } from "./weblog.ts";

export interface StartOptions {
	dbPath: string;
	cwd?: string;
	/** Porta do painel; 0 = desligado. Padrão: DASHBOARD_PORT ou 8080. */
	dashboardPort?: number;
	dashboardHost?: string;
	/** Diretório com o build do front (web/dist). */
	webDir?: string;
}

export async function startBot(options: StartOptions): Promise<() => Promise<void>> {
	// Secrets live in packages/discord-bot/.env (gitignored) — never in SQLite.
	loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

	const log = new LogBuffer();
	const emit = (msg: string, attrs?: Record<string, unknown>): void => log.log("info", msg, attrs);
	const db = openDatabase(options.dbPath);
	const config = new ConfigStore(db);
	const sessions = new ChannelSessions(piSessionFactory(options.cwd ?? process.cwd()));

	const gateway = new DiscordGateway(
		() => config.all(),
		async (channelId, authorId, text) => {
			const settings = config.all();
			const role = roleOf(authorId, settings);
			return sessions.ask(channelId, role, text, {
				source: "discord",
				model: settings.chat.model,
				onTurn: (r) => recordTurn(db, r),
			});
		},
		undefined,
		(tag) => log.log("info", `logado no Discord como ${tag}`),
		emit,
	);

	const token = secret("DISCORD_TOKEN");
	if (!token) throw new Error("DISCORD_TOKEN não definido no ambiente");

	await gateway.start(token);

	const port = options.dashboardPort ?? (process.env["DASHBOARD_PORT"] ? Number(process.env["DASHBOARD_PORT"]) : 8080);
	let server: { close(cb?: () => void): void } | undefined;
	if (port > 0) {
		const root = join(dirname(fileURLToPath(import.meta.url)), "..");
		server = startDashboard(
			{
				db,
				config,
				sessions,
				log,
				webDir: options.webDir ?? join(root, "web", "dist"),
				password: secret("DASHBOARD_PASSWORD"),
			},
			port,
			options.dashboardHost ?? "127.0.0.1",
		);
		log.log("info", `painel em http://127.0.0.1:${port}`);
	}

	let stopping = false;
	return async () => {
		if (stopping) return;
		stopping = true;
		config.dispose();
		await gateway.stop();
		sessions.dispose();
		if (server) await new Promise<void>((r) => server?.close(() => r()));
		db.close();
	};
}
