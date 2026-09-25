import { useCallback, useEffect, useRef, useState } from "react";
import {
  BotIcon,
  ChevronDownIcon,
  Loader2Icon,
  PaperclipIcon,
  SendIcon,
  SquareIcon,
} from "lucide-react";
import { cn } from "cn";
import {
  fetchMessages,
  genSessionID,
  sendChat,
  type ChatMessage,
  type Meta,
  type Step,
} from "@/api";
import { timeOnly } from "@/format";
import { Markdown } from "@/components/Markdown";
import { CopyButton } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

const SUGGESTIONS = [
  "O que você aprendeu com o grupo recentemente?",
  "Resuma as últimas conversas deste canal.",
  "Me ajuda a montar uma skill nova pra sua rotina.",
];

interface Props {
  active: boolean;
  session: string | null;
  onSession: (id: string) => void;
  meta: Meta | null;
  onSessionsChanged: () => void;
}

export default function ChatView({ active, session, onSession, meta, onSessionsChanged }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stepsByMessage, setStepsByMessage] = useState<Record<string, Step[]>>({});
  const [pendingSteps, setPendingSteps] = useState<Step[] | null>(null);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Geração vigente: uma resposta em voo ou um fetch antigo não podem
  // sobrescrever o que a outra via acabou de persistir.
  const genRef = useRef(0);
  // Sessão criada pelo próprio envio: trocar para ela não pode recarregar a
  // transcrição nem abortar o stream que acabou de começar.
  const createdRef = useRef<string | null>(null);

  useEffect(() => {
    if (session && session === createdRef.current) {
      createdRef.current = null;
      return;
    }
    genRef.current += 1;
    const gen = genRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    setPendingSteps(null);
    setError("");
    if (!session) {
      setMessages([]);
      setStepsByMessage({});
      return;
    }
    fetchMessages(session)
      .then((d) => {
        if (genRef.current === gen) setMessages(d.messages);
      })
      .catch((err) => {
        if (genRef.current === gen) setError(err instanceof Error ? err.message : "não foi possível carregar");
      });
  }, [session]);

  // Só o desmonte real da tela cancela uma resposta em andamento (trocar de
  // aba mantém a view montada de propósito).
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!active) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pendingSteps, active]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || pendingSteps !== null) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = genRef.current;

    const id = session ?? genSessionID();
    const local: ChatMessage = {
      id: `local-${Date.now()}`,
      author_id: meta?.role ?? "user",
      author_name: "você",
      content,
      is_bot: false,
      created_at: new Date().toISOString(),
    };
    setMessages((ms) => [...ms, local]);
    setInput("");
    setError("");
    setPendingSteps([]);
    if (!session) {
      createdRef.current = id;
      onSession(id);
    }

    let echoed = false;
    await sendChat(id, content, {
      signal: controller.signal,
      onAccepted: (message) => {
        if (genRef.current !== gen) return;
        echoed = true;
        setMessages((ms) => [...ms.filter((m) => !m.id.startsWith("local-")), message]);
      },
      onStep: (step) => {
        if (genRef.current !== gen) return;
        setPendingSteps((steps) => [...(steps ?? []), step]);
      },
      onDone: (message, steps) => {
        if (genRef.current !== gen) return;
        setPendingSteps(null);
        setMessages((ms) => [...ms.filter((m) => !m.id.startsWith("local-")), message]);
        setStepsByMessage((map) => ({ ...map, [message.id]: steps }));
        onSessionsChanged();
      },
      onError: (message) => {
        if (genRef.current !== gen) return;
        setPendingSteps(null);
        setError(message);
        // Mensagem digitada não some quando o envio falha (a menos que o
        // servidor já tenha ecoado a persistida).
        if (!echoed) {
          setMessages((ms) => (ms.some((m) => m.id.startsWith("local-")) ? ms : [...ms, local]));
        }
        onSessionsChanged();
      },
    });

    abortRef.current = null;
  }, [input, meta, onSession, onSessionsChanged, pendingSteps, session]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPendingSteps(null);
  }, []);

  const canChat = meta?.chat !== false && meta !== null;

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4">
      <div className="min-h-0 flex-1 overflow-y-auto py-6">
        {messages.length === 0 && pendingSteps === null && (
          <EmptyState onPick={setInput} disabled={!canChat} />
        )}

        <div className="flex flex-col gap-5">
          {messages.map((m) => (
            <MessageRow key={m.id} message={m} steps={stepsByMessage[m.id]} messages={messages} />
          ))}
        </div>

        {pendingSteps !== null && <StepList steps={pendingSteps} running />}
      </div>

      {error && (
        <div className="mb-2 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}

      <div className="sticky bottom-0 bg-background pb-4">
        <div className="rounded-xl border bg-card p-2 shadow-sm">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={canChat ? "Mensagem para o agente (Enter envia, Shift+Enter quebra linha)" : "Chat indisponível neste momento"}
            disabled={!canChat}
            rows={1}
            className="max-h-48 min-h-10 resize-none border-0 px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-card"
          />
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-[0.7rem] text-muted-foreground">
              {meta ? `agente · ${meta.role}` : "…"}
            </span>
            {pendingSteps !== null ? (
              <Button size="sm" variant="outline" onClick={stop}>
                <SquareIcon /> parar
              </Button>
            ) : (
              <Button size="sm" onClick={() => void send()} disabled={!canChat || input.trim().length === 0}>
                <SendIcon /> enviar
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 py-16 text-center">
      <Avatar className="size-12">
        <AvatarFallback className="bg-primary text-primary-foreground">
          <BotIcon className="size-6" />
        </AvatarFallback>
      </Avatar>
      <div>
        <h1 className="text-lg font-semibold">Como posso ajudar?</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Conversa com memória, tools e as skills que eu mesmo criei.
        </p>
      </div>
      <div className="flex w-full max-w-md flex-col gap-2">
        {SUGGESTIONS.map((s) => (
          <Button
            key={s}
            variant="outline"
            className="h-auto justify-start px-3 py-2 text-left text-sm whitespace-normal"
            disabled={disabled}
            onClick={() => onPick(s)}
          >
            {s}
          </Button>
        ))}
      </div>
    </div>
  );
}

function MessageRow({ message, steps, messages }: { message: ChatMessage; steps?: Step[]; messages: ChatMessage[] }) {
  const quoted = message.reply_to ? messages.find((m) => m.id === message.reply_to) : undefined;

  if (!message.is_bot) {
    return (
      <div className="flex flex-col items-end gap-1">
        {quoted && <Quote message={quoted} align="right" />}
        <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-[0.925rem] whitespace-pre-wrap">
          {message.content}
        </div>
        {message.attachments && message.attachments.length > 0 && (
          <Attachments urls={message.attachments} align="right" />
        )}
        <span className="px-1 text-[0.68rem] text-muted-foreground">{timeOnly(message.created_at)}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {quoted && <Quote message={quoted} align="left" />}
      <div className="flex gap-3">
        <Avatar className="mt-0.5 size-8 shrink-0">
          <AvatarFallback className="bg-primary/10 text-primary">
            <BotIcon className="size-4" />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <Markdown content={message.content} />
          {message.attachments && message.attachments.length > 0 && <Attachments urls={message.attachments} />}
          {steps && steps.length > 0 && <StepList steps={steps} />}
          <div className="mt-1 flex items-center gap-1">
            <span className="text-[0.68rem] text-muted-foreground">{timeOnly(message.created_at)}</span>
            <CopyButton text={message.content} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Quote({ message, align }: { message: ChatMessage; align: "left" | "right" }) {
  return (
    <div
      className={cn(
        "max-w-[85%] border-l-2 border-primary/50 py-0.5 pl-2 text-[0.75rem] text-muted-foreground",
        align === "right" ? "self-end text-right" : "self-start",
      )}
    >
      <span className="font-medium">{message.author_name}</span>{" "}
      <span className="line-clamp-1">{message.content}</span>
    </div>
  );
}

function Attachments({ urls, align }: { urls: string[]; align?: "left" | "right" }) {
  return (
    <div className={cn("mt-2 flex flex-wrap gap-2", align === "right" && "justify-end")}>
      {urls.map((url) => {
        const isImage = /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(url);
        return isImage ? (
          <a key={url} href={url} target="_blank" rel="noreferrer">
            <img
              src={url}
              alt="anexo"
              loading="lazy"
              className="max-h-64 max-w-full rounded-lg border object-cover"
            />
          </a>
        ) : (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-accent"
          >
            <PaperclipIcon className="size-3.5 shrink-0" />
            <span className="truncate">{url.split("/").pop() ?? url}</span>
          </a>
        );
      })}
    </div>
  );
}

function StepList({ steps, running }: { steps: Step[]; running?: boolean }) {
  return (
    <Collapsible className="my-2 rounded-lg border bg-muted/40">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent/50">
        <ChevronDownIcon className="size-3.5 transition-transform [[data-state=closed]_&]:-rotate-90" />
        {running ? (
          <>
            <Loader2Icon className="size-3.5 animate-spin" /> executando ({steps.length})
          </>
        ) : (
          <>execução ({steps.length})</>
        )}
        <span className="ml-auto flex flex-wrap gap-1">
          {[...new Set(steps.map((s) => s.tool))].map((tool) => (
            <Badge key={tool} variant="secondary" className="font-code text-[0.65rem]">
              {tool}
            </Badge>
          ))}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 border-t px-3 py-2">
        {steps.map((step, i) => (
          <div key={`${step.tool}-${i}`} className="text-xs">
            <div className="flex items-center gap-2">
              <Badge className="font-code text-[0.65rem]">{step.tool}</Badge>
              {step.duration_ms > 0 && (
                <span className="text-[0.68rem] text-muted-foreground">{step.duration_ms} ms</span>
              )}
            </div>
            {step.args && (
              <pre className="mt-1 max-h-24 overflow-auto rounded bg-background p-2 font-code text-[0.7rem] text-muted-foreground">
                {step.args}
              </pre>
            )}
            {step.output && (
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-background p-2 font-code text-[0.7rem]">
                {step.output}
              </pre>
            )}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
