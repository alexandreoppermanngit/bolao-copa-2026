# Bolão Copa 2026 — Atualização v56

Corrigir a contagem de seleções por fase em `/estatisticas` e adicionar o card
"Vice (perdedor da final)". A mesma correção também conserta um bug latente
no cálculo da **pontuação de classificação** (admin → recalc), que usa as
mesmas funções compartilhadas.

## Diagnóstico

### 1. De onde `/estatisticas` extrai as seleções por fase

`app/estatisticas/page.tsx` chama `buildPredictionCensus(...)` em
`lib/bolao/qualification.ts`, que por sua vez:

1. Para cada usuário, chama `extractUserPredictedTeams(...)`.
2. Esta função simula a árvore com `simulateBracket(...)` — que **já usa**
   `knockout_advancer` para resolver os placeholders downstream (`winner_M…`).
3. Em seguida chama `extractAdvancingTeams(resolved)` para extrair os times
   que chegaram a cada fase.

### 2. Por que estavam aparecendo 15, 7, 5 e 1

`extractAdvancingTeams` usava uma função local `winnerOf(m)` que olhava só
`home_score / away_score / home_pens / away_pens`. **Ela não recebia os
`knockout_advancer` hints.**

Quando o palpite do usuário num KO é empate (ex.: 2x2) + `knockout_advancer`:

- `simulateBracket` propaga o time correto para as fases seguintes;
- mas em `extractAdvancingTeams`, ao decidir quem venceu aquele jogo, cai
  no fallback (`home_pens == null && away_pens == null`) e retorna `null`;
- consequência: **o time vencedor não entra no Set da fase** correspondente.

Cada empate-com-hint nos palpites do usuário "engole" 1 time da fase:

| Palpite | Efeito observado |
|---|---|
| 1 empate em R32 (16-avos) | `r32` (oitavas) com 15 times em vez de 16 |
| 1 empate em R16 (oitavas) | `r16` (quartas) com 7 em vez de 8 |
| 0 empates em QF | `quarters` (semis) com 4; agregando vários usuários, podia dar 5 |
| 1 empate em SF | `semis` (finalistas) com 1 em vez de 2 |

### 3. Segundos colocados sumindo?

`group_stage` lê `home_team_id / away_team_id` dos jogos `round_of_32`.
Placeholders "1A","2B","3rd_pos_…" resolvem corretamente via
`teamByPositionCode` no `standings.ts`. **Não havia bug específico nos 2ºs.**
O que o usuário percebia provavelmente era o efeito do mesmo bug em fases
posteriores (um 2º colocado que vencia um R32 empatado com hint sumia do
card `r32`).

### 4. Impacto: só /estatisticas ou também pontuação/admin?

`lib/bolao/recalc.ts → recalcAllQualificationScores` usa as **mesmas**
funções (`extractUserPredictedTeams`, `buildPredictionCensus`,
`calculateUserQualificationScores`).

- A chave **REAL** (`extractAdvancingTeams(allMatches)`) usa jogos do banco,
  que têm pens preenchidos para os KO empatados → não era afetada.
- A chave **PREVISTA** de cada usuário (`extractUserPredictedTeams`) passava
  pelos palpites, que não têm pens → era afetada.

Portanto a pontuação de classificação no admin **também estava incorreta**
para usuários que apostaram empate + advancer em KO: eles perdiam a chance
de pontuar pelas seleções que "passaram" naqueles jogos no palpite deles.

Conserto na origem comum (`qualification.ts`) corrige `/estatisticas` E o
recalc do admin simultaneamente, sem regredir nada.

### 5. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `lib/bolao/qualification.ts` | • `extractAdvancingTeams(matches, hintsByMatchId?)` — agora aceita hints e usa `determineMatchWinnerId` (que respeita `knockout_advancer`).<br>• Novo `extractRunnerUp(matches, hints?)` — perdedor da final.<br>• Novo `extractUserPrediction(...)` — versão "full" que retorna `byPhase` + `runnerUp` numa única simulação.<br>• `extractUserPredictedTeams(...)` virou wrapper de compatibilidade.<br>• `buildPredictionCensus(...)` agora também retorna `runnerUpCounts` (Map team_id → nº de usuários). |
| `app/estatisticas/page.tsx` | • Importa `extractRunnerUp`.<br>• Atualiza `PHASE_LABELS` para a terminologia 16-avos / oitavas / quartas / semis.<br>• Adiciona `DISPLAY_ORDER` (com pseudo-phase `runner_up`) e `RUNNER_UP_LABEL`.<br>• Renderiza card "Vice" entre Campeão e Terceiro lugar, com colunas: Seleção · Apostadores · % · Foi vice?<br>• Computa `realRunnerUpId` (vice real, derivado da final). |

### 6. Migration SQL

**Nenhuma.** Apenas TypeScript. Migrations 001–005 continuam intactas.

## Regra corrigida

**Antes (v55):** ao extrair "quem chegou a cada fase" na árvore simulada de
um usuário, jogos KO empatados sem pens viravam "sem vencedor" — apesar de o
mesmo usuário ter marcado `knockout_advancer` no palpite. Resultado: as fases
posteriores ao empate ficavam com 1 seleção a menos no card, e o cálculo de
qualification points perdia esse time também.

**Depois (v56):** `extractAdvancingTeams` recebe um `Map<matchId, KoTiebreakHint>`
opcional. Em jogos empatados sem pens, ela cai no `knockout_advancer` (via
`determineMatchWinnerId` do `bracket.ts` — a mesma função que o
`simulateBracket` já usava para resolver os placeholders). Assim, a contagem
fica consistente: o time que avança na árvore é exatamente o time contado
na fase seguinte. O `extractUserPrediction` passa os hints automaticamente.

## Visualização nova

Card extra em `/estatisticas`:

- **Vice (1 seleção) — informativo (não pontua)**
- Mostra todas as seleções apostadas como perdedoras da final, com
  Apostadores, %, e marcação "Foi vice?" quando a final real já aconteceu.
- **Não entra no scoring** — `PHASE_ORDER` permanece com 7 fases e
  `user_qualification_scores` continua igual. O scoring só passaria a
  contemplar `runner_up` se uma futura migration adicionasse
  `pts_qual_runner_up` em settings + nova phase no enum.

Ordem de exibição em `/estatisticas` (DISPLAY_ORDER):

1. Classificados da fase de grupos para os 16-avos (32 times)
2. Classificados para as oitavas (16 times)
3. Classificados para as quartas (8 times)
4. Classificados para as semifinais (4 times)
5. Finalistas (2 times)
6. Campeão (1 seleção)
7. **Vice (1 seleção)** ← novo
8. Terceiro lugar (1 seleção)

## Como testar com usuário de árvore completa

### Cenário base
1. Logar como um usuário com **todos os 104 palpites** preenchidos
   (incluindo `knockout_advancer` em todos os KO empatados).
2. Caso o usuário esteja em modo "apostas abertas + não-admin", ele vê só
   a sua base. Ideal para validar o per-user.

### Contagens esperadas por usuário (árvore completa)
- Classificados para 16-avos: **32**
- Classificados para oitavas: **16**
- Classificados para quartas: **8**
- Classificados para semifinais: **4**
- Finalistas: **2**
- Campeão: **1**
- **Vice: 1**
- Terceiro lugar: **1**

### Casos de borda
- **Empate em KO + knockout_advancer** — antes "engolia" o time da fase,
  agora ele aparece corretamente.
- **Árvore parcial** — `areAllGroupsMature` ainda retorna false até todos
  os grupos terem ≥2 jogos. Nesse caso, cada fase fica vazia, sem quebra.
- **Sem `knockout_advancer` E sem pens** — empate genuíno sem desempate:
  `determineMatchWinnerId` retorna null, o time não entra na fase. Esse
  cenário **não deveria ocorrer** num palpite válido de KO (a UI exige
  `knockout_advancer` em empate KO via `BetForm`), mas a função degrada
  graciosamente.

### Comandos
```bash
# 1) Pull / aplicar arquivos do zip
# 2) Rodar dev
npm run dev
# se algum erro de cache: rm -rf .next && npm run dev

# 3) Lint + build
npm run lint
npm run build
```

## Checklist de validação

- [ ] `/estatisticas` mostra os 2ºs colocados nos cards quando aplicável.
- [ ] Usuário com árvore completa vê 32 em "Classificados para 16-avos".
- [ ] Usuário com árvore completa vê 16 em "Classificados para oitavas".
- [ ] Usuário com árvore completa vê 8 em "Classificados para quartas".
- [ ] Usuário com árvore completa vê 4 em "Classificados para semifinais".
- [ ] Usuário com árvore completa vê 2 em "Finalistas".
- [ ] Usuário com árvore completa vê 1 em "Campeão".
- [ ] Usuário com árvore completa vê **1 em "Vice"**.
- [ ] Usuário com árvore completa vê 1 em "Terceiro lugar".
- [ ] Não há duplicação de seleção dentro da mesma fase para o mesmo usuário.
- [ ] `/apostas` continua mostrando só a aposta do próprio usuário.
- [ ] `/comparativo` continua respeitando regra de visibilidade.
- [ ] Admin de pontuação (recalc) recalcula sem erro.
- [ ] Ranking não regrediu.
- [ ] `app/page.tsx`, `app/globals.css`, `components/PixCopyBox.tsx`,
      `components/TeamNameWithFlag.tsx` **não foram alterados**.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **2 arquivos** alterados (`lib/bolao/qualification.ts`,
  `app/estatisticas/page.tsx`).
- **0 migrations** novas.
- **0 mudanças** em `app/page.tsx`, `app/globals.css`, `PixCopyBox.tsx`,
  `TeamNameWithFlag.tsx`, middleware, Header, scoring, recalc.ts.
- O bug `winnerOf-sem-hint` afetava tanto `/estatisticas` quanto a
  pontuação de classificação no admin — corrigido na origem comum.
- Visualização ganha um card "Vice" sem mexer no scoring ou no schema.
