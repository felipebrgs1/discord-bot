/**
 * Rede p/ tools (port de internal/agent/web.go): fetch com UA de browser,
 * guarda SSRF (bloqueia alvo interno) e HTML→texto legível.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const BROWSER_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export async function fetchText(url: string, maxBytes = 2 << 20): Promise<{ status: number; text: string }> {
	const res = await fetch(url, {
		headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,text/plain" },
		signal: AbortSignal.timeout(20_000),
	});
	const buf = await res.arrayBuffer();
	return { status: res.status, text: new TextDecoder().decode(buf.slice(0, maxBytes)) };
}

export async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url, {
		headers: { "User-Agent": BROWSER_UA },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return (await res.json()) as T;
}

/** Bloqueia destinos internos (metadata cloud, rede local) — igual ao Go. */
export async function guardSSRF(host: string): Promise<void> {
	if (process.env["AGENT_ALLOW_PRIVATE"] === "1") return;
	const h = host.toLowerCase().split(":")[0] as string;
	if (h === "localhost" || h === "metadata.google.internal" || h.endsWith(".internal")) {
		throw new Error("destino interno bloqueado");
	}
	let addrs;
	try {
		addrs = await lookup(h);
	} catch {
		throw new Error(`DNS falhou para ${host}`);
	}
	for (const a of Array.isArray(addrs) ? addrs : [addrs]) {
		if (isPrivate(a.address)) throw new Error("destino interno bloqueado");
	}
}

function isPrivate(ip: string): boolean {
	if (!isIP(ip)) return true;
	if (ip.includes(":")) {
		const l = ip.toLowerCase();
		return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
	}
	const p = ip.split(".").map(Number);
	if (p[0] === 10) return true;
	if (p[0] === 127) return true;
	if (p[0] === 169 && p[1] === 254) return true;
	if (p[0] === 172 && p[1] !== undefined && p[1] >= 16 && p[1] <= 31) return true;
	if (p[0] === 192 && p[1] === 168) return true;
	if (p[0] === 0) return true;
	return false;
}

export function htmlToText(page: string, minLine = 40): { title: string; text: string } {
	const title = /<title[^>]*>(.*?)<\/title>/is.exec(page)?.[1] ?? "";
	const cleanTitle = unescapeHtml(title.replace(/<[^>]+>/g, "").trim());
	let text = page.replace(/<(script|style|noscript)[^>]*>.*?<\/\1>/gis, " ").replace(/<[^>]+>/g, " ");
	text = unescapeHtml(text);
	const kept = text
		.split("\n")
		.map((l) => l.replace(/[ \t ]+/g, " ").trim())
		.filter((l) => l.length > minLine);
	text = kept.join("\n").replace(/\n{3,}/g, "\n\n");
	return { title: cleanTitle, text };
}

function unescapeHtml(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}
