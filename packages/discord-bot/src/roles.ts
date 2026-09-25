/**
 * Roles (Fase 1) — same matrix as the Go bot: admin > mod > user.
 * The Discord user id is the identity; the lists come from ConfigStore.
 */

import type { BotSettings } from "./config.ts";

export type Role = "admin" | "mod" | "user";

export function roleOf(userId: string, settings: BotSettings): Role {
	if (settings.discord.admin_ids.includes(userId)) return "admin";
	if (settings.discord.moderator_ids.includes(userId)) return "mod";
	return "user";
}

/**
 * Native pi tools visible per role.
 * user: read-only + web-ish tools (no shell, no writes).
 * mod: + read_file-ish access (pi's `read`).
 * admin: everything (bash, edit, write).
 *
 * Expressed as excludeTools for createAgentSession (deny-list after
 * the default allowlist), so new pi tools default to visible and we
 * only lock down the dangerous ones.
 */
export function excludeToolsFor(role: Role): string[] {
	switch (role) {
		case "admin":
			return [];
		case "mod":
			return ["bash", "edit", "write"];
		case "user":
			return ["bash", "edit", "write"];
	}
}
