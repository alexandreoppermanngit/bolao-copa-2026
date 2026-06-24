# Bolão Copa 2026 — Atualização v76

Dois ajustes pequenos:

1. **`/ranking`**: troca a coluna "Apostas" por **"Jogos"** + **"Classificados"**.
2. **`lib/bolao/qualification.ts`**: remove a função morta `emptyPrediction`
   que quebrava o lint.

Sem migration. Sem alterar cálculo/recálculo.

## Diagnóstico

| # | Resposta |
|---|---|
| 1 | `app/ranking/page.tsx` (Server Component). |
| 2 | Tabela renderizada inline na mesma página (sem sub-component). |
| 3 | Antes da v76: lia da view `user_rankings` (subset). |
| 4 | A subset NÃO tem `game_points`/`qualification_points` separados — mas `user_rankings_full` (a base) tem. v76 passa a ler dela. |
| 5 | Coluna "Apostas" lia `r.total_bets`. |
| 6 | "Jogos" → `game_points`. "Classificados" → `qualification_points`. Ambos já calculados pelo recalc — zero duplicação. |
| 7 | Sim, `emptyPrediction` existia em `qualification.ts:287`. |
| 8 | Sim — grep confirma única ocorrência era a declaração. Ficou órfã quando v72 reescreveu `extractUserPrediction` para chamar `extractAdvancingTeams(simMatches, hints)` direto. |
| 9 | 2 arquivos. |
| 10 | **Sem migration** — `user_rankings_full` já tem todos os campos. |
| 11 | Sim, cálculo/recálculo **intocados**. v76 é só leitura + apresentação. |

## Layout antes vs depois

```
ANTES:  Pos | Apostador | Pontos | Acertos | Placares Exatos | Apostas
DEPOIS: Pos | Apostador | Pontos | Jogos | Classificados | Acertos | Placares Exatos
```

- "Pontos" continua sendo `total_points` (soma de jogos + classificados).
- "Jogos" = `game_points` (já calculado pelo recalc).
- "Classificados" = `qualification_points` (já calculado pelo recalc).
- "Acertos" continua sendo `games_correct` (renomeado na view full —
  na subset era `correct_results`).
- "Placares Exatos" continua sendo `exact_scores`.
- Coluna **"Apostas"** (`total_bets`) **removida**.

### Mobile

Cabeçalhos usam classes responsivas (`hidden sm:inline` / `sm:hidden`)
para encurtar nomes em mobile:
- "Classificados" → "Classif."
- "Acertos" → "Ac."
- "Placares Exatos" → "Exatos"
- "Jogos" mantém (curto).

A tabela já usa `overflow-x-auto` no wrapper — não regride mobile.

## Arquivos alterados (2) · 0 migrations

| Arquivo | Mudança |
|---|---|
| `app/ranking/page.tsx` | • `.from('user_rankings')` → `.from('user_rankings_full')`.<br>• Interface `RankingRow` ganha `game_points` e `qualification_points`; usa `games_correct` (nome da full).<br>• `<thead>` perde "Apostas" e ganha "Jogos" + "Classificados".<br>• `<tbody>` renderiza os dois novos números formatados com `.toFixed(1)`.<br>• Cabeçalhos têm versões responsivas para mobile. |
| `lib/bolao/qualification.ts` | Remove `function emptyPrediction()` (não usada desde v72). Deixa comentário curto explicando por que foi removida. |

## O que **não** muda

- ✅ Cálculo de pontos (jogos / classificados / total).
- ✅ Recálculo (`/api/recalc`, `recalc.ts`).
- ✅ Views SQL (`user_rankings`, `user_rankings_full`, `user_rankings_zebra`,
  `match_bet_distribution`, `group_standings`).
- ✅ Banco / migrations / RLS.
- ✅ Ranking zebra.
- ✅ Admin, apostas, snapshots.
- ✅ Gate v72, head-to-head v75.
- ✅ Posição (`order by position` permanece).

## Como aplicar e testar

```bash
# 1) Aplicar os 2 arquivos do zip
# 2) Build local
rm -rf .next && npm run lint && npm run build && npm run dev

# 3) Smoke /ranking:
#    a) Conferir que coluna "Apostas" sumiu.
#    b) Conferir colunas novas "Jogos" e "Classificados" preenchidas.
#    c) "Pontos" = "Jogos" + "Classificados" (visualmente conferível).
#    d) Top-3 com emojis 🥇🥈🥉 continua.
#    e) Mobile (DevTools responsivo): nomes curtos visíveis, sem quebra de layout.

# 4) Smoke lint:
npm run lint
# Esperado: warning 'emptyPrediction is defined but never used' SUMIU.
```

## Checklist

### Ranking
- [ ] `/ranking` abre normalmente.
- [ ] Coluna "Apostas" foi removida.
- [ ] Colunas "Jogos" e "Classificados" aparecem com valores corretos.
- [ ] "Pontos totais" continua igual (soma já feita pelo recalc).
- [ ] Ordenação por `position` preservada.
- [ ] Top-3 com emojis preservado.
- [ ] Mobile: nomes curtos `Classif.` / `Ac.` / `Exatos` aparecem em telas pequenas.

### Ranking zebra
- [ ] `/ranking-zebra` continua funcionando (lê de `user_rankings_full`, intocado).

### Lint
- [ ] `npm run lint` passa sem erro de `emptyPrediction`.
- [ ] Sem `eslint-disable` adicionado.

### Sem regressão
- [ ] Pontuação não recalculada.
- [ ] Views SQL não alteradas.
- [ ] `npm run build` passa.

## Resumo

- **2 arquivos modificados**, **0 novos**, **0 migrations**.
- Leitura passou de `user_rankings` (subset) para `user_rankings_full` (base).
- Zero duplicação de cálculo no frontend.
- `emptyPrediction` removida de vez (não era usada desde v72).
