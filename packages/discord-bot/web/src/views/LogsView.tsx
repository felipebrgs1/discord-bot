import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EraserIcon, PauseIcon, PlayIcon, RefreshCwIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { cn } from "cn";
import { fetchLogs, fetchParticipation, reviewParticipation, type LogEntry, type ParticipationReview } from "@/api";
import { timeOnly } from "@/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

const LEVELS = ["todos", "INFO", "WARN", "ERROR"] as const;
const LEVEL_TONE: Record<string, string> = {
  INFO: "text-muted-foreground",
  WARN: "text-warning",
  ERROR: "text-destructive",
};

export default function LogsView({ active }: { active: boolean }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("todos");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [decisions, setDecisions] = useState<ParticipationReview[]>([]);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState("");
  const cursorRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  // Um único timer por (aba visível, pausa): o cursor vive em ref, então a
  // resposta de um poll não recria o intervalo.
  useEffect(() => {
    if (!active || paused) return;
    let stop = false;

    const tick = async () => {
      try {
        const data = await fetchLogs(cursorRef.current);
        if (stop) return;
        cursorRef.current = data.next;
        if (data.entries.length) {
          setEntries((prev) => [...prev, ...data.entries].slice(-3000));
          setUpdated(timeOnly(new Date().toISOString()));
        }
        setError("");
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : "falha ao ler logs");
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [active, paused]);

  const loadDecisions = useCallback(() => {
    fetchParticipation()
      .then((d) => setDecisions(d.items))
      .catch(() => setDecisions([]));
  }, []);

  useEffect(() => {
    if (active) loadDecisions();
  }, [active, loadDecisions]);

  useEffect(() => {
    if (nearBottomRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);

  const review = async (item: ParticipationReview, value: "useful" | "unhelpful") => {
    try {
      await reviewParticipation(item.channel_id, item.source_id, value);
      setDecisions((prev) => prev.map((d) => (d.source_id === item.source_id ? { ...d, review: value } : d)));
      toast.success(value === "useful" ? "marcada como útil" : "marcada como inoportuna");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "não foi possível avaliar");
    }
  };

  const visible = entries.filter((e) => {
    if (level !== "todos" && e.level !== level) return false;
    if (!query.trim()) return true;
    const needle = query.trim().toLowerCase();
    return e.msg.toLowerCase().includes(needle) || JSON.stringify(e.attrs ?? {}).toLowerCase().includes(needle);
  });

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl min-w-0 flex-col gap-4 p-4">
      {decisions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Iniciativas em avaliação</CardTitle>
            <CardDescription>Propostas espontâneas do agente — avalie para calibrar o juiz.</CardDescription>
          </CardHeader>
          <CardContent className="flex max-h-72 flex-col gap-3 overflow-y-auto">
            {decisions.map((item) => (
              <div key={item.source_id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">{item.kind}</Badge>
                  <Badge variant="outline">{item.mode}</Badge>
                  <span className="text-[0.7rem] text-muted-foreground">{timeOnly(item.created_at)}</span>
                </div>
                {item.source_text && (
                  <p className="mt-2 min-w-0 text-xs break-words text-muted-foreground">contexto: {item.source_text}</p>
                )}
                {item.draft && <p className="mt-1 min-w-0 text-sm break-words">{item.draft}</p>}
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="xs"
                    variant={item.review === "useful" ? "default" : "outline"}
                    disabled={item.review !== ""}
                    onClick={() => void review(item, "useful")}
                  >
                    <ThumbsUpIcon /> Útil
                  </Button>
                  <Button
                    size="xs"
                    variant={item.review === "unhelpful" ? "destructive" : "outline"}
                    disabled={item.review !== ""}
                    onClick={() => void review(item, "unhelpful")}
                  >
                    <ThumbsDownIcon /> Inoportuna
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="mr-auto text-sm">Logs do processo</CardTitle>
            <Select value={level} onValueChange={(v) => setLevel(v as (typeof LEVELS)[number])}>
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVELS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l === "todos" ? "todos os níveis" : l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filtrar por texto…"
              className="h-8 w-40 sm:w-56"
            />
            <Button size="sm" variant="outline" onClick={() => setPaused((p) => !p)}>
              {paused ? <PlayIcon /> : <PauseIcon />}
              {paused ? "seguir" : "pausar"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEntries([])}>
              <EraserIcon /> limpar
            </Button>
          </div>
          <CardDescription>
            {paused
              ? "pausado — o histórico continua guardado no buffer do servidor"
              : updated
                ? `atualizado às ${updated}`
                : "aguardando eventos…"}
            {error && <span className="ml-2 text-destructive">{error}</span>}
          </CardDescription>
        </CardHeader>
        <CardContent
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
              <RefreshCwIcon className="mt-2 size-4 animate-spin opacity-40" />
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-0.5 font-code text-[0.72rem] leading-relaxed">
              {visible.map((entry) => (
                <LogRow key={entry.id} entry={entry} />
              ))}
              {visible.length === 0 && entries.length > 0 && (
                <p className="px-2 py-6 text-center text-muted-foreground">nenhum log corresponde ao filtro</p>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </CardContent>
      </Card>
    </div>
  );
}
function formatAttr(value: string | number | boolean): string {
  // Durações com 6 casas decimais não ajudam ninguém a ler o log.
  if (typeof value === "number" && !Number.isInteger(value)) return value.toFixed(1);
  return String(value);
}

// Linha do log em grade: hora + nível em colunas fixas e a mensagem na coluna
// flexível (minmax(0,1fr) impede a linha de estourar a tela). Os atributos vão
// em chips na linha de baixo, quebrando — o formato antigo enfileirava tudo
// numa span sem quebra e uma linha de ai_request empurrava o resto pra fora.
function LogRow({ entry }: { entry: LogEntry }) {
  const attrs = Object.entries(entry.attrs ?? {}).filter(
    (pair): pair is [string, string | number | boolean] =>
      ["string", "number", "boolean"].includes(typeof pair[1]),
  );

  return (
    <div className="grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] gap-x-2 rounded px-2 py-1 hover:bg-muted/60">
      <span className="shrink-0 tabular-nums text-muted-foreground">{timeOnly(entry.time)}</span>
      <span className={cn("shrink-0 font-medium", LEVEL_TONE[entry.level] ?? "text-muted-foreground")}>
        {entry.level}
      </span>
      <span className="min-w-0 break-words">{entry.msg}</span>
      {attrs.length > 0 && (
        <div className="col-start-3 flex min-w-0 flex-wrap gap-x-1.5 gap-y-0.5 pt-0.5">
          {attrs.map(([key, value]) => (
            <span key={key} className="min-w-0 rounded bg-muted px-1.5 py-px break-all text-muted-foreground">
              <span className="font-medium text-foreground/80">{key}</span>={formatAttr(value)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
