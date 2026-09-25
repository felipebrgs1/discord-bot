import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

// Copiar com feedback: clipboard falha em contexto não-seguro, e sem o catch o
// "copiado" simplesmente não aparece e ninguém sabe por quê.
export function CopyButton({ text, className, label }: { text: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("não foi possível copiar (permissão do navegador)");
    }
  }

  return (
    <Button
      variant="ghost"
      size={label ? "xs" : "icon-xs"}
      className={cn("text-muted-foreground", className)}
      onClick={copy}
      aria-label={label ?? "Copiar"}
    >
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      {label ? (copied ? "copiado" : label) : null}
    </Button>
  );
}
