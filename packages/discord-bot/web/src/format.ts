import type { MetricRecord, MetricStats } from "./api"

const fmt1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat("pt-BR")
export const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 })
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})

export const num = (x: number | null | undefined) => (x == null ? "—" : integer.format(x))
export const dec = (x: number | null | undefined) => (x == null ? "—" : fmt1.format(x))
export const cost = (x: number | null | undefined) => (x == null ? "—" : money.format(x))
export const percent = (n: number | null | undefined) => (n == null ? "—" : `${fmt1.format(n)}%`)

export function latency(x: number | null | undefined): string {
  if (x == null) return "—"
  return x >= 1000 ? `${fmt1.format(x / 1000)} s` : `${fmt1.format(x)} ms`
}

export const timeOnly = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR")
export const dateShort = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })
export const dateTime = (iso: string) => new Date(iso).toLocaleString("pt-BR")

export const operationLabel: Record<string, string> = {
  chat: "Conversa",
  memory: "Memória",
  embedding: "Embedding",
  rerank: "Rerank",
  judge: "Jev",
}

export const sourceLabel: Record<string, string> = {
  discord: "Discord",
  web: "Web",
  cli: "Terminal",
}

export function cacheRatio(s: MetricStats): number | null {
  return s.cache_input_tokens != null && s.cache_input_tokens > 0 && s.cache_matched_tokens != null
    ? (s.cache_matched_tokens / s.cache_input_tokens) * 100
    : null
}

export function effectiveTPS(r: MetricRecord): number | null {
  return r.success && (r.operation === "chat" || r.operation === "memory") && r.output_tokens != null && r.duration_ms > 0
    ? r.output_tokens / (r.duration_ms / 1000)
    : null
}
