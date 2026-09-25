export type View = "conversa" | "aprendizado" | "logs" | "config" | "metricas";

export const VIEW_IDS: readonly View[] = ["conversa", "aprendizado", "logs", "config", "metricas"] as const;

export const VIEW_LABEL: Record<View, string> = {
  conversa: "Conversa",
  aprendizado: "Aprendizado",
  logs: "Logs",
  config: "Config",
  metricas: "Métricas",
};

// Roteamento por hash, com correspondência EXATA (prefixo solto aceitava
// "#/logsqualquercoisa").
export function viewFromHash(hash: string): View {
  const id = hash.replace(/^#\/?/, "");
  return (VIEW_IDS as readonly string[]).includes(id) ? (id as View) : "conversa";
}

export const hashForView = (view: View) => `#/${view}`;
