#!/usr/bin/env node
/**
 * Seed the bot database from a JSON file (one-time import, idempotent).
 *
 * Usage:
 *   node scripts/seed.mjs <seed.json> <bot.db>
 *
 * The JSON maps config sections (discord, chat, bot, memory, judge) to
 * objects. Re-running overwrites the same keys — safe to repeat.
 */
import { readFileSync } from "node:fs";
import { ConfigStore } from "../dist/config.js";
import { openDatabase } from "../dist/db.js";

const [seedPath, dbPath] = process.argv.slice(2);
if (!seedPath || !dbPath) {
	console.error("usage: node scripts/seed.mjs <seed.json> <bot.db>");
	process.exit(1);
}

const seed = JSON.parse(readFileSync(seedPath, "utf-8"));
const db = openDatabase(dbPath);
const config = new ConfigStore(db);
for (const [section, value] of Object.entries(seed)) {
	config.set(section, value);
	console.log(`seeded ${section}`);
}
config.dispose();
db.close();
