/** Outbox: tools largam arquivos em outbox/<canal>/; o gateway envia e apaga. */

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export function outboxDirFor(base: string, channelId: string): string {
	return join(base, channelId.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

/** Lista arquivos pendentes do canal (sem subdirs). */
export async function pendingAttachments(base: string, channelId: string): Promise<string[]> {
	const dir = outboxDirFor(base, channelId);
	const names = await readdir(dir).catch(() => []);
	const out: string[] = [];
	for (const n of names) {
		if (n.startsWith(".")) continue;
		out.push(join(dir, n));
	}
	return out;
}

export async function discard(path: string): Promise<void> {
	await rm(path, { force: true });
}
