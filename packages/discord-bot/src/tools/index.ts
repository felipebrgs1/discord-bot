/**
 * Custom tools do bot (port das tools do Go): registradas por sessão com
 * o channelId amarrado. user-safe por padrão — o que for sensível nem
 * entra na lista de user (roles.ts já barra as nativas).
 */

import type { DatabaseSync } from "node:sqlite";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Role } from "../roles.ts";
import type { LogBuffer } from "../weblog.ts";
import { searchHistoryTool } from "./history.ts";
import { downloadMediaTool } from "./media.ts";
import { webFetchTool, webSearchTool } from "./web.ts";

/** Resposta de texto simples p/ tools (details vazio). */
export function textResult(text: string): {
	content: [{ type: "text"; text: string }];
	details: Record<string, never>;
} {
	return { content: [{ type: "text", text }], details: {} };
}

export interface ToolCtx {
	channelId: string;
	db: DatabaseSync;
	log: LogBuffer;
	outboxDir: string;
}

/** Tools de user: pesquisa, mídia, histórico. Admin ganha as nativas (roles.ts) + estas. */
export function toolsFor(_role: Role, ctx: ToolCtx): ToolDefinition[] {
	return [webSearchTool(), webFetchTool(), downloadMediaTool(ctx), searchHistoryTool(ctx)];
}
