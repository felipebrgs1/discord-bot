#!/usr/bin/env node
/**
 * Run the Discord bot: `node dist/run.js`.
 * DB path via BOT_DB env (default: ./data/bot.db next to the package).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBot } from "./index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env["BOT_DB"] ?? join(root, "data", "bot.db");

const stop = await startBot({ dbPath, cwd: process.cwd() });
console.log(`discord-bot online (db=${dbPath})`);

const shutdown = async (signal: string) => {
	console.log(`recebido ${signal}, desligando...`);
	await stop();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
