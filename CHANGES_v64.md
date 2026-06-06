# Bolão Copa 2026 — Atualização v64

`/comparativo` agora abre automaticamente no **jogo do momento**:

1. Jogo em andamento (janela de 2 horas a partir do kickoff).
2. Próximo jogo futuro mais próximo.
3. Último jogo da lista (após Copa terminar).
4. Sem matches → fallback no id 1.

`?jogo=X` na URL continua tendo prioridade (compartilhamento de link
preserva o comportamento).

## Diagnóstico (resumo)

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Arquivo do jogo inicial | `app/comparativo/page.tsx` linha 110: `searchParams.jogo ? Number(...) : 1`. |
| 2 | Campos de data/hora em matches | `match_date` (YYYY-MM-DD) + `kickoff_brt` (HH:MM). Não há ISO único — compor. |
| 3 | Ordenação atual | `order('id')` — id sequencial coincide com ordem cronológica (seed segue calendário). |
| 4 | Cálculo do jogo atual/próximo | `now ∈ [kickoff, kickoff + 2h)` → live; senão menor kickoff > now; senão último. |
| 5 | Janela de 2h | `MATCH_DURATION_MS = 2 * 60 * 60 * 1000`. |
| 6 | Empate de horário | Sort estável por `(kickoff asc, id asc)` — primeiro vence. |
| 7 | Arquivos alterados | 1 novo (`lib/bolao/matchSchedule.ts`) + 1 modificado (`app/comparativo/page.tsx`). |
| 8 | Migration SQL | **Nenhuma.** |

## Timezone

Brasil não tem horário de verão desde 2019 → BRT = UTC-3 fixo.
`matchKickoffDate(m)` monta ISO com offset explícito:
```ts
`${m.match_date}T${m.kickoff_brt.slice(0,5)}:00-03:00`
```
Funciona corretamente independente do fuso do servidor (Vercel pode rodar
em qualquer região — o `Date` parseia ISO com offset corretamente).

## Arquivos alterados (1 novo + 1 modificado)

| Arquivo | Mudança |
|---|---|
| `lib/bolao/matchSchedule.ts` | **NOVO** — exporta `matchKickoffDate(match)` e `pickInitialMatchId(matches, now?)`. |
| `app/comparativo/page.tsx` | • Import de `pickInitialMatchId`.<br>• `initialMatchId` default vira `pickInitialMatchId((matches ?? []) as Match[]) ?? 1` (mantém `?jogo=` com prioridade). |

## Helper novo

```ts
// lib/bolao/matchSchedule.ts

export function matchKickoffDate(m): Date | null {
  // BRT (UTC-3) fixo
  return new Date(`${m.match_date}T${m.kickoff_brt.slice(0,5)}:00-03:00`);
}

export function pickInitialMatchId(matches, now = new Date()): number | null {
  const sorted = matches
    .map(m => ({ m, t: matchKickoffDate(m)?.getTime() ?? Infinity }))
    .sort((a,b) => a.t - b.t || a.m.id - b.m.id);
  const nowMs = now.getTime();
  const live = sorted.find(({t}) => t <= nowMs && nowMs < t + 7_200_000);
  if (live) return live.m.id;
  const next = sorted.find(({t}) => t > nowMs);
  if (next) return next.m.id;
  return sorted.at(-1)?.m.id ?? null;
}
```

## Regra de seleção inicial (objetiva)

```
se ?jogo=X            → X
senão se há live       → menor (kickoff, id) entre os live
senão se há futuro     → menor (kickoff, id) entre os futuros
senão                 → último (kickoff, id) da lista
senão                 → 1 (lista vazia, defensivo)
```

## Comandos para testar

```bash
# Página é Server Component com force-dynamic — cada acesso reavalia `new Date()`.
rm -rf .next
npm run dev

# Cenário A — Sem ?jogo=
#   Antes da Copa: /comparativo abre no jogo #1 (primeiro do calendário).
#   Durante a Copa (ex: 11/06/2026 16:30 BRT, com jogo às 16:00):
#     /comparativo abre no jogo das 16:00 (live).
#   Entre jogos (ex: 11/06 18:30, sem jogos rolando):
#     /comparativo abre no próximo (ex: 11/06 22:00 ou 12/06 13:00).
#   Após a Copa (20/07/2026):
#     /comparativo abre no último jogo (final).

# Cenário B — Com ?jogo=42
#   /comparativo?jogo=42 → abre no jogo 42 (heurística IGNORADA — compartilhar link funciona).

# Lint + build
npm run lint && npm run build
```

## Checklist de validação

- [ ] `/comparativo` abre jogo em andamento se houver (janela 2h).
- [ ] Jogo iniciado há < 2h é considerado atual.
- [ ] Jogo iniciado há > 2h **não** é atual (passa pro próximo).
- [ ] Dois jogos simultâneos → seleciona o de menor id (= primeiro da ordem).
- [ ] Sem jogo atual → próximo futuro mais próximo.
- [ ] Todos passaram → último jogo da lista.
- [ ] `?jogo=X` na URL ainda funciona (prioritário).
- [ ] Seletor de jogo (combo + input) continua trocando manualmente.
- [ ] Destaque visual de vitória/empate (v61) intacto.
- [ ] Ordem por ranking (v61) intacta.
- [ ] Pontuação inalterada.
- [ ] Sem migration SQL.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **1 arquivo novo** + **1 modificado**.
- **0 migrations**.
- **0 alterações** em scoring, ranking, recálculo, RLS, schema.
- Helper isolado e testável — `now` é injetável (`pickInitialMatchId(matches, now)`).
