import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { cn } from "cn"
import { AlertCircleIcon, ArrowUpRightIcon, PauseIcon, PlayIcon, RefreshCwIcon } from "lucide-react"
import {
  fetchMetrics,
  type MetricBucket,
  type MetricRecord,
  type MetricsSnapshot,
  type MetricStats,
  type ModelStats,
} from "@/api"
import {
  cacheRatio,
  compact,
  cost,
  dateTime,
  dec,
  effectiveTPS,
  latency,
  num,
  operationLabel,
  percent,
  sourceLabel,
  timeOnly,
} from "@/format"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

// Métricas: telemetria de `ai_requests` com auto-refresh, gráficos SVG desenhados
// à mão e inspeção chamada a chamada. Filtros vazios não entram na query.

type Mode = "latency" | "tps"

interface Filters {
  window: string
  operation: string
  model: string
  provider: string
  status: string
  source: string
}

const DEFAULT_FILTERS: Filters = { window: "24h", operation: "", model: "", provider: "", status: "", source: "" }

const ALL = "all" // sentinela: Radix Select não aceita value="" em SelectItem

interface Series {
  key: keyof MetricBucket
  label: string
  color: string // variável CSS (--chart-*), nunca hex: o painel tem tema claro/escuro
}

// ---------------------------------------------------------------------------
// controles

function FilterSelect({
  label,
  value,
  options,
  allLabel,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  allLabel?: string
  onChange: (value: string) => void
}) {
  const id = useId()
  const items = allLabel ? [{ value: ALL, label: allLabel }, ...options] : options
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select value={value || ALL} onValueChange={(next) => onChange(next === ALL ? "" : next)}>
        <SelectTrigger id={id} size="sm" className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function Filters({
  filters,
  modelOptions,
  providerOptions,
  onChange,
  onClear,
}: {
  filters: Filters
  modelOptions: string[]
  providerOptions: string[]
  onChange: <K extends keyof Filters>(key: K, value: Filters[K]) => void
  onClear: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Filtros</CardTitle>
        <CardDescription>Filtro vazio não entra na consulta — a visão traz tudo do período.</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={onClear}>
            Limpar filtros
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <FilterSelect
          label="Janela"
          value={filters.window}
          options={[
            { value: "1h", label: "Última hora" },
            { value: "6h", label: "Últimas 6 horas" },
            { value: "24h", label: "Últimas 24 horas" },
            { value: "7d", label: "Últimos 7 dias" },
            { value: "30d", label: "Últimos 30 dias" },
          ]}
          onChange={(value) => onChange("window", value)}
        />
        <FilterSelect
          label="Operação"
          value={filters.operation}
          allLabel="Todas as operações"
          options={[
            { value: "chat", label: operationLabel.chat },
            { value: "memory", label: operationLabel.memory },
            { value: "embedding", label: operationLabel.embedding },
            { value: "rerank", label: operationLabel.rerank },
            { value: "judge", label: operationLabel.judge },
          ]}
          onChange={(value) => onChange("operation", value)}
        />
        <FilterSelect
          label="Modelo"
          value={filters.model}
          allLabel="Todos os modelos"
          options={modelOptions.map((m) => ({ value: m, label: m }))}
          onChange={(value) => onChange("model", value)}
        />
        <FilterSelect
          label="Provedor"
          value={filters.provider}
          allLabel="Todos os provedores"
          options={providerOptions.map((p) => ({ value: p, label: p }))}
          onChange={(value) => onChange("provider", value)}
        />
        <FilterSelect
          label="Status"
          value={filters.status}
          allLabel="Todos os status"
          options={[
            { value: "success", label: "Sucesso" },
            { value: "error", label: "Erro" },
          ]}
          onChange={(value) => onChange("status", value)}
        />
        <FilterSelect
          label="Origem"
          value={filters.source}
          allLabel="Todas as origens"
          options={[
            { value: "discord", label: sourceLabel.discord },
            { value: "web", label: sourceLabel.web },
            { value: "cli", label: sourceLabel.cli },
          ]}
          onChange={(value) => onChange("source", value)}
        />
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// KPIs e gráficos

function Kpi({ label, value, unit, sub, tone }: { label: string; value: string; unit?: string; sub: ReactNode; tone?: "success" | "destructive" }) {
  return (
    <Card className="gap-1 p-4">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-baseline gap-1">
        <span
          className={cn(
            "text-2xl font-semibold tracking-tight tabular-nums",
            tone === "success" && "text-success",
            tone === "destructive" && "text-destructive",
          )}
        >
          {value}
        </span>
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </div>
      <span className="text-xs text-muted-foreground">{sub}</span>
    </Card>
  )
}

function Legend({ series }: { series: Series[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  )
}

// Preenche buckets vazios entre `since` e `until` para o eixo X ficar regular.
function seriesData(s: MetricsSnapshot): MetricBucket[] {
  const bucket = s.bucket_seconds * 1000
  const first = Math.floor(new Date(s.since).getTime() / bucket) * bucket
  const last = Math.floor(new Date(s.until).getTime() / bucket) * bucket
  const byTime = new Map(s.series.map((b) => [new Date(b.at).getTime(), b]))
  const points: MetricBucket[] = []
  for (let t = first; t <= last; t += bucket) {
    points.push(
      byTime.get(t) ?? {
        at: new Date(t).toISOString(),
        requests: 0,
        failures: 0,
        retries: 0,
        input_tokens: null,
        output_tokens: null,
        cached_tokens: null,
        cache_write_tokens: null,
        cache_input_tokens: null,
        cache_matched_tokens: null,
        cache_samples: 0,
        token_samples: 0,
        cost_usd: null,
        cost_samples: 0,
        avg_latency_ms: null,
        p95_latency_ms: null,
        effective_tps: null,
      },
    )
  }
  return points
}

const CHART_W = 720
const CHART_H = 220

function LineChart({
  data,
  summary,
  series,
  formatY,
  ariaLabel,
}: {
  data: MetricBucket[]
  summary: MetricStats
  series: Series[]
  formatY: (v: number) => string
  ariaLabel: string
}) {
  const measured = data.some((p) => p.requests > 0 && series.some((s) => p[s.key] != null))
  if (!summary.requests || !measured) {
    return (
      <div className="flex h-[220px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed">
        <span className="text-sm font-medium">sem dados no período</span>
        <span className="text-xs text-muted-foreground">
          {summary.requests ? "a métrica não foi informada nestas chamadas" : "aguardando atividade do bot"}
        </span>
      </div>
    )
  }

  const maximum = Math.max(1, ...data.flatMap((p) => series.map((s) => (p[s.key] as number | null) ?? 0))) * 1.12
  const x = (i: number) => (i / Math.max(1, data.length - 1)) * CHART_W
  const y = (v: number) => (1 - v / maximum) * CHART_H
  const yTicks = [0, 1, 2, 3].map((i) => {
    const value = (maximum * i) / 3
    return { value, pct: (y(value) / CHART_H) * 100 }
  })
  const xTicks = [0, 1, 2, 3].map((i) => {
    const index = Math.round((i * (data.length - 1)) / 3)
    return { label: timeOnly(data[index].at), pct: (x(index) / CHART_W) * 100, edge: i === 0 ? "start" : i === 3 ? "end" : "middle" }
  })

  return (
    <div>
      <div className="flex h-[220px] gap-2">
        <div className="relative w-12 shrink-0">
          {yTicks.map((tick) => (
            <span
              key={tick.value}
              className="absolute right-0 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
              style={{ top: `${tick.pct}%` }}
            >
              {formatY(tick.value)}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          {/* preserveAspectRatio="none" estica só a área de traçado; os textos
              ficam em HTML fora do svg e nunca são distorcidos */}
          <svg
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
            role="img"
            aria-label={ariaLabel}
          >
            {yTicks.map((tick) => (
              <line
                key={tick.value}
                x1={0}
                x2={CHART_W}
                y1={y(tick.value)}
                y2={y(tick.value)}
                stroke="var(--border)"
                strokeDasharray="4 4"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {series.map((s) => {
              // gap onde o valor é null: o traço quebra, sem interpolar
              const segments: string[] = []
              let path = ""
              let connected = false
              data.forEach((point, index) => {
                const value = point[s.key] as number | null
                if (value == null) {
                  if (path) segments.push(path)
                  path = ""
                  connected = false
                  return
                }
                path += `${connected ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)} `
                connected = true
              })
              if (path) segments.push(path)
              return (
                <g key={s.key}>
                  {segments.map((d, index) => (
                    <path
                      key={index}
                      d={d}
                      fill="none"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                      style={{ stroke: s.color }}
                    />
                  ))}
                  {data.map((point, index) => {
                    const value = point[s.key] as number | null
                    if (value == null || !point.requests) return null
                    return (
                      <circle
                        key={index}
                        cx={x(index)}
                        cy={y(value)}
                        r={3}
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                        style={{ fill: s.color, stroke: "var(--card)" }}
                      >
                        <title>{`${dateTime(point.at)} · ${s.label}: ${formatY(value)}`}</title>
                      </circle>
                    )
                  })}
                </g>
              )
            })}
          </svg>
        </div>
      </div>
      <div className="relative ml-14 h-4">
        {xTicks.map((tick) => (
          <span
            key={tick.label + tick.pct}
            className={cn(
              "absolute top-0 text-[10px] tabular-nums text-muted-foreground",
              tick.edge === "start" && "left-0",
              tick.edge === "middle" && "-translate-x-1/2",
              tick.edge === "end" && "-translate-x-full",
            )}
            style={{ left: `${tick.pct}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// cobertura e detalhe de chamada

function CoverageRow({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const ratio = total > 0 ? Math.min(100, (value / total) * 100) : 0
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {num(value)} / {num(total)} amostras
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${label}: ${num(value)} de ${num(total)} chamadas`}
      >
        <div className="h-full rounded-full transition-all" style={{ width: `${ratio}%`, background: color }} />
      </div>
    </div>
  )
}

function CallDetail({ record, onClose }: { record: MetricRecord; onClose: () => void }) {
  const fields: [string, string][] = [
    ["ID da chamada", String(record.id)],
    ["Início", dateTime(record.started_at)],
    ["Duração total", latency(record.duration_ms)],
    ["Operação", operationLabel[record.operation] ?? record.operation],
    ["Fluxo", record.workflow || "—"],
    ["Canal", record.channel_id || "—"],
    ["Origem", sourceLabel[record.source] ?? (record.source || "—")],
    ["Provedor / gateway", record.provider || "—"],
    ["Modelo solicitado", record.model || "—"],
    ["Modelo retornado", record.resolved_model || "—"],
    ["ID da geração", record.request_id || "não informado"],
    ["Resultado", record.success ? "Sucesso" : record.error_kind ? `Erro · ${record.error_kind}` : "Erro"],
    ["HTTP", record.http_status ? String(record.http_status) : "sem resposta HTTP"],
    ["Tentativas", num(record.attempts)],
    ["TPS efetivo", dec(effectiveTPS(record))],
    ["Tokens de entrada", num(record.input_tokens)],
    ["Tokens de saída", num(record.output_tokens)],
    ["Tokens totais", num(record.total_tokens)],
    ["Cache lido", num(record.cached_tokens)],
    ["Cache escrito", num(record.cache_write_tokens)],
    ["Custo reportado", cost(record.cost_usd)],
  ]
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {operationLabel[record.operation] ?? record.operation} · {record.model}
          </DialogTitle>
          <DialogDescription>Inspeção completa da chamada registrada em ai_requests.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          {fields.map(([key, value]) => (
            <div key={key} className="flex items-baseline justify-between gap-3 border-b py-1">
              <dt className="shrink-0 text-muted-foreground">{key}</dt>
              <dd className="break-all text-right font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          A latência inclui todas as tentativas. Tokens e custo são os informados na resposta final; não representam cobranças
          desconhecidas de tentativas anteriores.
        </p>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// consulta

function buildQuery(filters: Filters): string {
  const params = new URLSearchParams()
  params.set("window", filters.window)
  if (filters.operation) params.set("operation", filters.operation)
  if (filters.model) params.set("model", filters.model)
  if (filters.provider) params.set("provider", filters.provider)
  if (filters.status) params.set("status", filters.status)
  if (filters.source) params.set("source", filters.source)
  return `?${params.toString()}`
}

export default function MetricsView({ active }: { active: boolean }) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null)
  const [paused, setPaused] = useState(false)
  const [mode, setMode] = useState<Mode>("latency")
  const [detail, setDetail] = useState<MetricRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updated, setUpdated] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  const query = useMemo(() => buildQuery(filters), [filters])

  // Auto-refresh enquanto a aba está visível e não pausada. `reload` garante que
  // o botão "Atualizar" sempre recarregue (pausado ou não) — trocar `paused`
  // seguido seria engolido pelo batching do React e não reexecutaria o efeito.
  useEffect(() => {
    if (!active) return
    let alive = true
    // fetchMetrics não aceita AbortSignal: o controller serve de token de
    // cancelamento — resultado de carga em voo é descartado no abort.
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      fetchMetrics(query)
        .then((data) => {
          if (!alive || controller.signal.aborted) return
          setSnapshot(data)
          setUpdated(timeOnly(data.until))
          setError(null)
          if (!pausedRef.current) timer = setTimeout(load, data.refresh_ms || 5000)
        })
        .catch((err: unknown) => {
          if (!alive || controller.signal.aborted) return
          setError(err instanceof Error ? err.message : "falha ao carregar métricas")
          if (!pausedRef.current) timer = setTimeout(load, 5000)
        })
    }
    load()
    return () => {
      alive = false
      controller.abort()
      clearTimeout(timer)
    }
  }, [active, query, reload])

  const data = useMemo(() => (snapshot ? seriesData(snapshot) : []), [snapshot])
  const stats = snapshot?.summary
  const models = useMemo(
    () => (snapshot ? [...snapshot.models].sort((a, b) => b.requests - a.requests) : []),
    [snapshot],
  )
  const recent = useMemo(() => (snapshot ? snapshot.recent.slice(0, 50) : []), [snapshot])
  const modelOptions = useMemo(() => {
    const values = new Set([...(snapshot?.options.models ?? []), ...(filters.model ? [filters.model] : [])])
    return [...values].sort()
  }, [snapshot, filters.model])
  const providerOptions = useMemo(() => {
    const values = new Set([...(snapshot?.options.providers ?? []), ...(filters.provider ? [filters.provider] : [])])
    return [...values].sort()
  }, [snapshot, filters.provider])

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }))
  const bump = () => setReload((n) => n + 1)

  const tokenSeries: Series[] = [
    { key: "input_tokens", label: "Entrada", color: "var(--chart-1)" },
    { key: "output_tokens", label: "Saída", color: "var(--chart-2)" },
    { key: "cached_tokens", label: "Cache lido", color: "var(--chart-3)" },
  ]
  const perfSeries: Series[] =
    mode === "tps"
      ? [{ key: "effective_tps", label: "TPS efetivo", color: "var(--chart-2)" }]
      : [
          { key: "avg_latency_ms", label: "Média", color: "var(--chart-1)" },
          { key: "p95_latency_ms", label: "p95", color: "var(--chart-4)" },
        ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Métricas</h1>
          <p className="text-sm text-muted-foreground">
            Da primeira chamada ao último token — telemetria local, sem conteúdo das conversas.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {updated ? `atualizado às ${updated}` : "aguardando primeira leitura"}
          </span>
          <Button variant="outline" size="sm" onClick={() => (paused ? (setPaused(false), bump()) : setPaused(true))}>
            {paused ? <PlayIcon /> : <PauseIcon />}
            {paused ? "Retomar" : "Pausar"}
          </Button>
          <Button variant="outline" size="sm" onClick={bump} aria-label="Atualizar métricas">
            <RefreshCwIcon />
            Atualizar
          </Button>
        </div>
      </div>

      <Filters
        filters={filters}
        modelOptions={modelOptions}
        providerOptions={providerOptions}
        onChange={setFilter}
        onClear={() => setFilters(DEFAULT_FILTERS)}
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Falha ao carregar as métricas</AlertTitle>
          <AlertDescription>
            <span>
              {error}
              {snapshot ? " — exibindo a última leitura disponível." : ""}
            </span>
            <Button variant="outline" size="sm" onClick={bump}>
              Tentar de novo
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!snapshot ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <Card key={i} className="gap-2 p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-24" />
              <Skeleton className="h-3 w-28" />
            </Card>
          ))}
          <Card className="col-span-full h-[320px] p-6">
            <Skeleton className="h-full w-full" />
          </Card>
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Resumo do período">
            <Kpi
              label="Chamadas"
              value={num(stats?.requests)}
              tone={stats && stats.failures > 0 ? "destructive" : undefined}
              sub={
                <>
                  {percent(stats && stats.requests > 0 ? (stats.failures / stats.requests) * 100 : null)} de falha ·{" "}
                  {num(stats?.retries)} retries
                </>
              }
            />
            <Kpi
              label="Tokens de entrada"
              value={stats?.input_tokens == null ? "—" : compact.format(stats.input_tokens)}
              sub={
                <>
                  {num(stats?.output_tokens)} de saída · {num(stats?.token_samples)} amostras
                </>
              }
            />
            <Kpi
              label="Cache hit"
              value={percent(stats ? cacheRatio(stats) : null)}
              sub={
                <>
                  {num(stats?.cached_tokens)} tokens lidos · {num(stats?.cache_samples)} amostras
                </>
              }
            />
            <Kpi
              label="TPS efetivo"
              value={dec(stats?.effective_tps)}
              unit={stats?.effective_tps != null ? "tok/s" : undefined}
              sub="saída / tempo total de chamada"
            />
            <Kpi label="Latência p95" value={latency(stats?.p95_latency_ms)} sub={`média ${latency(stats?.avg_latency_ms)} · inclui retries`} />
            <Kpi
              label="Custo reportado"
              value={cost(stats?.cost_usd)}
              sub={`${num(stats?.cost_samples)} de ${num(stats?.requests)} chamadas com custo`}
            />
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Fluxo de tokens</CardTitle>
                <CardDescription>Consumo e reaproveitamento ao longo do tempo</CardDescription>
                <CardAction>
                  <Badge variant="outline" className="text-muted-foreground">
                    {snapshot.bucket_seconds < 3600
                      ? `intervalos de ${snapshot.bucket_seconds / 60} min`
                      : `intervalos de ${snapshot.bucket_seconds / 3600} h`}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Legend series={tokenSeries} />
                <LineChart
                  data={data}
                  summary={snapshot.summary}
                  series={tokenSeries}
                  formatY={(v) => compact.format(v)}
                  ariaLabel="Tokens de entrada, saída e cache lido ao longo do tempo"
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Desempenho</CardTitle>
                <CardDescription>
                  {mode === "tps" ? "Tokens de saída por segundo total de chamada" : "Tempo completo de cada chamada à API"}
                </CardDescription>
                <CardAction className="flex gap-1">
                  <Button
                    variant={mode === "latency" ? "secondary" : "ghost"}
                    size="xs"
                    aria-pressed={mode === "latency"}
                    onClick={() => setMode("latency")}
                  >
                    Latência
                  </Button>
                  <Button
                    variant={mode === "tps" ? "secondary" : "ghost"}
                    size="xs"
                    aria-pressed={mode === "tps"}
                    onClick={() => setMode("tps")}
                  >
                    TPS
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Legend series={perfSeries} />
                <LineChart
                  data={data}
                  summary={snapshot.summary}
                  series={perfSeries}
                  formatY={(v) => (mode === "tps" ? dec(v) : latency(v))}
                  ariaLabel={mode === "tps" ? "TPS efetivo ao longo do tempo" : "Latência média e p95 ao longo do tempo"}
                />
              </CardContent>
            </Card>
          </section>

          <section className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Modelos &amp; operações</CardTitle>
                <CardDescription>Onde seu orçamento e seu tempo estão indo</CardDescription>
                <CardAction>
                  <Badge variant="secondary">{num(models.length)}</Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provedor</TableHead>
                      <TableHead>Modelo</TableHead>
                      <TableHead>Operação</TableHead>
                      <TableHead>Origem</TableHead>
                      <TableHead className="text-right">Chamadas</TableHead>
                      <TableHead className="text-right">Falhas</TableHead>
                      <TableHead className="text-right">Tokens in/out</TableHead>
                      <TableHead className="text-right">Cache hit</TableHead>
                      <TableHead className="text-right">Custo</TableHead>
                      <TableHead className="text-right">Latência média / p95</TableHead>
                      <TableHead className="text-right">TPS</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {models.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={11} className="h-24 text-center text-muted-foreground">
                          Seu próximo token começa aqui — as métricas aparecem quando o bot fizer chamadas às APIs.
                        </TableCell>
                      </TableRow>
                    ) : (
                      models.map((m: ModelStats, index) => (
                        <TableRow key={`${m.provider}-${m.model}-${m.operation}-${m.source}-${index}`}>
                          <TableCell className="text-muted-foreground">{m.provider}</TableCell>
                          <TableCell className="max-w-56 truncate font-medium" title={m.model}>
                            {m.model}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">{operationLabel[m.operation] ?? m.operation}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-muted-foreground">
                              {sourceLabel[m.source] ?? (m.source || "—")}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{num(m.requests)}</TableCell>
                          <TableCell className={cn("text-right tabular-nums", m.failures > 0 && "text-destructive")}>
                            {num(m.failures)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {num(m.input_tokens)} / {num(m.output_tokens)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{percent(cacheRatio(m))}</TableCell>
                          <TableCell className="text-right tabular-nums">{cost(m.cost_usd)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {latency(m.avg_latency_ms)} <span className="text-muted-foreground">/</span> {latency(m.p95_latency_ms)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{dec(m.effective_tps)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Qualidade da medição</CardTitle>
                <CardDescription>O que as APIs realmente informaram — dado ausente é desconhecido, nunca zero.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {stats && (
                  <>
                    <CoverageRow label="Tokens de entrada" value={stats.token_samples} total={stats.requests} color="var(--chart-1)" />
                    <CoverageRow label="Leitura de cache" value={stats.cache_samples} total={stats.requests} color="var(--chart-2)" />
                    <CoverageRow label="Custo reportado" value={stats.cost_samples} total={stats.requests} color="var(--chart-4)" />
                  </>
                )}
                <Separator />
                <p className="text-xs text-muted-foreground">
                  <strong className="text-foreground">TPS efetivo, não velocidade de geração.</strong> Inclui rede, processamento,
                  espera e retries. TTFT exige streaming e ainda não é medido.
                </p>
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardHeader>
              <CardTitle>
                Últimas chamadas {recent.length > 0 && <span className="text-muted-foreground">/ {num(recent.length)}</span>}
              </CardTitle>
              <CardDescription>Até 50 chamadas no período e filtros selecionados — clique na linha para inspecionar.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hora</TableHead>
                    <TableHead>Operação</TableHead>
                    <TableHead>Origem</TableHead>
                    <TableHead>Modelo</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Tentativas</TableHead>
                    <TableHead className="text-right">Latência</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Custo</TableHead>
                    <TableHead>
                      <span className="sr-only">Detalhes</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                        Nenhuma chamada encontrada neste período.
                      </TableCell>
                    </TableRow>
                  ) : (
                    recent.map((r) => (
                      <TableRow key={r.id} className="cursor-pointer" onClick={() => setDetail(r)}>
                        <TableCell className="tabular-nums">{timeOnly(r.started_at)}</TableCell>
                        <TableCell>
                          <Badge variant="secondary">{operationLabel[r.operation] ?? r.operation}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-muted-foreground">
                            {sourceLabel[r.source] ?? (r.source || "—")}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-48 truncate font-medium" title={r.model}>
                          {r.model}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={r.success ? "outline" : "destructive"}
                            className={r.success ? "border-success/40 bg-success/10 text-success" : undefined}
                          >
                            {r.success ? "Sucesso" : "Erro"}
                            {r.http_status ? ` · ${r.http_status}` : ""}
                          </Badge>
                        </TableCell>
                        <TableCell className={cn("text-right tabular-nums", r.attempts > 1 && "text-warning")}>{num(r.attempts)}</TableCell>
                        <TableCell className="text-right tabular-nums">{latency(r.duration_ms)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {num(r.input_tokens)} / {num(r.output_tokens)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{cost(r.cost_usd)}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="text-muted-foreground"
                            aria-label={`Ver detalhes da chamada ${r.id}`}
                            onClick={() => setDetail(r)}
                          >
                            <ArrowUpRightIcon />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {detail && <CallDetail record={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}
