# Bolão Copa 2026 — Hotfix v79 (mata-mata scoring)

**HOTFIX CRÍTICO de produção.** Corrige dois bugs graves de pontuação
no mata-mata observados após a v77c em produção.

**Sem migration. Sem alterar banco/apostas/snapshots/ranking/recalc-de-grupos.**
Altera apenas a leitura de snapshot vs simulação dentro de `recalc.ts` e
`qualification.ts`.

## ⚠️ APÓS APLICAR — RODAR OBRIGATORIAMENTE

```
/admin/configuracao → 🔄 Recalcular tudo
```

Sem isso, `bets.points` / `bets.points_with_zebra` / `user_qualification_scores`
ficam com os pontos errados que já estão persistidos.

## Bugs corrigidos

### Bug 1 — Classificado errado em pênaltis (Holanda virou Marrocos)

**Cenário real:**
- Jogo: Holanda 1×1 Marrocos, Marrocos venceu nos pênaltis.
- Aposta: bet_home=Holanda, bet_away=Marrocos, score 1-1, knockout_advancer=`home`.
- Na árvore do usuário (UI): Holanda avança (correto, lê snapshot).
- Em UQS: Marrocos aparece "classificado e pontuando" (errado).

**Causa-raiz:** `extractUserPrediction` (em `qualification.ts`) preparava
`simMatches` com snapshots, mas chamava `simulateBracket` que passa por
`populateKnockoutMatches`. Esse último resolve placeholders (`1A`,
`2B`, `winner_Mxx`) consultando standings + Anexo C + hints — e
**sobrescreve** `home_team_id` / `away_team_id` do snapshot quando o
match tem placeholder. Resultado: o match que o usuário apostou como
Holanda-Marrocos vinha resolvido como Marrocos-Holanda (orientação
invertida). Aí `determineMatchWinnerId` com `knockout_advancer: 'home'`
retornava `m.home_team_id` = Marrocos. UQS gerada com `team_id = Marrocos`.

### Bug 2 — Pontos por placar com confronto errado (10 pts pra Suécia-Marrocos vs Holanda-Marrocos)

**Cenário real:**
- Jogo real: Holanda 1×1 Marrocos.
- Aposta: bet_home=Suécia, bet_away=Marrocos, score 1-1.
- O sistema deu 10 pontos.

**Causa-raiz:** Em `recalc.ts`:
1. `recalcMatchAndAllBets` no branch KO (linhas 79-86 antigas) chamava
   `calculateBasePoints(b.scores, match.scores)` **direto**, sem
   validar matchup. 1-1 vs 1-1 = 10 pts, independente dos times.
2. O cross-phase `recalcKnockoutMatchupsForAllUsers` deveria corrigir,
   mas usava `userResolvedWithOverrides[match].home_team_id/away_team_id`
   (= simulação) em vez do snapshot. Se a simulação alinhasse com o
   real (caso comum), `findRealKnockoutMatchup` achava o match e dava
   pontos — mesmo o snapshot sendo de outro confronto.

## Mudanças (2 arquivos · 0 migrations)

### 1) `lib/bolao/recalc.ts`

#### a) `recalcMatchAndAllBets` no branch KO

**Antes** (linhas 78-89): pontuava blind `calculateBasePoints(b.scores, match.scores)` e depois chamava cross-phase.

**Depois**: zera as bets deste match e **delega** para o cross-phase.
Cross-phase é a única fonte de pontos KO (sabe consultar snapshot).

```diff
- const updates = betsList.map(b => {
-   const pts = calculateBasePoints(
-     { home_score: b.home_score, away_score: b.away_score },
-     { home_score: match.home_score!, away_score: match.away_score! }, cfg,
-   );
-   return sb.from('bets').update({ points: pts, points_with_zebra: pts }).eq('id', b.id);
- });
- await Promise.all(updates);
+ const zeros = betsList.map(b =>
+   sb.from('bets').update({ points: 0, points_with_zebra: 0 }).eq('id', b.id),
+ );
+ await Promise.all(zeros);
  await sb.from('matches').update({
    result_code: outcomeOf(match.home_score!, match.away_score!),
  }).eq('id', matchId);
  await recalcKnockoutMatchupsForAllUsers(sb, cfg);
```

#### b) `recalcKnockoutMatchupsForAllUsers` — usar snapshot

**Antes**: usava `userResolvedWithOverrides[match].home/away_team_id`
(simulação). Quando a simulação não preservava snapshot, dava pontos
incorretos.

**Depois**: usa `b.bet_home_team_id` / `b.bet_away_team_id` (snapshot).
Fallback para simulação só quando snapshot ausente (bets legadas pré-v65).

```ts
let pairHome = b.bet_home_team_id;
let pairAway = b.bet_away_team_id;
if (pairHome == null || pairAway == null) {
  // Fallback "best effort" para bets antigas sem snapshot
  const simM = userResolvedWithOverrides.find(x => x.id === b.match_id);
  pairHome = simM?.home_team_id ?? null;
  pairAway = simM?.away_team_id ?? null;
}
if (pairHome == null || pairAway == null) {
  return sb.from('bets').update({ points: 0, points_with_zebra: 0 }).eq('id', b.id);
}
const hit = findRealKnockoutMatchup(pairHome, pairAway, allMatches);
if (!hit) {
  // Confronto apostado NÃO ocorreu em nenhum match KO real → 0 pts
  return sb.from('bets').update({ points: 0, points_with_zebra: 0 }).eq('id', b.id);
}
const adjusted = hit.inverted
  ? { home_score: b.away_score, away_score: b.home_score }
  : { home_score: b.home_score, away_score: b.away_score };
const pts = calculateBasePoints(adjusted, {
  home_score: hit.match.home_score!,
  away_score: hit.match.away_score!,
}, cfg);
return sb.from('bets').update({ points: pts, points_with_zebra: pts }).eq('id', b.id);
```

Também ajustei o `.filter()` pra usar o `phase` do match **real** (não simulado) — defesa contra bets cujo match na simulação ficou sem teams resolvidos.

### 2) `lib/bolao/qualification.ts`

#### `extractUserPrediction` — re-aplicar snapshots após `simulateBracket`

**Antes**: `byPhase = extractAdvancingTeams(resolved, hints)`. `resolved`
tinha as teams da simulação (que pode divergir do snapshot pra matches
com placeholder).

**Depois**: re-aplica snapshots por cima do `resolved` antes de
`extractAdvancingTeams`. Assim `determineMatchWinnerId` lê
`m.home_team_id` na orientação do snapshot e o hint
`knockout_advancer: 'home'` aponta para o time que o usuário escolheu
como "home" no palpite — não para o time que a simulação colocou na
orientação `home`.

```ts
const resolved = simulateBracket(simMatches, teams, standings, thirds, opt, hints);

const resolvedWithSnapshots: Match[] = resolved.map(m => {
  const b = userBetsByMatch.get(m.id);
  if (!b) return m;
  if (b.bet_home_team_id == null && b.bet_away_team_id == null) return m;
  const next: Match = { ...m };
  if (b.bet_home_team_id != null) next.home_team_id = b.bet_home_team_id;
  if (b.bet_away_team_id != null) next.away_team_id = b.bet_away_team_id;
  return next;
});
byPhase = extractAdvancingTeams(resolvedWithSnapshots, hints);
```

## Como cada caso passa agora

### Caso A — confronto errado, placar igual
- Real: Holanda 1×1 Marrocos (Marrocos avança pens)
- Aposta: bet_home=Suécia, bet_away=Marrocos, 1-1

| Etapa | Resultado |
|---|---|
| `recalcMatchAndAllBets(matchHM)` KO | Zera bets do match → cross-phase recalcula |
| `recalcKnockoutMatchupsForAllUsers` para essa bet | `pairHome=Suécia, pairAway=Marrocos`; `findRealKnockoutMatchup(Suécia, Marrocos, allMatches)` → null (par {Suécia, Marrocos} não existe em real) → **0 pts** ✓ |
| audit (já lê snapshot) | reason: `ko_match_not_played` → mostra "Mata-mata: confronto não ocorreu (0 pts de placar)" |

### Caso B — confronto certo, classificado pênalti home
- Real: Holanda 1×1 Marrocos (Marrocos avança pens)
- Aposta: bet_home=Holanda, bet_away=Marrocos, 1-1, advancer=home

| Etapa | Resultado |
|---|---|
| Pontos do jogo (placar) | 10 pts (placar exato) ✓ |
| `extractUserPrediction` | resolvedWithSnapshots[matchHM] tem home=Holanda, away=Marrocos. `determineMatchWinnerId` com hint=home → Holanda. byPhase.r32.add(Holanda) ✓ |
| UQS | row team_id=Holanda, is_correct=false (real winner é Marrocos), points_final=0 ✓ |

### Caso C — confronto certo, classificado pênalti away
- Real: Holanda 1×1 Marrocos (Marrocos avança pens)
- Aposta: bet_home=Holanda, bet_away=Marrocos, 1-1, advancer=away

| Etapa | Resultado |
|---|---|
| Pontos do jogo | 10 pts (placar exato) ✓ |
| `extractUserPrediction` | `determineMatchWinnerId` com hint=away → Marrocos. byPhase.r32.add(Marrocos) ✓ |
| UQS | row team_id=Marrocos, is_correct=true (real winner é Marrocos), points_final>0 ✓ |

### Caso D — confronto certo, classificado errado
- Real: Holanda 1×1 Marrocos (Marrocos avança pens)
- Aposta: bet_home=Holanda, bet_away=Marrocos, 1-1, advancer=home (Holanda)

| Etapa | Resultado |
|---|---|
| Pontos do jogo | 10 pts (placar exato) ✓ |
| `extractUserPrediction` | byPhase.r32.add(Holanda) (snapshot + hint home) ✓ |
| UQS | team_id=Holanda, is_correct=false (real winner é Marrocos) ✓ — ponto de placar mantido, ponto de classificado negado |

## O que **não** muda

- ✅ Banco / migrations / RLS (sem mudanças)
- ✅ `bets.bet_home_team_id` / `bet_away_team_id` (snapshots) — só passamos a USAR melhor
- ✅ Regra de pontuação de grupos — intocada
- ✅ Ranking (`/ranking`) — intocado (re-lerá os pontos corrigidos pelo recalc)
- ✅ `calculateBasePoints` em `scoring.ts` — não muda; agora só recebe inputs corretos
- ✅ `findRealKnockoutMatchup` em `matchup.ts` — não muda
- ✅ `audit.ts` — já lia snapshot corretamente; só passa a refletir pontos certos
- ✅ Apostas em si (snapshots, scores, advancer) — intocadas
- ✅ `populateKnockoutMatches` / `recalcBracket` — não tocamos no bracket oficial
- ✅ Nenhum `eslint-disable`
- ✅ `emptyPrediction` segue ausente

## Checklist obrigatório

### Pontuação de jogo
- [ ] Confronto apostado igual ao real → pontua normalmente (placar exato 10 pts, resultado 5 pts, etc.).
- [ ] Confronto apostado com mando invertido → pontua com inversão (já era assim — `hit.inverted`).
- [ ] Confronto apostado **diferente** do real → 0 pts (mesmo com placar igual).
- [ ] Confronto apostado ocorreu em **outra fase** do bracket → pontua via `findRealKnockoutMatchup` (cross-phase preservado).

### Pênaltis e classificado
- [ ] `knockout_advancer='home'` + snapshot home=Holanda → Holanda avança na simulação do usuário.
- [ ] `knockout_advancer='away'` + snapshot away=Marrocos → Marrocos avança na simulação do usuário.
- [ ] UQS gerada com `team_id` = time apostado (não o resolvido pela simulação).
- [ ] `is_correct` compara com classificado REAL (via `extractAdvancingTeams(matches)` com gate v72).

### Bets legadas (pré-v65, sem snapshot)
- [ ] `bet_home_team_id` / `bet_away_team_id` null → fallback à simulação do usuário (comportamento "best effort" preservado).
- [ ] Para essas bets, ainda há risco de matchup errado dar pontos se a simulação alinhar com o real — limitação conhecida; resolvida só com snapshot.

### Recálculo
- [ ] Após aplicar, rodar `/admin/configuracao → Recalcular tudo`.
- [ ] `bets.points` e `bets.points_with_zebra` zeradas para confrontos errados em KO.
- [ ] `user_qualification_scores` regenerada com `team_id` correto.
- [ ] Ranking re-ordenado automaticamente (lê via view `user_rankings_full`).

### Sem regressão
- [ ] Pontuação de grupos inalterada (zebra continua só em grupos).
- [ ] `recalcBracket` (bracket oficial) inalterado.
- [ ] Apostas/snapshots não alteradas.
- [ ] Banco intacto, sem migration.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Como aplicar e validar

```bash
# 1) Substituir os 2 arquivos do zip
# 2) Build
rm -rf .next && npm run lint && npm run build && deploy

# 3) IMPORTANTE — rodar uma vez após deploy:
/admin/configuracao → 🔄 Recalcular tudo

# 4) Smoke produção
#    Caso A: usuário com aposta Suécia-Marrocos em jogo Holanda-Marrocos
#       → bet.points deve estar 0 (era 10)
#       → audit em /comparativo mostra "confronto não ocorreu"
#    Caso B: usuário com aposta Holanda-Marrocos advance=home, real Holanda 1-1 Marrocos (Marrocos venceu pens)
#       → UQS row deve ter team_id = Holanda (não Marrocos)
#       → row.is_correct = false (real ganhador é Marrocos)
#       → row.points_final = 0
#    Pontuação de grupos: rodar smoke /ranking — deve ficar coerente com antes (sem regressão).
```

## Arquivos no zip

| Arquivo | Mudança |
|---|---|
| `lib/bolao/recalc.ts` | KO scoring via snapshot (2 mudanças no arquivo) |
| `lib/bolao/qualification.ts` | re-aplicar snapshots após simulateBracket em `extractUserPrediction` |
| `CHANGES_v79_hotfix.md` | esta doc |

## Resumo

- **2 arquivos modificados**, **0 novos**, **0 migrations**.
- Snapshot da bet (`bet_home_team_id` / `bet_away_team_id`) passa a ser a
  **fonte de verdade** para o confronto apostado no mata-mata.
- `recalcMatchAndAllBets` KO delega 100% para `recalcKnockoutMatchupsForAllUsers`.
- `extractUserPrediction` força snapshot por cima do resolved da simulação.
- **AÇÃO MANUAL OBRIGATÓRIA**: rodar "Recalcular tudo" no admin após
  o deploy para regenerar `bets.points` e `user_qualification_scores`.
