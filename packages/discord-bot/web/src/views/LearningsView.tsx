import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { HistoryIcon, Loader2Icon, PencilIcon, RotateCcwIcon, TrashIcon } from "lucide-react";
import {
  actOnMemory,
  correctMemory,
  fetchLearnings,
  fetchMemories,
  fetchMemoryVersions,
  type LearningEvent,
  type MemoryItem,
  type MemoryVersion,
} from "@/api";
import { dateTime, timeOnly } from "@/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";

const KIND_LABEL: Record<string, string> = {
  fact: "fato",
  preference: "preferência",
  lesson: "lição",
  episode: "episódio",
  culture: "referência",
  procedure: "procedimento",
};

const STATUS_LABEL: Record<string, string> = {
  active: "vale",
  contested: "contestado",
  suppressed: "esquecido",
};

const KIND_FILTERS = ["todos", "fact", "preference", "lesson", "episode", "culture", "procedure", "suppressed"];

export default function LearningsView({ active }: { active: boolean }) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [events, setEvents] = useState<LearningEvent[]>([]);
  const [filter, setFilter] = useState("todos");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<{ id: number; versions: MemoryVersion[] } | null>(null);
  const [editing, setEditing] = useState<{ item: MemoryItem; content: string; reason: string } | null>(null);
  const [forgetting, setForgetting] = useState<{ item: MemoryItem; action: "forget" | "restore"; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, l] = await Promise.all([fetchMemories(), fetchLearnings()]);
      setItems(m.items);
      setEvents(l.events);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "não foi possível carregar");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === "suppressed") {
        if (item.status !== "suppressed") return false;
      } else if (filter !== "todos") {
        if (item.kind !== filter) return false;
      } else if (item.status === "suppressed") {
        return false;
      }
      if (!needle) return true;
      return (
        item.content.toLowerCase().includes(needle) ||
        item.key.toLowerCase().includes(needle) ||
        (item.user_id ?? "").includes(needle)
      );
    });
  }, [items, filter, query]);

  async function openHistory(item: MemoryItem) {
    try {
      const d = await fetchMemoryVersions(item.id);
      setHistory({ id: item.id, versions: d.versions });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "não foi possível carregar o histórico");
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    try {
      await correctMemory(editing.item.id, editing.content, editing.reason.trim() || "corrigido no painel");
      toast.success("aprendizado corrigido");
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "não foi possível corrigir");
    } finally {
      setBusy(false);
    }
  }

  async function confirmForget() {
    if (!forgetting) return;
    setBusy(true);
    try {
      await actOnMemory(forgetting.item.id, forgetting.action, forgetting.reason.trim() ||
        (forgetting.action === "forget" ? "esquecido no painel" : "restaurado no painel"));
      toast.success(forgetting.action === "forget" ? "esquecido" : "restaurado");
      setForgetting(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "não foi possível aplicar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-4">
      <Tabs defaultValue="itens">
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="itens">Aprendizados</TabsTrigger>
            <TabsTrigger value="linha">Linha do tempo</TabsTrigger>
          </TabsList>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger size="sm" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_FILTERS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k === "todos"
                      ? "todos os ativos"
                      : k === "suppressed"
                        ? "esquecidos"
                        : (KIND_LABEL[k] ?? k)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="buscar aprendizado…"
              className="h-8 w-48"
            />
          </div>
        </div>

        <TabsContent value="itens" className="mt-4">
          {loading && items.length === 0 ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : visible.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              nada por aqui — o que o grupo ensinar aparece nesta lista.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {visible.map((item) => (
                <Card key={item.id} className="py-4">
                  <CardHeader className="px-4 pb-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary">{KIND_LABEL[item.kind] ?? item.kind}</Badge>
                      <Badge
                        variant={item.status === "active" ? "outline" : item.status === "suppressed" ? "destructive" : "secondary"}
                      >
                        {STATUS_LABEL[item.status] ?? item.status}
                      </Badge>
                      <Badge variant="outline">{item.scope === "group" ? "do grupo" : `de ${item.user_id ?? "…"}`}</Badge>
                      <span className="ml-auto text-[0.7rem] text-muted-foreground">
                        v{item.version} · {dateTime(item.updated_at)}
                      </span>
                    </div>
                    <CardTitle className="mt-2 text-sm leading-relaxed font-normal">{item.content}</CardTitle>
                    <p className="mt-1 font-code text-[0.7rem] text-muted-foreground">
                      {item.key}
                      {item.source_ids.length > 0 && (
                        <span title={item.source_ids.join(", ")}> · {item.source_ids.length} fonte(s)</span>
                      )}
                    </p>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2 px-4 pt-0">
                    <Button size="xs" variant="outline" onClick={() => void openHistory(item)}>
                      <HistoryIcon /> Histórico
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setEditing({ item, content: item.content, reason: "" })}
                    >
                      <PencilIcon /> Corrigir
                    </Button>
                    {item.status === "suppressed" ? (
                      <Button size="xs" variant="outline" onClick={() => setForgetting({ item, action: "restore", reason: "" })}>
                        <RotateCcwIcon /> Restaurar
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setForgetting({ item, action: "forget", reason: "" })}
                      >
                        <TrashIcon /> Esquecer
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="linha" className="mt-4">
          {events.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">nenhum evento registrado ainda.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {events.map((event, i) => (
                <div key={`${event.at}-${i}`} className="flex gap-3 rounded-lg border p-3">
                  <div className="w-24 shrink-0 text-xs text-muted-foreground">
                    <div>{timeOnly(event.at)}</div>
                    <div>{dateTime(event.at).split(",")[0]}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary">{event.kind}</Badge>
                      {event.actor && <Badge variant="outline">{event.actor}</Badge>}
                      <span className="text-xs text-muted-foreground">{event.subject}</span>
                    </div>
                    <p className="mt-1 text-sm">{event.detail}</p>
                    {event.reason && <p className="mt-1 text-xs text-muted-foreground">por: {event.reason}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={history !== null} onOpenChange={(open) => !open && setHistory(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Histórico do aprendizado</DialogTitle>
            <DialogDescription>Cada versão traz o motivo de existir.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {(history?.versions ?? []).map((v) => (
              <div key={v.version} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">v{v.version}</Badge>
                  <Badge variant="outline">{KIND_LABEL[v.kind] ?? v.kind}</Badge>
                  <Badge variant="outline">{STATUS_LABEL[v.status] ?? v.status}</Badge>
                  <span className="ml-auto text-[0.7rem] text-muted-foreground">{dateTime(v.created_at)}</span>
                </div>
                <p className="mt-2 text-sm">{v.content}</p>
                {v.reason && <p className="mt-1 text-xs text-muted-foreground">motivo: {v.reason}</p>}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Corrigir aprendizado</DialogTitle>
            <DialogDescription>
              A correção gera uma versão nova com embedding novo — vale também para quem estava esquecido.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="fix-content">Conteúdo</Label>
              <Textarea
                id="fix-content"
                value={editing?.content ?? ""}
                onChange={(e) => setEditing((ed) => (ed ? { ...ed, content: e.target.value } : ed))}
                rows={4}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="fix-reason">Motivo</Label>
              <Input
                id="fix-reason"
                value={editing?.reason ?? ""}
                onChange={(e) => setEditing((ed) => (ed ? { ...ed, reason: e.target.value } : ed))}
                placeholder="corrigido no painel"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void saveEdit()} disabled={busy || !editing?.content.trim()}>
              {busy && <Loader2Icon className="animate-spin" />} Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={forgetting !== null} onOpenChange={(open) => !open && setForgetting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {forgetting?.action === "forget" ? "Esquecer este aprendizado?" : "Restaurar este aprendizado?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {forgetting?.action === "forget"
                ? "Ele sai de toda recuperação e reextrações do mesmo conteúdo são descartadas."
                : "Ele volta a valer e pode ser recuperado nas respostas."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="forget-reason">Motivo (opcional)</Label>
            <Input
              id="forget-reason"
              value={forgetting?.reason ?? ""}
              onChange={(e) => setForgetting((f) => (f ? { ...f, reason: e.target.value } : f))}
              placeholder={forgetting?.action === "forget" ? "esquecido no painel" : "restaurado no painel"}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmForget()} disabled={busy}>
              Confirmar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
