/**
 * Telemetria do bot (Fase web/métricas): cada turno do agente vira uma
 * linha em ai_requests. Tokens/custo vêm de getSessionStats() do SDK
 * (delta antes/depois do turno) — sem chute, sem tabela de preço.
 */

import type { DatabaseSync } from "node:sqlite";

export interface TurnReport {
	operation: string;
	model: string;
	provider: string;
	source: string;
	status: "success" | "error";
	latency_ms: number;
	input_tokens: number | null;
	output_tokens: number | null;
	cost: number | null;
}

export function recordTurn(db: DatabaseSync, r: TurnReport): void {
	try {
		db.prepare(
			`INSERT INTO ai_requests
       (operation, model, provider, source, status, latency_ms,
        input_tokens, output_tokens, cost)
       VALUES (?,?,?,?,?,?,?,?,?);`,
		).run(
			r.operation,
			r.model,
			r.provider,
			r.source,
			r.status,
			Math.round(r.latency_ms),
			r.input_tokens,
			r.output_tokens,
			r.cost,
		);
	} catch {
		/* telemetria nunca quebra resposta */
	}
}

export interface StatsTotals {
	input: number;
	output: number;
	cost: number;
}

export function statsOf(session: unknown): StatsTotals | null {
	try {
		const s = session as { getSessionStats?: () => unknown };
		if (typeof s.getSessionStats !== "function") return null;
		const stats = s.getSessionStats() as {
			tokens?: { input?: unknown; output?: unknown };
			cost?: unknown;
		};
		const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		return {
			input: num(stats.tokens?.input),
			output: num(stats.tokens?.output),
			cost: num(stats.cost),
		};
	} catch {
		return null;
	}
}
