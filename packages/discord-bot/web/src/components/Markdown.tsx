import { type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { cn } from "cn";
import { CopyButton } from "@/components/CopyButton";

// Markdown sem HTML bruto (nunca dangerouslySetInnerHTML): react-markdown
// escapa tudo, e links javascript: são barrados pelo urlTransform padrão.
export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("msg-body text-[0.925rem] leading-relaxed", className)}>
      <ReactMarkdown components={{ pre: Pre, code: Code, a: Anchor }}>{content}</ReactMarkdown>
    </div>
  );
}

function Pre({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function Anchor({ children, href }: { children?: ReactNode; href?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const text = String(children ?? "").replace(/\n$/, "");
  const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1] ?? "";
  // Bloco = veio com linguagem ou tem quebra de linha (fence).
  const block = Boolean(lang) || text.includes("\n");

  if (!block) {
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-code text-[0.85em] text-foreground">{text}</code>
    );
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-1">
        <span className="font-code text-[0.7rem] tracking-wide text-muted-foreground uppercase">
          {lang || "texto"}
        </span>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto p-3">
        <code className="font-code text-[0.8rem] leading-relaxed">{text}</code>
      </pre>
    </div>
  );
}
