# Bolão Copa 2026 — Atualização v65

Solução definitiva para o problema "times do palpite somem após recalc/reset
do bracket oficial". Adiciona snapshot dos times escolhidos em cada bet —
elimina dependência de simulação reversa.

## Diagnóstico (resumo)

| # | Pergunta | Resposta |
|---|---|---|
| 1 | `/comparativo` lê times de | `simulateBracketForUser` em `audit.ts` → aborta se `!areAllGroupsMature`. |
| 2 | `/estatisticas` lê times de | `extractUserPrediction` em `qualification.ts` → mesma dependência. |
| 3 | `/admin/apostas` lê | `BetsAdminTable.tsx` → mesma simulação local. |
| 4 | Auditoria mantém | `buildBetAudit` tem fallback `findRealKnockoutMatchup` — mas exige resultado real. |
| 5/6 | `audit_log` ajuda? | **Não** — só guarda ações admin (action + JSON payload). Sem times. |
| 7 | `user_qualification_scores` ajuda? | Só parcialmente — tem `(user_id, phase, team_id)` agregado, não associa ao slot. **Inútil para backfill por bet**. |
| 8 | Backfill confiável? | Sim para grupos (trivial). Para KO: simulação tolerante por usuário (sem guard de maturidade). |
| 9 | Arquivos alterados | 9 (2 novos, 7 modificados). |
| 10 | Migration SQL | Sim, 008 — só `ADD COLUMN` (nullable). Idempotente. |
| 11 | Apostas preservadas? | **Sim** — só adiciona colunas nullable. Migration não toca em nenhum campo existente. Backfill só faz UPDATE em `bet_home_team_id`/`bet_away_team_id` (nunca em scores/advancer/points). |

## Arquivos alterados (2 novos + 7 modificados)

### Novos
| Arquivo | O que faz |
|---|---|
| `supabase/migrations/008_bet_team_snapshot.sql` | ADD COLUMN `bet_home_team_id`, `bet_away_team_id` (nullable) em `bets`. Índices. Idempotente. |
| `app/api/admin/backfill-bet-snapshots/route.ts` | POST autenticado (admin). Itera todas as bets, popula snapshots por (a) match de grupo → trivial; (b) simulação tolerante por usuário (sem `areAllGroupsMature`); (c) bracket oficial como último recurso. **Nunca sobrescreve** snapshots já gravados, exceto com `?force=true`. Retorna relatório completo. |

### Modificados
| Arquivo | Mudança |
|---|---|
| `types/database.ts` | `Bet.bet_home_team_id?: number \| null`, `bet_away_team_id?: number \| null`. |
| `app/api/bets/save/route.ts` | Zod aceita os 2 snapshots (opcionais). Upsert preserva snapshot existente quando o cliente não envia. |
| `components/BetForm.tsx` | No `saveBet`, calcula `teamForMatchSide(matchObj, 'home/away')?.id` e envia no payload. |
| `lib/bolao/audit.ts` (`buildBetAudit`) | Prioriza `bet.bet_home_team_id` / `bet_away_team_id`. Fallback: realHome/realAway (grupos) ou simulação (KO). |
| `lib/bolao/qualification.ts` (`extractUserPrediction`) | Aplica snapshots em `simMatches` antes de simular. Quando grupos não estão maduros, pula `simulateBracket` e chama `extractAdvancingTeams` direto — slots com snapshot rendem times, slots sem não entram. |
| `components/BetsAdminTable.tsx` (`simByUser`) | Prioriza snapshots; cai pra simulação só para slots ainda nulos. |

## Migration 008 (rodar 1× no Supabase)

```sql
-- supabase/migrations/008_bet_team_snapshot.sql
alter table public.bets
  add column if not exists bet_home_team_id int references public.teams(id),
  add column if not exists bet_away_team_id int references public.teams(id);

create index if not exists idx_bets_bet_home_team_id on public.bets(bet_home_team_id);
create index if not exists idx_bets_bet_away_team_id on public.bets(bet_away_team_id);

comment on column public.bets.bet_home_team_id is '...';
comment on column public.bets.bet_away_team_id is '...';
```

Idempotente. **Não apaga nada**. Não toca em RLS (a tabela `bets` já tem
policies "User reads own" + admin + lock — os campos novos herdam).

## Como rodar (passo a passo)

```bash
# 1) Aplicar os 9 arquivos do zip
# 2) Abrir Supabase SQL Editor → colar conteúdo de 008 → Run
#    (smoke test SQL no rodapé do arquivo)

# 3) Deploy local
rm -rf .next
npm run dev

# 4) BACKFILL — fazer login como admin no app, depois rodar:
#    Via DevTools → Network → copiar cURL de qualquer endpoint /api,
#    ou via terminal com cookie:
curl -X POST https://SEU_DOMINIO/api/admin/backfill-bet-snapshots \
  -H "Cookie: <cookies-do-admin-logado>"

# Resposta (exemplo):
# {
#   "success": true,
#   "report": {
#     "total_bets": 234,
#     "ko_bets": 96,
#     "filled_from_group_match": 138,
#     "filled_from_simulation": 78,
#     "filled_from_bracket_official": 0,
#     "unchanged_already_filled": 0,
#     "pending": 18,
#     "pending_list": [ { bet_id, user_id, match_id, phase, missing_home, missing_away } ],
#     "force": false,
#     "ms": 245
#   }
# }

# 5) Conferir nas telas:
#   /apostas (logado) — salva nova aposta → confere via SQL que bet_home_team_id/away foi gravado
#   /comparativo — não mostra mais "—" para usuários com snapshots preenchidos
#   /estatisticas — cards mantêm os times mesmo após recalc/reset do bracket
#   /admin/apostas — coluna times A/B já vem dos snapshots
#   /admin/pontuacao — coluna Time A/B (palpite) já vem dos snapshots

# 6) Build local
npm run lint && npm run build
```

## Estratégia do backfill (objetiva)

```
para cada bet:
  se match é group_stage_*:
    snapshot = (match.home_team_id, match.away_team_id)    ← fonte 1: trivial
  senão (KO):
    snapshot = simulação_tolerante(usuário)                ← fonte 2: melhor esforço
    se snapshot ainda nulo:
      snapshot = (match.home_team_id, match.away_team_id)  ← fonte 3: bracket oficial
  if snapshot mudou e (?force OR não estava preenchido):
    UPDATE bets SET bet_home_team_id = ..., bet_away_team_id = ...
```

A simulação tolerante (rota de backfill) é igual à `extractUserPrediction`
nova: aplica os palpites do usuário aos matches, computa `standings` com o
que houver (mesmo que grupos parciais), tenta `simulateBracket`. Slots que
não resolvem ficam null — entram no `pending_list` do relatório.

## Proteção contra recalc/reset

`lib/bolao/recalc.ts` foi conferido: as únicas operações de UPDATE em `bets`
são `update({ points, points_with_zebra })` (em `recalcMatchAndAllBets` e
`recalcKnockoutMatchupsForAllUsers`). **Nunca tocam em `bet_home_team_id` /
`bet_away_team_id`**. Logo, "Recalcular tudo" e "Reset placares" são imunes.

Idem `resetAllResults`: só zera matches + bets.points + delete em
user_qualification_scores. Snapshots seguem intactos.

## Checklist de validação

### Segurança dos dados
- [ ] Nenhuma linha de `bets` é apagada (migration só ADD COLUMN).
- [ ] `home_score`/`away_score`/`home_pens`/`away_pens`/`knockout_advancer`
      seguem intactos (smoke test SQL #2 confirma).
- [ ] Snapshots já preenchidos não são sobrescritos (sem `?force=true`).
- [ ] "Recalcular tudo" não apaga snapshots.
- [ ] "Reset all results" não apaga snapshots.

### Backfill
- [ ] Recupera snapshots de fase de grupos via match (trivial, 100%).
- [ ] Recupera snapshots de KO via simulação tolerante (sem guard de maturidade).
- [ ] Não depende de resultados reais da Copa.
- [ ] Gera relatório com counts + lista de pendentes.
- [ ] Reexecutável com segurança (sem `force` → não sobrescreve).

### Novas apostas
- [ ] `POST /api/bets/save` aceita `bet_home_team_id`/`bet_away_team_id`.
- [ ] `BetForm` envia esses campos no save de cada aposta.
- [ ] Aposta de grupo: `bet_home_team_id = match.home_team_id`.
- [ ] Aposta de KO com slot resolvido (via simulação local): snapshot enviado.
- [ ] Aposta de KO com slot ainda indefinido: snapshot enviado como null.
- [ ] Autosave continua funcionando (debounce + race-guard intactos).
- [ ] Lock de apostas continua bloqueando.

### Comparativo
- [ ] `/comparativo` mostra times A/B vindo dos snapshots.
- [ ] Após `recalcBracket()` zerar `matches.*_team_id`, snapshots seguem
      mostrando os times do palpite.
- [ ] Destaque visual (azul/vermelho/cinza) intacto.
- [ ] Ordenação por ranking intacta.

### Estatísticas
- [ ] `/estatisticas` mantém cards de todas as fases preenchidos com base
      em snapshots, mesmo sem `areAllGroupsMature`.

### Admin
- [ ] `/admin/apostas` mostra Time A/B dos snapshots; CSV inclui times.
- [ ] `/admin/pontuacao` (auditoria) mostra Time A/B (palpite) dos snapshots.

### Geral
- [ ] Pontuação não muda (recalc usa scores, não times).
- [ ] Ranking não muda.
- [ ] Home, hero, favicon, PixCopyBox, TeamNameWithFlag intocados.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **1 migration** (008, idempotente, ADD COLUMN nullable).
- **1 rota nova** (`/api/admin/backfill-bet-snapshots`).
- **7 arquivos modificados** — todos retroativamente compatíveis (fallback
  pra simulação quando snapshot é null).
- **0 alterações** em RLS, scoring, recalc.ts, audit_log, ranking views.
- Apostas existentes 100% preservadas.

Próxima vez que rodar "Recalcular tudo" ou "Reset results", os usuários
NÃO perderão a visualização dos seus palpites — os snapshots ficam.
