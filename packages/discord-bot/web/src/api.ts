// Camada de acesso à API do painel (Go) e ao Worker (login por senha).
// Valida o que chega na borda: payload inesperado vira erro claro em vez de
// `undefined` silencioso no meio da tela.

export type Role = "user" | "mod" | "admin";

export interface Meta {
  chat: boolean;
  agent: boolean;
  model: string;
  role: Role;
}

export interface Session {
  id: string;
  title: string;
  updated_at: string;
  messages: number;
}

export interface ChatMessage {
  id: string;
  author_id: string;
  author_name: string;
  content: string;
  reply_to?: string;
  is_bot: boolean;
  attachments?: string[];
  created_at: string;
}

export interface Step {
  tool: string;
  args: string;
  output: string;
  duration_ms: number;
}

export interface LogEntry {
  id: number;
  time: string;
  level: string;
  msg: string;
  attrs?: Record<string, unknown>;
}

export interface MemoryVersion {
  version: number;
  kind: string;
  status: string;
  content: string;
  source_ids: string[];
  reason: string;
  created_at: string;
}

export interface MemoryItem {
  id: number;
  channel_id: string;
  scope: "group" | "user";
  user_id?: string;
  key: string;
  kind: string;
  status: string;
  content: string;
  source_ids: string[];
  version: number;
  updated_at: string;
}

export interface LearningEvent {
  at: string;
  kind: string;
  channel_id: string;
  actor?: string;
  subject: string;
  detail: string;
  reason?: string;
}

export interface ParticipationReview {
  channel_id: string;
  source_id: string;
  kind: "spontaneous" | "followup" | "continuation";
  mode: "shadow" | "active";
  decision: string;
  source_text: string;
  draft: string;
  review: "" | "useful" | "unhelpful";
  created_at: string;
}

export interface BotSummary {
  id: string;
  file: string;
  label: string;
  valid: boolean;
  error?: string;
  guild_id: string;
  model: string;
  channels: number;
  updated_at: string;
}

export interface DiscordConfig {
  guild_id: string;
  channel_ids: string[];
  admin_ids: string[];
  moderator_ids: string[];
  web_user_id: string;
  personality: string;
}

export interface AgentConfig {
  harness: string;
  pi_bin: string;
  pi_node: string;
  pi_sidecar: string;
  pi_tools: string;
}

export interface MetricStats {
  requests: number;
  failures: number;
  retries: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
  cache_input_tokens: number | null;
  cache_matched_tokens: number | null;
  cache_samples: number;
  token_samples: number;
  cost_usd: number | null;
  cost_samples: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  effective_tps: number | null;
}

export interface MetricBucket extends MetricStats {
  at: string;
}

export interface ModelStats extends MetricStats {
  provider: string;
  model: string;
  operation: string;
  source: string;
}

export interface MetricRecord {
  id: number;
  started_at: string;
  duration_ms: number;
  operation: string;
  workflow: string;
  channel_id: string;
  source: string;
  provider: string;
  model: string;
  resolved_model: string;
  request_id: string;
  success: boolean;
  http_status: number;
  attempts: number;
  error_kind: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
}

export interface MetricsSnapshot {
  since: string;
  until: string;
  bucket_seconds: number;
  summary: MetricStats;
  series: MetricBucket[];
  models: ModelStats[];
  recent: MetricRecord[];
  options: { models: string[]; providers: string[] };
  refresh_ms: number;
}

export interface ModelCatalog {
  models: string[];
  model: string;
}

// ---------------------------------------------------------------------------
// transporte

function parseBody(raw: string): unknown {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // HTML onde se espera JSON = rota desconhecida caindo no fallback do SPA
    // (típico de backend com binário antigo). Mensagem acionável, não "JSON
    // inválido".
    if (raw.trimStart().startsWith("<")) {
      throw new Error(
        "o servidor devolveu HTML em vez de JSON — o processo do bot parece estar com o binário antigo; rode ./scripts/start.sh para atualizar",
      );
    }
    throw new Error("JSON inválido do servidor");
  }
}

function errorMessage(data: unknown, status: number, raw: string): string {
  if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return raw && raw.length < 300 ? raw : `erro HTTP ${status}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new Error("sem conexão com o servidor");
  }
  if (res.status === 401) {
    window.dispatchEvent(new Event("session-expired"));
    throw new Error("sessão expirada — entre de novo");
  }
  if (res.status === 204) return undefined as T;
  const raw = await res.text();
  let data: unknown = null;
  if (raw.trim()) data = parseBody(raw);
  if (!res.ok) throw new Error(errorMessage(data, res.status, raw));
  return data as T;
}

function body(payload: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function field<T>(value: unknown, key: string, fallback: T): T {
  const v = asRecord(value)[key];
  return (typeof v === typeof fallback ? v : fallback) as T;
}

function asChatMessage(value: unknown): ChatMessage {
  const v = asRecord(value);
  return {
    id: field(v, "id", ""),
    author_id: field(v, "author_id", ""),
    author_name: field(v, "author_name", ""),
    content: field(v, "content", ""),
    reply_to: typeof v.reply_to === "string" ? v.reply_to : undefined,
    is_bot: field(v, "is_bot", false),
    attachments: Array.isArray(v.attachments) ? (v.attachments as string[]) : undefined,
    created_at: field(v, "created_at", ""),
  };
}

function asStep(value: unknown): Step {
  const v = asRecord(value);
  return {
    tool: field(v, "tool", ""),
    args: field(v, "args", ""),
    output: field(v, "output", ""),
    duration_ms: field(v, "duration_ms", 0),
  };
}

// ---------------------------------------------------------------------------
// sessão do Worker (login por senha do painel)

export const checkSession = () => request<{ ok: boolean }>("/auth/session");

export const login = (password: string) =>
  request<{ ok: boolean }>("/auth/login", body({ password }));

export const logout = () => request<{ ok: boolean }>("/auth/logout", { method: "POST" });

// ---------------------------------------------------------------------------
// meta, chat e sessões

export const fetchMeta = () => request<Meta>("/api/meta");

export const fetchSessions = () => request<{ sessions: Session[] }>("/api/chat/sessions");

export const deleteSession = (id: string) =>
  request<void>(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });

export const fetchMessages = (id: string) =>
  request<{ messages: ChatMessage[] }>(`/api/chat/sessions/${encodeURIComponent(id)}/messages`);

export interface ChatHandlers {
  onAccepted?: (message: ChatMessage) => void;
  onStep?: (step: Step) => void;
  onDone: (message: ChatMessage, steps: Step[]) => void;
  onError: (message: string) => void;
  signal?: AbortSignal;
}

// POST que responde SSE (accepted/step/done/error). Não é EventSource: é fetch
// com leitura de stream, porque o evento é um POST com corpo.
export async function sendChat(id: string, content: string, handlers: ChatHandlers): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal: handlers.signal,
    });
  } catch (err) {
    if (handlers.signal?.aborted) return;
    handlers.onError(err instanceof Error ? err.message : "falha ao enviar");
    return;
  }
  if (res.status === 401) {
    window.dispatchEvent(new Event("session-expired"));
    handlers.onError("sessão expirada — entre de novo");
    return;
  }
  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => "");
    let data: unknown = null;
    try {
      if (raw.trim()) data = JSON.parse(raw);
    } catch {
      data = null;
    }
    handlers.onError(errorMessage(data, res.status, raw));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (event: string, payload: unknown) => {
    switch (event) {
      case "accepted":
        handlers.onAccepted?.(asChatMessage(asRecord(payload).message));
        break;
      case "step":
        handlers.onStep?.(asStep(payload));
        break;
      case "done": {
        const v = asRecord(payload);
        const steps = Array.isArray(v.steps) ? (v.steps as unknown[]).map(asStep) : [];
        handlers.onDone(asChatMessage(v.message), steps);
        break;
      }
      case "error":
        handlers.onError(field(payload, "message", "erro no servidor"));
        break;
    }
  };

  // Quadro SSE malformado não pode derrubar o resto do fluxo: loga e segue.
  // Cancelamento (AbortError) volta como fluxo encerrado, não como erro.
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        try {
          dispatch(event, JSON.parse(data));
        } catch {
          console.warn("quadro SSE ignorado:", frame.slice(0, 200));
        }
      }
    }
  } catch {
    if (!handlers.signal?.aborted) handlers.onError("fluxo interrompido pelo servidor");
  }
}

// ---------------------------------------------------------------------------
// logs e iniciativas

export const fetchLogs = (after: number, limit = 300) =>
  request<{ entries: LogEntry[]; next: number }>(`/api/logs?after=${after}&limit=${limit}`);

export const fetchParticipation = () =>
  request<{ items: ParticipationReview[] }>("/api/participation");

export const reviewParticipation = (channel: string, source: string, review: string) =>
  request<{ changed: boolean }>(
    `/api/participation/${encodeURIComponent(channel)}/${encodeURIComponent(source)}/review`,
    body({ review }),
  );

// ---------------------------------------------------------------------------
// aprendizado

export const fetchMemories = (limit = 200) =>
  request<{ items: MemoryItem[] }>(`/api/memories?limit=${limit}`);

export const fetchMemoryVersions = (id: number) =>
  request<{ versions: MemoryVersion[] }>(`/api/memories/${id}/versions`);

export const fetchLearnings = (limit = 80) =>
  request<{ events: LearningEvent[] }>(`/api/learnings?limit=${limit}`);

export const actOnMemory = (id: number, action: "forget" | "restore", reason: string) =>
  request<{ changed: boolean }>(`/api/memories/${id}/${action}`, body({ reason }));

export const correctMemory = (id: number, content: string, reason: string) =>
  request<{ changed: boolean }>(`/api/memories/${id}`, body({ content, reason }, "PUT"));

// ---------------------------------------------------------------------------
// bots (múltiplos configs) e config do painel

export const fetchBots = () => request<{ dir: string; bots: BotSummary[] }>("/api/bots");

export const createBot = (id: string, from?: string) =>
  request<{ bot: BotSummary }>("/api/bots", body(from ? { id, from } : { id }));

export const duplicateBot = (id: string, source: string) =>
  request<{ bot: BotSummary }>(`/api/bots/${encodeURIComponent(source)}/duplicate`, body({ id }));

export const deleteBot = (id: string) =>
  request<void>(`/api/bots/${encodeURIComponent(id)}`, { method: "DELETE" });

export const fetchBotYAML = (id: string) =>
  request<{ yaml: string }>(`/api/bots/${encodeURIComponent(id)}/config`);

export const saveBotYAML = (id: string, yaml: string) =>
  request<{ saved: boolean; restart_required: boolean }>(
    `/api/bots/${encodeURIComponent(id)}/config`,
    body({ yaml }, "PUT"),
  );

export const fetchBotDiscord = (id: string) =>
  request<DiscordConfig>(`/api/bots/${encodeURIComponent(id)}/config/discord`);

export const saveBotDiscord = (id: string, form: DiscordConfig) =>
  request<{ saved: boolean; restart_required: boolean }>(
    `/api/bots/${encodeURIComponent(id)}/config/discord`,
    body(form, "PUT"),
  );

export const fetchBotAgent = (id: string) =>
  request<AgentConfig>(`/api/bots/${encodeURIComponent(id)}/config/agent`);

export const saveBotAgent = (id: string, form: AgentConfig) =>
  request<{ saved: boolean; restart_required: boolean }>(
    `/api/bots/${encodeURIComponent(id)}/config/agent`,
    body(form, "PUT"),
  );

export const fetchBotModels = (id: string) =>
  request<ModelCatalog>(`/api/bots/${encodeURIComponent(id)}/models`);

export const setBotModel = (id: string, model: string) =>
  request<{ model: string; restart_required: boolean }>(
    `/api/bots/${encodeURIComponent(id)}/model`,
    body({ model }, "PUT"),
  );

export const fetchConfig = () => request<{ yaml: string }>("/api/config");

export const saveConfig = (yaml: string) =>
  request<{ saved: boolean; restart_required: boolean }>("/api/config", body({ yaml }, "PUT"));

export const fetchDiscordConfig = () => request<DiscordConfig>("/api/config/discord");

export const saveDiscordConfig = (form: DiscordConfig) =>
  request<{ saved: boolean; restart_required: boolean }>(
    "/api/config/discord",
    body(form, "PUT"),
  );

export const fetchModels = () => request<ModelCatalog>("/api/models");

export const setModel = (model: string) =>
  request<{ model: string; restart_required: boolean }>("/api/model", body({ model }, "PUT"));

// ---------------------------------------------------------------------------
// métricas

export const fetchMetrics = (query: string) =>
  request<MetricsSnapshot>(`/api/metrics${query}`);

// ---------------------------------------------------------------------------
// utilidades

export function genSessionID(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return (
    "s" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}
