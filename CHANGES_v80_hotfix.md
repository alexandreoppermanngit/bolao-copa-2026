# Bolão Copa 2026 — Hotfix v80 (UQS / advancer / snapshot pens)

**HOTFIX CRÍTICO sobre v79_hotfix.** Corrige bug que sobrou em
`user_qualification_scores`: usuário apostou Holanda nos pênaltis e
UQS gravava Marrocos.

**Sem migration. Sem alterar banco/apostas/snapshots/ranking.** Altera
3 arquivos `lib/` para consertar a interpretação de `knockout_advancer`
sobre snapshots da bet.

## ⚠️ AÇÃO OBRIGATÓRIA APÓS DEPLOY

```
/admin/configuracao → 🔄 Recalcular tudo
```

Sem isso, `user_qualification_scores` continua persistido com
`team_id = Marrocos` (errado) para usuários que apostaram Holanda
passando nos pênaltis.

## Bug observado

- Aposta:
  - `bet_home_team_id = Holanda`
  - `bet_away_team_id = Marrocos`
  - `home_score = 1`
  - `away_score = 1`
  - `knockout_advancer = 'home'`
- Jogo real:
  - Holanda 1×1 Marrocos
  - Marrocos venceu nos pênaltis (`home_pens` < `away_pens`)
- UQS persistido para o usuário, fase `r32`:
  - `team_id = Marrocos` ❌ (deveria ser Holanda)
  - `points_final > 0` ❌ (Marrocos é classificado real, mas usuário
    apostou Holanda — UQS deveria ter Holanda + `is_correct=false` + `points_final=0`)

## Causa-raiz

`determineMatchWinnerId(m, hint)` em `lib/bolao/bracket.ts:39-53`:

```ts
export function determineMatchWinnerId(m, hint?) {
  if (m.home_score == null || m.away_score == null) return null;
  if (m.home_score > m.away_score) return m.home_team_id;
  if (m.away_score > m.home_score) return m.away_team_id;
  // Empate — só vale para KO
  if (m.home_pens != null && m.away_pens != null) {    // ← linha 47
    return m.home_pens > m.away_pens ? m.home_team_id : m.away_team_id;
  }
  if (hint?.knockout_advancer === 'home') return m.home_team_id;
  if (hint?.knockout_advancer === 'away') return m.away_team_id;
  return null;
}
```

**O check de pens (linha 47-49) vem ANTES do `knockout_advancer` hint
(linha 50-51).** Isso é correto para o BRACKET REAL (vencedor dos pênaltis
prevalece sobre qualquer hint), mas é ERRADO para a **árvore do PALPITE**.

`extractUserPrediction` em `qualification.ts` (e callsites similares em
`recalc.ts` e `audit.ts`) construía `simMatches` assim:

```ts
const simMatches = allMatches.map(m => {
  const b = userBetsByMatch.get(m.id);
  if (!b) return m;
  return {
    ...m,
    home_score: b.home_score,    // ← bet scores
    away_score: b.away_score,
    // home_pens / away_pens HERDADOS DO MATCH REAL ❌
    home_team_id: b.bet_home_team_id ?? m.home_team_id,
    away_team_id: b.bet_away_team_id ?? m.away_team_id,
  };
});
```

Resultado para o match Holanda-Marrocos:
- `simMatches[M]` = { home: Holanda (snapshot), away: Marrocos (snapshot),
  home_score: 1, away_score: 1, **home_pens: X, away_pens: Y** (do REAL,
  Y > X) }
- `determineMatchWinnerId(simMatches[M], hint='home')`:
  1. home_score (1) == away_score (1) → não decide.
  2. home_pens != null && away_pens != null → **retorna `m.away_team_id`** = Marrocos.
  3. (linha 50-51 com hint='home' NUNCA é alcançada.)
- `byPhase.r32.add(Marrocos)` → UQS row com `team_id = Marrocos`. ❌

O palpite NÃO tem pens — o tiebreaker do palpite é `knockout_advancer`.
As pens REAIS são de uma realidade diferente.

## Fix

Helper exportado `applyBetSnapshotToMatch(m, b)` em `qualification.ts`:

```ts
export function applyBetSnapshotToMatch(m: Match, b: Bet): Match {
  const next: Match = {
    ...m,
    home_score: b.home_score,
    away_score: b.away_score,
    home_pens: null,    // ← v80: palpite NÃO tem pens
    away_pens: null,    // ← v80: tiebreaker é knockout_advancer
  };
  if (b.bet_home_team_id != null) next.home_team_id = b.bet_home_team_id;
  if (b.bet_away_team_id != null) next.away_team_id = b.bet_away_team_id;
  return next;
}
```

Substituições nos 3 callsites que constroem "match virtual do palpite":

1. `lib/bolao/qualification.ts` em `extractUserPrediction`:
   - `simMatches.map` agora usa `applyBetSnapshotToMatch`.
   - `resolvedWithSnapshots.map` (v79) também unificado.
2. `lib/bolao/recalc.ts` em `recalcKnockoutMatchupsForAllUsers`:
   - `simMatches.map` usa `applyBetSnapshotToMatch`.
3. `lib/bolao/audit.ts` em `simulateBracketForUser`:
   - `simMatches.map` usa `applyBetSnapshotToMatch`.

Por que zerar pens nos 3:
- **qualification.ts**: feed direto da UQS (fix do bug reportado).
- **recalc.ts**: `userResolvedWithOverrides` é fallback para bets sem
  snapshot; consistência.
- **audit.ts**: `userMatch` é fallback do audit; consistência para
  /comparativo, /meus-resultados.

## Como o bug fica corrigido (caso reportado)

Após v80:
- `simMatches[M]` = { home: Holanda, away: Marrocos, scores 1-1,
  **home_pens: null, away_pens: null** }.
- `determineMatchWinnerId(simMatches[M], hint='home')`:
  1. scores empatados → não decide por placar.
  2. home_pens == null → check da linha 47 falha.
  3. hint='home' → retorna `m.home_team_id` = Holanda. ✓
- `byPhase.r32.add(Holanda)` → UQS row com `team_id = Holanda`. ✓
- `is_correct` compara com `real.r32` (que tem Marrocos, vencedor pens
  REAIS) → `false`. ✓
- `points_final = 0`. ✓

## Casos de teste (todos passam)

### Caso A — empate + home advance
- Aposta: Holanda 1×1 Marrocos, advancer=home.
- Esperado em UQS: team_id=Holanda. ✓

### Caso B — empate + away advance
- Aposta: Holanda 1×1 Marrocos, advancer=away.
- Esperado: team_id=Marrocos. ✓ (hint='away' → m.away_team_id=Marrocos.)

### Caso C — home vence no tempo normal
- Aposta: Holanda 2×1 Marrocos.
- Esperado: team_id=Holanda. ✓ (home_score>away_score, decide por placar.)

### Caso D — away vence no tempo normal
- Aposta: Holanda 0×1 Marrocos.
- Esperado: team_id=Marrocos. ✓ (away_score>home_score, decide por placar.)

## O que **não** muda

- ✅ Banco / migrations / RLS — intocados.
- ✅ `determineMatchWinnerId` em `bracket.ts` — intocado (o behavior é
  correto para o bracket REAL; o fix está nos callsites que constroem
  "match virtual do palpite").
- ✅ `recalcBracket` (bracket oficial) — intocado: usa o match real, com
  pens reais.
- ✅ Snapshot da bet (`bet_home_team_id`, `bet_away_team_id`,
  `knockout_advancer`) — não tocamos no banco.
- ✅ Ranking, `user_rankings_full` — re-lerá os pontos corrigidos pelo recalc.
- ✅ `calculateBasePoints`, `scoring.ts`, `matchup.ts` — intocados.
- ✅ Nenhum `eslint-disable`.
- ✅ `emptyPrediction` segue ausente.

## SQL de diagnóstico (para rodar no Supabase ANTES e DEPOIS do recalc)

Substitua `EMAIL_DO_USUARIO` pelo email do usuário afetado.

### Achar usuário

```sql
select id, email, display_name
from public.profiles
where email ilike '%EMAIL_DO_USUARIO%';
```

### Aposta do jogo Holanda x Marrocos

```sql
select
  b.id as bet_id,
  b.user_id,
  p.email,
  m.id as match_id,
  m.phase,
  ht.name as real_home,
  at.name as real_away,
  bht.name as bet_home,
  bat.name as bet_away,
  b.home_score as bet_home_score,
  b.away_score as bet_away_score,
  b.knockout_advancer,
  b.points,
  b.points_with_zebra
from public.bets b
join public.profiles p on p.id = b.user_id
join public.matches m on m.id = b.match_id
left join public.teams ht on ht.id = m.home_team_id
left join public.teams at on at.id = m.away_team_id
left join public.teams bht on bht.id = b.bet_home_team_id
left join public.teams bat on bat.id = b.bet_away_team_id
where p.email ilike '%EMAIL_DO_USUARIO%'
  and (
    ht.name ilike '%Holanda%' or ht.name ilike '%Netherlands%' or
    at.name ilike '%Holanda%' or at.name ilike '%Netherlands%' or
    bht.name ilike '%Holanda%' or bht.name ilike '%Netherlands%' or
    bat.name ilike '%Holanda%' or bat.name ilike '%Netherlands%'
  );
```

### Classificação salva do usuário nos 32 avos

```sql
select
  uqs.user_id,
  p.email,
  uqs.phase,
  t.name as team,
  uqs.points_base,
  uqs.points_final,
  uqs.is_correct
from public.user_qualification_scores uqs
join public.profiles p on p.id = uqs.user_id
join public.teams t on t.id = uqs.team_id
where p.email ilike '%EMAIL_DO_USUARIO%'
  and uqs.phase = 'r32'
order by t.name;
```

(O enum no schema chama `r32` — não `round_of_32`. Se não souber, descobre com:
`select distinct phase from public.user_qualification_scores order by phase;`)

### Esperado ANTES do recalc (bug presente)

| user_id | email | phase | team | points_final | is_correct |
|---|---|---|---|---|---|
| ... | usuario@... | r32 | Marrocos | 12.00 | true |

### Esperado DEPOIS de aplicar v80 + recalcular tudo

| user_id | email | phase | team | points_final | is_correct |
|---|---|---|---|---|---|
| ... | usuario@... | r32 | Holanda | 0 | false |

## Checklist obrigatório

### Regra de pontuação (palpite)
- [ ] Match KO empate + advancer=home + snapshot home=X → UQS team_id=X.
- [ ] Match KO empate + advancer=away + snapshot away=Y → UQS team_id=Y.
- [ ] Match KO home vence no normal → UQS team_id=home (snapshot).
- [ ] Match KO away vence no normal → UQS team_id=away (snapshot).
- [ ] Pens REAIS do jogo NÃO influenciam a árvore do palpite.

### Pontos do jogo (já corrigido pela v79)
- [ ] Confronto apostado diferente do real → 0 pts.
- [ ] Confronto apostado igual ao real (mesmo invertido) → pontua placar.
- [ ] Confronto apostado ocorreu em outra fase → pontua via cross-phase.

### Não-regressão
- [ ] `recalcBracket` (bracket oficial) continua usando pens reais
  via `determineMatchWinnerId` direto sobre o match real (sem ir por
  `applyBetSnapshotToMatch`). Verificado.
- [ ] Pontuação de grupos não muda.
- [ ] Ranking automático.
- [ ] Bracket overrides preservados.
- [ ] Snapshots de apostas intactos.

### Recálculo
- [ ] Rodar `/admin/configuracao → Recalcular tudo` após deploy.
- [ ] UQS regenerada para todos os usuários.
- [ ] SQL diagnóstico mostra `team_id = Holanda` (em vez de Marrocos)
  para o usuário afetado.

### Build
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.
- [ ] Sem `eslint-disable`.
- [ ] `emptyPrediction` segue ausente.

## Como aplicar

```bash
# 1) Substituir os 3 arquivos do zip:
#    - lib/bolao/qualification.ts
#    - lib/bolao/recalc.ts
#    - lib/bolao/audit.ts

# 2) Build + deploy
rm -rf .next && npm run lint && npm run build && deploy

# 3) IMPORTANTE — rodar uma vez após deploy:
/admin/configuracao → 🔄 Recalcular tudo

# 4) Validar com SQL diagnóstico (acima) — Holanda deve estar em UQS,
#    não Marrocos, para o usuário que apostou Holanda nos pênaltis.
```

## Resumo

- **3 arquivos modificados**, **0 novos**, **0 migrations**.
- 1 helper novo exportado em `qualification.ts`: `applyBetSnapshotToMatch`.
- 3 callsites de `simMatches` unificados pelo helper.
- Zera `home_pens`/`away_pens` da "match virtual do palpite" para que
  `determineMatchWinnerId` caia no `knockout_advancer` hint do usuário
  (em vez de usar pens REAIS).
- `determineMatchWinnerId` em `bracket.ts` permanece intocado — sua
  semântica está correta para o bracket real.
- **AÇÃO MANUAL OBRIGATÓRIA**: rodar "Recalcular tudo" após o deploy
  para regenerar `user_qualification_scores`.
