import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SaveIcon } from "lucide-react";
import {
  fetchDiscordConfig,
  fetchModels,
  saveDiscordConfig,
  setModel,
  type DiscordConfig,
} from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const idsToText = (ids: string[] | undefined) => (ids ?? []).join("\n");
const textToIds = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export default function ConfigView({ active }: { active: boolean }) {
  const [form, setForm] = useState<DiscordConfig | null>(null);
  const [model, setModelState] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [cfg, catalog] = await Promise.all([fetchDiscordConfig(), fetchModels()]);
      setForm(cfg);
      setModels(catalog.models);
      setModelState(catalog.model);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha ao carregar");
    }
  }, []);

  useEffect(() => {
    if (active && !form) void load();
  }, [active, form, load]);

  if (!form) {
    return (
      <div className="space-y-3 p-4">
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const set = (patch: Partial<DiscordConfig>) => setForm({ ...form, ...patch });

  const save = async () => {
    setSaving(true);
    try {
      await saveDiscordConfig(form);
      if (model !== undefined) await setModel(model);
      toast.success("Config salva (Discord vale na reinicialização)");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "falha ao salvar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>Discord</CardTitle>
          <CardDescription>Servidor, canais acompanhados e papéis. Vale na reinicialização.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="block text-sm">
            Servidor (guild_id)
            <Input value={form.guild_id} onChange={(e) => set({ guild_id: e.target.value })} />
          </label>
          <label className="block text-sm">
            Canais (um ID por linha)
            <Textarea
              rows={3}
              value={idsToText(form.channel_ids)}
              onChange={(e) => set({ channel_ids: textToIds(e.target.value) })}
            />
          </label>
          <label className="block text-sm">
            Admins (um ID por linha)
            <Textarea
              rows={2}
              value={idsToText(form.admin_ids)}
              onChange={(e) => set({ admin_ids: textToIds(e.target.value) })}
            />
          </label>
          <label className="block text-sm">
            ID p/ o chat web (papel do painel; vazio = usuário)
            <Input value={form.web_user_id} onChange={(e) => set({ web_user_id: e.target.value })} />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Personalidade e modelo</CardTitle>
          <CardDescription>System prompt do bot e modelo de chat.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="block text-sm">
            Personalidade
            <Textarea
              rows={8}
              value={form.personality}
              onChange={(e) => set({ personality: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            Modelo de chat
            <Input
              value={model}
              list="model-catalog"
              onChange={(e) => setModelState(e.target.value)}
              placeholder="(padrão do pi)"
            />
            <datalist id="model-catalog">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <Button onClick={save} disabled={saving}>
            <SaveIcon className="mr-2 h-4 w-4" />
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
