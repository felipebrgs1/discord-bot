import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2Icon, MenuIcon } from "lucide-react";
import {
  checkSession,
  deleteSession,
  fetchMeta,
  fetchSessions,
  login,
  logout as apiLogout,
  type Meta,
  type Session,
} from "@/api";
import { hashForView, viewFromHash, VIEW_LABEL, type View } from "@/nav";
import { AppSidebar } from "@/components/AppSidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import ChatView from "@/views/ChatView";

// Views secundárias em chunks próprios: a Conversa pinta sem esperar o código
// das telas de ops. Uma vez abertas, ficam montadas (estado preservado).
const LearningsView = lazy(() => import("@/views/LearningsView"));
const LogsView = lazy(() => import("@/views/LogsView"));
const ConfigView = lazy(() => import("@/views/ConfigView"));
const MetricsView = lazy(() => import("@/views/MetricsView"));

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash));
  const [navOpen, setNavOpen] = useState(false);

  const loadSessions = useCallback(() => {
    fetchSessions()
      .then((d) => setSessions(d.sessions))
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    checkSession()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    const onExpired = () => setAuthed(false);
    window.addEventListener("session-expired", onExpired);
    return () => window.removeEventListener("session-expired", onExpired);
  }, []);

  useEffect(() => {
    const onHash = () => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const onNet = () => toast.warning(navigator.onLine ? "conexão restabelecida" : "você está offline");
    window.addEventListener("online", onNet);
    window.addEventListener("offline", onNet);
    return () => {
      window.removeEventListener("online", onNet);
      window.removeEventListener("offline", onNet);
    };
  }, []);

  useEffect(() => {
    if (!authed) return;
    fetchMeta().then(setMeta).catch(() => setMeta(null));
    loadSessions();
  }, [authed, loadSessions]);

  const navigate = useCallback((next: View) => {
    setView(next);
    setNavOpen(false);
    if (window.location.hash !== hashForView(next)) window.location.hash = hashForView(next);
  }, []);

  const openSession = useCallback(
    (id: string) => {
      setCurrent(id);
      navigate("conversa");
    },
    [navigate],
  );

  const newSession = useCallback(() => {
    setCurrent(null);
    navigate("conversa");
  }, [navigate]);

  const removeSession = useCallback(
    (id: string) => {
      deleteSession(id)
        .then(() => {
          toast.success("conversa excluída");
          if (current === id) setCurrent(null);
          loadSessions();
        })
        .catch((err) => toast.error(err instanceof Error ? err.message : "não foi possível excluir"));
    },
    [current, loadSessions],
  );

  const signOut = useCallback(() => {
    apiLogout()
      .catch(() => undefined)
      .then(() => setAuthed(false));
  }, []);

  if (authed === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!authed) return <LoginScreen onDone={() => setAuthed(true)} />;

  const sidebar = (
    <AppSidebar
      meta={meta}
      sessions={sessions}
      view={view}
      current={current}
      onNavigate={navigate}
      onNew={newSession}
      onOpen={openSession}
      onDelete={removeSession}
      onLogout={signOut}
    />
  );

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <aside className="hidden border-r md:flex">{sidebar}</aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Abrir menu">
                <MenuIcon />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 bg-sidebar p-0">
              <SheetTitle className="sr-only">Navegação</SheetTitle>
              {sidebar}
            </SheetContent>
          </Sheet>
          <span className="text-sm font-medium">{VIEW_LABEL[view]}</span>
        </header>

        {/* Views ficam montadas: trocar de aba não cancela uma resposta em
            andamento nem perde o scroll/estado de cada tela. */}
        <main className="min-h-0 flex-1 overflow-hidden">
          <ViewPane active={view === "conversa"} scroll={false}>
            <ChatView
              active={view === "conversa"}
              session={current}
              onSession={setCurrent}
              meta={meta}
              onSessionsChanged={loadSessions}
            />
          </ViewPane>
          <ViewPane active={view === "aprendizado"} scroll>
            <LearningsView active={view === "aprendizado"} />
          </ViewPane>
          <ViewPane active={view === "logs"} scroll>
            <LogsView active={view === "logs"} />
          </ViewPane>
          <ViewPane active={view === "config"} scroll>
            <ConfigView active={view === "config"} />
          </ViewPane>
          <ViewPane active={view === "metricas"} scroll>
            <MetricsView active={view === "metricas"} />
          </ViewPane>
        </main>
      </div>
    </div>
  );
}

function ViewPane({ active, scroll, children }: { active: boolean; scroll: boolean; children: React.ReactNode }) {
  // Monta na primeira ativação e mantém montada de propósito: trocar de aba
  // não pode abortar um stream em andamento nem perder o estado da tela.
  const [seen, setSeen] = useState(active);
  useEffect(() => {
    if (active) setSeen(true);
  }, [active]);

  return (
    <div className={active ? (scroll ? "h-full overflow-y-auto" : "h-full") : "hidden"}>
      {seen && <Suspense fallback={null}>{children}</Suspense>}
    </div>
  );
}

function LoginScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "não foi possível entrar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Painel botdiscord</CardTitle>
          <CardDescription>Informe a senha do painel para continuar.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3" onSubmit={submit}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="senha"
              autoFocus
              autoComplete="current-password"
            />
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={busy || password.length === 0}>
              {busy && <Loader2Icon className="animate-spin" />} Entrar
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
