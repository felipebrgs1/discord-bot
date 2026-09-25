/**
 * Papéis (2): admin (dono) e user (todo o resto).
 *
 * user: só as tools construídas pro bot (pesquisa web, mídia, histórico,
 * skills de consulta...). NADA de shell, NADA de arquivo, NADA que
 * modifique o bot — nem ler: arquivo local é superfície de vazamento.
 * admin: tudo.
 *
 * A negação acontece na criação da sessão (excludeTools); se o papel
 * mudar, a sessão é recriada (sessions.ts) para a allowlist valer.
 * Limitação conhecida: dentro do SDK não há segundo nível de enforcement
 * na execução como havia no loop custom do Go — a sessão carrega só as
 * tools do papel, e sessão de user nunca recebe tool sensível.
 */

import type { BotSettings } from "./config.ts";

export type Role = "admin" | "user";

export function roleOf(userId: string, settings: BotSettings): Role {
	if (userId !== "" && settings.discord.admin_ids.includes(userId)) return "admin";
	return "user";
}

/** Tools nativas do pi (arquivo + shell). Custom tools do bot são user-safe por padrão. */
const NATIVE_SENSITIVE = ["bash", "powershell", "edit", "write", "read", "grep", "find", "ls"];

/** Tools bloqueadas por papel (deny-list p/ createAgentSession). */
export function excludedToolsFor(role: Role): string[] {
	switch (role) {
		case "admin":
			return [];
		case "user":
			return [...NATIVE_SENSITIVE];
	}
}
