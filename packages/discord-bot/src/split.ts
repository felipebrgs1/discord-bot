/** Split long replies into Discord-safe chunks (Fase 1). */

export const DISCORD_MAX_LENGTH = 2000;

/** Split on newline boundaries when possible, hard-cut otherwise. */
export function splitMessage(text: string, maxLength = DISCORD_MAX_LENGTH): string[] {
	if (text.length <= maxLength) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > maxLength) {
		let cut = rest.lastIndexOf("\n", maxLength);
		if (cut <= 0) cut = maxLength;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}
