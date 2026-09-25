# @earendil-works/discord-bot

Discord bot built on the pi harness. Phase 0: SQLite storage + config.

- `src/db.ts` — `openDatabase()` + versioned migrations (WAL, FTS5, nullable `embedding` reserved for future sqlite-vec).
- `src/config.ts` — `ConfigStore` (SQLite-backed, defaults in code, secrets via env only) + hot-reload `subscribe()`.
- `src/index.ts` — public re-exports.

```bash
npm run build   # tsc -p tsconfig.build.json
npm run test    # vitest --run (src/**/*.test.ts)
```
