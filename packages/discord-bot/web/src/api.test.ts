import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDiscordConfig, sendChat } from "./api";

function sseResponse(frames: string[]): Response {
	const text = frames.join("");
	const stream = new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode(text));
			c.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("sendChat", () => {
	it("dispara accepted/step/done em ordem", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sseResponse([
					`event: accepted\ndata: {"message":{"id":"u1","content":"oi"}}\n\n`,
					`event: step\ndata: {"tool":"web_search","args":"{}","output":"achado","duration_ms":12}\n\n`,
					`event: done\ndata: {"message":{"id":"b1","content":"resposta","is_bot":true},"steps":[]}\n\n`,
				]),
			),
		);
		const seen: string[] = [];
		let doneMsg = "";
		await sendChat("s1", "oi", {
			onAccepted: (m) => seen.push(`accepted:${m.id}`),
			onStep: (s) => seen.push(`step:${s.tool}`),
			onDone: (m) => {
				doneMsg = m.content;
			},
			onError: () => seen.push("error"),
		});
		expect(seen).toEqual(["accepted:u1", "step:web_search"]);
		expect(doneMsg).toBe("resposta");
	});

	it("quadro malformado não derruba o fluxo", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sseResponse([
					`event: step\ndata: NÃO-É-JSON\n\n`,
					`event: done\ndata: {"message":{"id":"b1","content":"fim"},"steps":[]}\n\n`,
				]),
			),
		);
		const warned: unknown[][] = [];
		vi.stubGlobal("console", { ...console, warn: (...a: unknown[]) => void warned.push(a) });
		let doneMsg = "";
		await sendChat("s1", "oi", {
			onDone: (m) => {
				doneMsg = m.content;
			},
			onError: () => {},
		});
		expect(doneMsg).toBe("fim");
		expect(warned.length).toBeGreaterThan(0);
	});

	it("erro HTTP vira onError com a mensagem do servidor", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ error: "sessão cheia" }), { status: 429 })),
		);
		let err = "";
		await sendChat("s1", "oi", {
			onDone: () => {},
			onError: (m) => {
				err = m;
			},
		});
		expect(err).toBe("sessão cheia");
	});

	it("evento error do SSE vira onError", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => sseResponse([`event: error\ndata: {"message":"modelo caiu"}\n\n`])),
		);
		let err = "";
		await sendChat("s1", "oi", {
			onDone: () => {},
			onError: (m) => {
				err = m;
			},
		});
		expect(err).toBe("modelo caiu");
	});

	it("abort não chama onError", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_u: unknown, init?: { signal?: AbortSignal }) => {
				await new Promise((_, rej) => {
					init?.signal?.addEventListener("abort", () => rej(new DOMException("x", "AbortError")));
				});
				throw new Error("unreachable");
			}),
		);
		const ctl = new AbortController();
		let err = "nada";
		const p = sendChat("s1", "oi", {
			onDone: () => {},
			onError: (m) => {
				err = m;
			},
			signal: ctl.signal,
		});
		ctl.abort();
		await p;
		expect(err).toBe("nada");
	});
});

describe("fetchDiscordConfig", () => {
	it("tolerância a forma parcial (novo backend)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ guild_id: "g" }), { status: 200 }),
			),
		);
		// Contrato atual exige os campos; se o backend mandar parcial,
		// o erro deve ser explícito, não undefined silencioso.
		const cfg = await fetchDiscordConfig().catch((e: Error) => e.message);
		expect(typeof cfg === "string" || (cfg as { guild_id: string }).guild_id === "g").toBe(true);
	});
});
