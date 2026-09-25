/**
 * download_media (port de internal/agent/media.go): yt-dlp → outbox do
 * canal. O gateway envia como anexo e apaga (outbox.ts).
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { outboxDirFor } from "../outbox.ts";
import { type ToolCtx, textResult } from "./index.ts";
import { guardSSRF } from "./net.ts";

const SUPPORTED = ["x.com", "twitter.com", "tiktok.com", "instagram.com", "twitch.tv", "kick.com"];
const EXPLICIT_NO = [
	"youtu.be",
	"youtube.com",
	"facebook.com",
	"fb.watch",
	"reddit.com",
	"redd.it",
	"vimeo.com",
	"dailymotion.com",
	"soundcloud.com",
	"threads.net",
	"snapchat.com",
	"pinterest.com",
	"streamable.com",
];

function hostAllowed(host: string): boolean {
	const h = host.toLowerCase().split(":")[0] as string;
	return SUPPORTED.some((d) => h === d || h.endsWith(`.${d}`));
}

function unsupportedReason(host: string): string {
	const h = host.toLowerCase().split(":")[0] as string;
	if (EXPLICIT_NO.some((d) => h === d || h.endsWith(`.${d}`))) {
		return `só tenho suporte pra X/Twitter, TikTok, Instagram, Twitch e Kick; ${h} não dá pra baixar daqui`;
	}
	return "";
}

function findYtDlp(): string {
	if (process.env["YTDLP_BIN"]) return process.env["YTDLP_BIN"];
	// Instalado pelo setup do bot Go; YTDLP_BIN tem precedência.
	return "/home/ubuntu/bot/botdiscord/bin/yt-dlp";
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
			const out = `${stdout}${stderr}`.trim();
			if (err) resolve({ ok: false, out: out || err.message });
			else resolve({ ok: true, out });
		});
	});
}

async function compressToFit(path: string, maxBytes: number): Promise<void> {
	const durOut = await run(
		"ffprobe",
		["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
		30_000,
	);
	const dur = Number.parseFloat(durOut.out.trim());
	if (!durOut.ok || !Number.isFinite(dur) || dur <= 0) throw new Error("duração ilegível");
	const target = maxBytes * 0.92;
	const out = `${path}.fit.mp4`;
	for (const [height, audio] of [
		[720, 96],
		[480, 64],
	] as const) {
		const videoK = Math.max(150, Math.floor((target * 8) / dur / 1000 - audio));
		await rm(out, { force: true });
		const r = await run(
			"ffmpeg",
			[
				"-y",
				"-hide_banner",
				"-loglevel",
				"error",
				"-i",
				path,
				"-vf",
				`scale=-2:min(${height},ih)`,
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-b:v",
				`${videoK}k`,
				"-maxrate",
				`${videoK}k`,
				"-bufsize",
				`${videoK * 2}k`,
				"-c:a",
				"aac",
				"-b:a",
				`${audio}k`,
				"-movflags",
				"+faststart",
				out,
			],
			4 * 60_000,
		);
		if (!r.ok) continue;
		const st = await stat(out).catch(() => null);
		if (st && st.size <= maxBytes) {
			await rm(path, { force: true });
			await rename(out, path);
			return;
		}
	}
	await rm(out, { force: true });
	throw new Error("não coube nem comprimido");
}

export function downloadMediaTool(ctx: ToolCtx): ToolDefinition {
	const MAX_BYTES = 20 << 20;
	return defineTool({
		name: "download_media",
		label: "Baixar mídia",
		description:
			"Baixa vídeo de X/Twitter, TikTok, Instagram, Twitch ou Kick por URL e ENVIA como anexo ao canal automaticamente. OUTRAS PLATAFORMAS (YouTube, Facebook, Vimeo...) não têm suporte — avise antes de tentar.",
		parameters: Type.Object({
			url: Type.String({ description: "URL do vídeo" }),
		}),
		async execute(_id, params) {
			const raw = (params.url ?? "").trim();
			let u: URL;
			try {
				u = new URL(raw);
			} catch {
				return textResult("erro: só aceito URL http/https");
			}
			if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.host) {
				return textResult("erro: só aceito URL http/https");
			}
			if (!hostAllowed(u.host)) {
				const reason = unsupportedReason(u.host);
				return textResult(`erro: ${reason || "plataforma sem suporte"}`);
			}
			try {
				await guardSSRF(u.host);
			} catch (err) {
				return textResult(`erro: ${err instanceof Error ? err.message : String(err)}`);
			}
			const dir = outboxDirFor(ctx.outboxDir, ctx.channelId);
			try {
				await mkdir(dir, { recursive: true });
			} catch (err) {
				return textResult(`erro: ${err instanceof Error ? err.message : String(err)}`);
			}
			const started = Date.now();
			const r = await run(
				findYtDlp(),
				[
					"--no-playlist",
					"--merge-output-format",
					"mp4",
					"--max-filesize",
					String(MAX_BYTES),
					"-o",
					join(dir, "%(id)s.%(ext)s"),
					"--",
					u.toString(),
				],
				5 * 60_000,
			);
			if (!r.ok) {
				ctx.log.log("error", "media_download_failed", { url: raw.slice(0, 120), out: r.out.slice(0, 500) });
				return textResult(`erro no download: ${r.out.slice(0, 2000)}`);
			}
			const got: string[] = [];
			const big: string[] = [];
			for (const name of await readdir(dir)) {
				const path = join(dir, name);
				const st = await stat(path).catch(() => null);
				if (!st || st.isDirectory() || st.mtimeMs < started - 1000) continue;
				if (st.size > MAX_BYTES) {
					try {
						await compressToFit(path, MAX_BYTES);
						const after = await stat(path);
						got.push(
							`${name} (comprimido de ${(st.size / 1048576).toFixed(1)} MB p/ ${(after.size / 1048576).toFixed(1)} MB)`,
						);
					} catch (err) {
						await rm(path, { force: true });
						big.push(
							`${name} (${(st.size / 1048576).toFixed(1)} MB, não coube: ${err instanceof Error ? err.message : String(err)})`,
						);
					}
					continue;
				}
				got.push(`${name} (${st.size} bytes)`);
			}
			if (big.length > 0 && got.length === 0) {
				return textResult(`erro: vídeo grande demais — ${big.join(", ")}; o teto de anexo aqui é 20 MB`);
			}
			if (got.length === 0) return textResult(`erro: download terminou mas nenhum arquivo novo apareceu`);
			let msg = `ok: baixado ${got.join(", ")}`;
			if (big.length > 0) msg += `; descartei por tamanho: ${big.join(", ")}`;
			return textResult(`${msg}. O arquivo será enviado ao canal como anexo.`);
		},
	});
}
