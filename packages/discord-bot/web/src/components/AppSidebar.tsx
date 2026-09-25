import { useMemo, useState } from "react";
import {
  BotIcon,
  BrainIcon,
  ChartLineIcon,
  LogsIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilRulerIcon,
  PlusIcon,
  TrashIcon,
} from "lucide-react";
import { cn } from "cn";
import type { Meta, Session } from "@/api";
import type { View } from "@/nav";
import { VIEW_IDS, VIEW_LABEL } from "@/nav";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { ThemeToggle } from "@/components/ThemeToggle";

const VIEW_ICON: Record<View, typeof BotIcon> = {
  conversa: MessageSquareIcon,
  aprendizado: BrainIcon,
  logs: LogsIcon,
  config: BotIcon,
  metricas: ChartLineIcon,
};

const ROLE_LABEL: Record<string, string> = { user: "usuário", mod: "moderação", admin: "admin" };

interface Props {
  meta: Meta | null;
  sessions: Session[];
  view: View;
  current: string | null;
  onNavigate: (view: View) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onLogout: () => void;
  className?: string;
}

export function AppSidebar({ meta, sessions, view, current, onNavigate, onNew, onOpen, onDelete, onLogout, className }: Props) {
  const [confirm, setConfirm] = useState<Session | null>(null);
  const groups = useMemo(() => groupSessions(sessions), [sessions]);

  return (
    <div className={cn("flex h-full w-64 flex-col bg-sidebar text-sidebar-foreground", className)}>
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground">
          ⌁
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">botdiscord</div>
          <div className="truncate text-xs text-muted-foreground">painel de controle</div>
        </div>
      </div>

      <div className="px-3">
        <Button className="w-full justify-start" onClick={onNew}>
          <PlusIcon /> Nova conversa
        </Button>
      </div>

      <nav className="mt-4 flex flex-col gap-0.5 px-3" aria-label="Seções">
        {VIEW_IDS.map((id) => {
          const Icon = VIEW_ICON[id];
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                active
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {VIEW_LABEL[id]}
            </button>
          );
        })}
      </nav>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="px-2 pb-1 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
          Conversas
        </div>
        {groups.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">nenhuma conversa ainda</p>
        )}
        {groups.map(([label, items]) => (
          <div key={label} className="mt-2">
            <div className="px-2 pb-1 text-[0.68rem] text-muted-foreground/80">{label}</div>
            <div className="flex flex-col gap-0.5">
              {items.map((s) => (
                <div key={s.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onOpen(s.id)}
                    title={s.title}
                    className={cn(
                      "w-full truncate rounded-md py-2 pr-9 pl-2.5 text-left text-sm transition-colors",
                      current === s.id
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                    )}
                  >
                    {s.title || "sem título"}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="absolute top-1.5 right-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                        aria-label={`Ações da conversa ${s.title || "sem título"}`}
                      >
                        <MoreHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(s)}>
                        <TrashIcon /> Excluir conversa
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t px-3 py-3">
        <PencilRulerIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <Badge variant="secondary" className="text-[0.68rem]">
            {ROLE_LABEL[meta?.role ?? "user"] ?? meta?.role ?? "—"}
          </Badge>
          <div className="mt-0.5 truncate text-[0.68rem] text-muted-foreground" title={meta?.model ?? ""}>
            {meta?.model || "modelo não configurado"}
          </div>
        </div>
        <ThemeToggle />
        <Button variant="ghost" size="sm" onClick={onLogout}>
          sair
        </Button>
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir esta conversa?</AlertDialogTitle>
            <AlertDialogDescription>
              "{confirm?.title || "sem título"}" e todas as mensagens dela saem do histórico. Os aprendizados
              consolidados continuam na memória.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) onDelete(confirm.id);
                setConfirm(null);
              }}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Agrupa por dia de atualização. Cada item cai em um grupo pela SUA data (o
// código antigo mutava um "hoje" compartilhado e os grupos se misturavam se a
// lista viesse fora de ordem).
function groupSessions(sessions: Session[]): Array<[string, Session[]]> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;

  const bucket = (iso: string): string => {
    const at = new Date(iso).getTime();
    if (at >= startOfToday.getTime()) return "Hoje";
    if (at >= startOfToday.getTime() - day) return "Ontem";
    if (at >= startOfToday.getTime() - 7 * day) return "Esta semana";
    return "Mais antigas";
  };

  const order = ["Hoje", "Ontem", "Esta semana", "Mais antigas"];
  const map = new Map<string, Session[]>();
  const sorted = [...sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  for (const s of sorted) {
    const key = bucket(s.updated_at);
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  return order.filter((k) => map.has(k)).map((k) => [k, map.get(k) ?? []]);
}
