# Relatório: pi → discord-bot (fork com sincronia ao upstream)

Data: 2026-09-25 · Autor: Muse Spark

## 1. Estado atual (verificado)

```
/home/ubuntu/bot/
├── botdiscord/    → origin: felipebrgs1/botdiscord (Go, bot atual em produção)
└── discord-bot/   → origin: felipebrgs1/discord-bot (fork do pi)
                     upstream: earendil-works/pi (oficial)
                     branch: main, limpo, sync com origin/main
```

O fork está correto: `origin` aponta para o seu repositório e `upstream`
aponta para o pi oficial. A sincronia se mantém via `git fetch upstream`.

## 2. Regra de ouro da sincronia

**Nunca edite arquivos do pi fora de diretórios próprios do bot.**
Todo merge do `upstream/main` deve resultar em *fast-forward* ou conflito
só em arquivos que você não tocou.

| Pode editar/criar | NÃO tocar |
|---|---|
| `packages/discord-bot/**` (novo, seu) | `packages/agent/**` |
| `extensions/discord/**` (novo, seu) | `packages/coding-agent/src/**` |
| `docs/discord-bot-*.md` (novo, seu) | `packages/ai/**`, `packages/tui/**` |
| `package.json` (só bloco `workspaces` + deps do bot) | `package-lock.json` do upstream sem necessidade |
| `.github/workflows/discord-bot-*` (novo) | workflows existentes |

Se precisar mudar comportamento do core (ex.: expor um hook, liberar
uma tool), prefira **extension + hook público** a patch no core. Patch no
core só em último caso, isolado em commit próprio com prefixo
`discord-bot:` para facilitar `cherry-pick`/`rebase`.

## 3. Estrutura proposta (tudo novo, zero colisão)

```
discord-bot/
├── packages/
│   ├── agent/ ... (upstream, intocado)
│   ├── coding-agent/ ... (upstream, intocado)
│   ├── session-backends/sqlite-node/ ... (upstream, REUSADO como está)
│   └── discord-bot/            ← NOVO: seu pacote
│       ├── package.json        (deps: discord.js + @earendil-works/pi-coding-agent: workspace.
│       │                        SEM pg, SEM pgvector, SEM yaml — só node:sqlite, nativo)
│       ├── src/
│       │   ├── gateway.ts      (Discord: eventos, fila, cooldown, split de texto)
│       │   ├── sessions.ts     (Map<channelId, AgentSession> via createAgentSession)
│       │   ├── roles.ts        (admin/mod/user lido do SQLite)
│       │   ├── db.ts           (DatabaseSync + migrations + tabelas do bot)
│       │   ├── config.ts       (config key-value no SQLite, com defaults em código)
│       │   ├── memory.ts       (consolidação, FTS5, rolling summary — tudo SQLite)
│       │   └── index.ts        (composition root: db → config → serviços → gateway)
│       └── extensions/
│           ├── memory-tools.ts (memory_search via FTS5, search_history, save_memory)
│           ├── media-tools.ts  (download_media, caption_video, make_gif, generate_image)
│           └── context-hook.ts (on "input": injeta familiaridade + resumo no turno)
```

Por que pacote separado e não editar `coding-agent`? Porque
`git merge upstream/main` nunca vai tocar em `packages/discord-bot/`
— o upstream não tem esse diretório. Conflito impossível ali.

## 4. Workflow git (sincronia)

```bash
cd discord-bot
git fetch upstream

# 1. Atualizar (semanal ou antes de feature grande):
git checkout main
git merge upstream/main        # prefira merge a rebase no main do fork
git push origin main

# 2. Feature do bot (sempre em branch, nunca no main direto):
git checkout -b discord-bot/gateway
# ... edita SÓ packages/discord-bot/** ...
git commit -m "discord-bot: gateway Discord básico"
git push -u origin discord-bot/gateway   # PR contra seu próprio main
```

Comandos proibidos no fork: `git push -f origin main`,
`git push upstream` (você não tem permissão mesmo), commit de
`node_modules/`, `.env`, tokens.

## 5. Dependência do pi: workspace, não cópia

`packages/discord-bot/package.json` usa a versão workspace do monorepo:

```json
{ "dependencies": { "@earendil-works/pi-coding-agent": "workspace:*" } }
```

Isso garante que o bot sempre compila contra o pi atual do fork.
Quando o upstream lança versão nova, é só o `merge` da seção 4 —
nada de copiar arquivos.

## 6. Reuso do botdiscord (Go) — o que migrar e como

> DECISÃO (2026-09-25): **SQLite no lugar de Postgres, config no SQLite
> (sem YAML), sem rerank e sem vector por enquanto.** O Go NÃO é reusado
> como banco compartilhado — o bot novo nasce com banco próprio. Migração
> de memória antiga do Postgres é fase futura e opcional (export JSON).

| Módulo Go atual | Destino no fork | Esforço |
|---|---|---|
| `adapters/discord` (eventos, fila, cooldown) | `packages/discord-bot/src/gateway.ts` (discord.js) | 1–2 dias |
| `agent` loop custom ReAct | **jogado fora** — pi core assume | 0 |
| `pi-sidecar/sidecar.mjs` (tools Go via JSONL) | `extensions/*-tools.ts` nativas em TS | 2–3 dias |
| `adapters/postgres` + migrações | **jogado fora** — `db.ts` com `node:sqlite` + migrações próprias | 1 dia |
| `memory` consolidação + recuperação | `memory.ts` + `memory-tools.ts`, busca **FTS5** (sem embeddings) | 3–5 dias |
| embeddings OpenRouter + rerank voyage | **REMOVIDO** — zero chamada extra por resposta (só o chat) | 0 |
| `config.yaml` + `.env` | tabela `config` no SQLite + env só p/ segredos | 1 dia |
| `participation` (iniciativa, cota, shadow) | hook + tabelas SQLite | 3–5 dias |
| painel web + métricas | **fase 2** — SQLite já guarda `ai_requests`; UI depois | 0 agora |

Banco novo e independente (`data/bot.db`): nada compartilhado com o Go,
nada de Docker, nada de pgvector. Rodar os dois bots ao mesmo tempo no
mesmo canal continua proibido (resposta duplicada).

## 7. Riscos e mitigação

1. **Drift do upstream** — pi muda API (`createAgentSession`, `defineTool`).
   Mitigação: pinar merge semanal + `npm run check` + `test` do fork após
   cada merge; manter camada de adaptação fina (`sessions.ts`) isolando o
   resto do código das APIs do pi.
2. **Concorrência multi-canal** — pi foi feito p/ 1 usuário interativo.
   Mitigação: 1 `AgentSession` por canal, `abort()` em cooldown, limite de
   sessões simultâneas com fila (como a fila de 8 do Go).
3. **Auth de modelo em servidor** — `pi auth` é interativo.
   Mitigação: `ModelRuntime` com API key de ambiente (exemplo:
   `custom-provider-*` em `examples/extensions/`), nunca commitar chave.
4. **Permissões** — tools de shell/arquivo no Discord são perigosas.
   Mitigação: replicar a matriz admin/mod/user do Go no filtro `tools:`
   por sessão + revalidar no `execute` (padrão `permission-gate.ts`).

## 8. Fases

- **Fase 0: FEITA (2026-09-25)** — `db.ts` (13 tabelas + FTS5 + migrations
  versionadas) + `config.ts` (defaults em código, secrets só env, subscribe
  p/ hot-reload) + 7 testes vitest passando; `npm run build` OK.
  Nota: `package-lock.json` ganhou só o link do workspace (+12 linhas).
  Full `npm install` na raiz continua pendente (rede/tempo); temporariamente
  o pacote compila/testa com symlinks locais → /tmp/dbot-deps.
- **Fase 1: FEITA (2026-09-25)** — `gateway.ts` (intents Guilds+GuildMessages+
  MessageContent, triggers menção/reply, cooldown por canal, fila 8, split
  2000 chars) + `sessions.ts` (1 AgentSession por canal via SDK, recria se o
  role mudar, sweep idle 30min) + `roles.ts` (admin/mod/user, excludeTools por
  papel) + `start.ts` (composition root, token só via env). 15 testes verdes.
  Faltam só credenciais reais (DISCORD_TOKEN + `pi auth`) p/ teste ao vivo.
- **Fase 2:** `memory_search`/`search_history` via FTS5 no SQLite.
- **Fase 3:** consolidação/rolling + portão Jev + participação shadow.
- **Fase 4:** aposentar o Go (opcional: export JSON da memória antiga).

## 9. Decisões de simplificação (2026-09-25)

### 9.1 SQLite (node:sqlite, sem Postgres)

- Banco único `data/bot.db` via `node:sqlite` (nativo do Node 22.5+, zero dep).
- Sessões do pi: reusar o backend `session-backends/sqlite-node` do upstream
  (verificado: existe e funciona) — pode apontar para o **mesmo arquivo**
  `bot.db` ou um `sessions.db` separado; separado é mais seguro (merge do
  upstream nunca mexe nas suas tabelas de qualquer forma).
- Tabelas próprias do bot (tudo criado por `db.ts`, migrations versionadas):
  `messages`, `memories`, `memory_versions`, `episodes`, `rolling_summaries`,
  `interaction_events`, `skill_runs`, `participation_actions`, `open_loops`,
  `ai_requests`, `config` — espelham o vocabulário do Go, sem a parte vetorial.
- Backup = copiar o arquivo. Deploy = 1 processo Node + 1 arquivo.
- WAL mode ligado (`PRAGMA journal_mode=WAL`) para worker de consolidação
  escrever enquanto o gateway lê.

### 9.2 Sem YAML — config mora no SQLite

- Tabela `config(key TEXT PRIMARY KEY, value TEXT)` com JSON por valor.
- `config.ts` expõe `get/set` + **defaults em código** (o bot funciona com banco
  zerado; nada de arquivo obrigatório).
- Segredos (DISCORD_TOKEN, CHAT_API_KEY) continuam em **env** — nunca no banco.
- Sem validador de YAML, sem `UpdateChatModel` preservando comentários, sem
  editor de YAML no painel futuro (vira formulário simples sobre a tabela).
- Troca de modelo em quente: continua valendo, mas lendo a linha `chat.model`
  do SQLite (poll por mtime vira poll por `updated_at` ou evento interno).
- Migração do `config.yaml` atual do Go: **não** — recomeça com defaults e
  ajusta pelo futuro painel/comando; o YAML do Go morre com o Go.

### 9.3 Sem vector, sem rerank (por enquanto)

- Nenhuma chamada a `/embeddings` nem `/rerank`: cada resposta = 1 chamada
  de chat (+1 do portão Jev, se ligado). Custo e latência caem.
- Recuperação de memória em 3 camadas baratas, tudo no SQLite:
  1. **Familiaridade** — preferências/lições do interlocutor+canal, `SELECT`
     direto, entra em toda resposta (igual ao Go, sem busca).
  2. **FTS5** — tabela virtual `memories_fts` (tokenizer `unicode61`, que lida
     bem com português); `memory_search` faz `MATCH` + filtro de escopo
     (canal + shared) + ordenação por `rank + recência`.
  3. **search_history** — FTS sobre `messages` (o "lembra quando..."), com
     contexto adjacente por `seq`.
- Portão Jev (TypeSafe) continua opcional e inalterado: ele decide SE busca,
  não COMO busca — com FTS5 o custo do "sim" é ~zero (sem embedding).
- Quando vector fizer falta (acervo grande, paráfrases que FTS não pega):
  SQLite tem `sqlite-vec` como extensão carregável — adiciona coluna binária
  + busca kNN sem trocar de banco. Coluna `embedding BLOB` pode já nascer
  prevista (nullable) para não migrar depois.

## 10. pnpm (2026-09-25)

- Instalação via **pnpm** (`pnpm-workspace.yaml` novo espelha os globs de
  `workspaces`; pnpm não lê o campo npm, a lista é duplicada — manter em sync).
- Settings camelCase (`linkWorkspacePackages`, `preferWorkspacePackages`);
  kebab-case é ignorado com warning e congela resolução no registry.
- Manter `package-lock.json` intocado na medida do possível; fonte de verdade
  passa a ser `pnpm-lock.yaml` (novo, sem conflito).
- `packageExtensions` no yaml declara `@smithy/types` p/ `pi-ai` (gap do
  upstream que o hoisting do npm mascara) — **zero arquivos upstream editados**.
- Builds de deps liberados via `allowBuilds` (`pnpm approve-builds`).

## 11. Import do bot antigo (2026-09-25)

- `.env` novo em `packages/discord-bot/.env` (chmod 600, gitignored):
  `DISCORD_TOKEN` + `OPENROUTER_API_KEY` copiados do `botdiscord/.env`.
  `OPENCODE_API_KEY`/`CHAT_API_KEY`/`DATABASE_URL`/`POSTGRES_PASSWORD` sem
  uso no TS (pi usa auth própria; banco é SQLite) — documentados no `.env`.
- `data/bot.db` semeado via `scripts/seed.mjs` a partir do `config.yaml`:
  guild, 2 canais, admin/mod, `chat.model` mimo-v2.6-flash (**legado**: o pi
  resolve modelo pelo próprio catálogo — remapear se não existir),
  personality ElMatadore integral, cooldown 4s, batch 10, intervalo 90s.
- `judge.enabled=false` (no Go era true): sem busca implementada, cada
  chamada Jev seria desperdício — **reativar na Fase 2**.
- Segredos nunca impressos em log/tela; `git check-ignore` validado p/ `.env` e `data/`.
- **Auth (sem `pi auth` interativo):** o SDK resolve API key do env
  (`getEnvApiKey`, lido na hora da chamada) + usa `defaultProvider`/
  `defaultModel` do `~/.pi/agent/settings.json` quando a sessão não passa
  modelo. Pro bot headless basta `OPENCODE_API_KEY` no `.env` (já copiada)
  — `start.ts` carrega o `.env` antes de criar sessões. `auth.json` já tinha
  login `opencode-go` (cinto + suspensórios). Smoke test real OK (2026-09-25):
  `sessions.ask('smoke','user',…)` respondeu via `muse-spark-1.3-contributor`.

## 12. Virada Go → TS (2026-09-25)

- `elmatadore.service` (Go): **stopped + disabled**. `discord-bot.service`
  (TS): **running + enabled** — online como `elmatadoreGO#2350`.
- Rollout seguro: `discord.channel_ids` = só o canal de teste
  (`1474879661530939392`); `#geral` reativa com um `config.set`.
- Rollback (se precisar): `sudo systemctl stop discord-bot && sudo
  systemctl enable --now elmatadore`.
- Bug achado na virada: `ConfigStore.load()` aplicava seções DEPOIS das
  chaves pontuais (seçãoheated apagava o ajuste fino) — invertido + teste
  de regressão (16 testes verdes).
- Nota: dashboard do Go (porta 8080) morreu junto — Fase 4 futura.

## 13. Próximo comando sugerido

```bash
cd /home/ubuntu/bot/discord-bot
mkdir -p packages/discord-bot/src packages/discord-bot/extensions docs
# criar packages/discord-bot/package.json + tsconfig, registrar no workspaces do root
npm run build   # tem que passar antes de qualquer lógica
```
