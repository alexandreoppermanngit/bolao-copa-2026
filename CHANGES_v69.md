# Bolão Copa 2026 — Atualização v69

Bug encontrado: `user_qualification_scores.champion` e
`user_qualification_scores.runner_up` divergem do que o usuário apostou
no jogo da final (visível no snapshot da bet). Esta versão consertando
**na origem do recálculo**, sem migration, sem tocar no banco.

## Diagnóstico — por que diverge

`lib/bolao/qualification.ts → extractUserPrediction` aplica os snapshots
em `simMatches.home_team_id/away_team_id` e DEPOIS chama
`simulateBracket(simMatches, ...)`. O `simulateBracket` por sua vez chama
`populateKnockoutMatches` que **re-resolve TODOS os placeholders KO** via
standings/Anexo C — ignorando os `home_team_id` que vieram do snapshot,
porque os matches KO têm `home_placeholder = "winner_M97"` etc.

Trecho problemático em `bracket.ts`:
```ts
const homeRes = m.home_placeholder
  ? resolvePlaceholder(m.home_placeholder, standings, ...)  // ← ignora snapshot
  : { team: m.home_team_id ? teamById.get(m.home_team_id) ?? null : null };
```

Resultado:
- Quando o usuário tem palpites parciais de fase de grupos (standings
  imaturos), `resolvePlaceholder("winner_M97", ...)` cai em desempate
  alfabético ou retorna null, devolvendo um time que **não é** o que o
  usuário apostou na final.
- `extractAdvancingTeams(resolved)` pega esse time errado como
  `byPhase.champion`/`runner_up`.
- `calculateUserQualificationScores` inscreve isso em UQS.
- View `user_rankings_full` soma `points_final` em cima de UQS errado.
- **Ranking pode estar incorreto**.

`third_place` tem **o mesmo risco** (placeholder `loser_M97 × loser_M98`).
`semi_finals` também tem o mesmo padrão estrutural, **mas o spec da v69
não pediu correção lá** — mencionado em "auditoria" abaixo.

## Diagnóstico — respostas em ordem

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Onde UQS é gerada | `lib/bolao/recalc.ts → recalcAllQualificationScores`. |
| 2 | Como `champion`/`runner_up` são gerados | Via `extractUserPrediction` → `simulateBracket` (que re-resolve placeholders). |
| 3 | Fonte? | Simulação (sobrescrevendo o snapshot). |
| 4 | Por que diverge | `simulateBracket` ignora `home_team_id` quando há `home_placeholder`. |
| 5 | `third_place` tem o mesmo risco? | **SIM**. Corrigido junto. |
| 6 | Afeta `total_points`? | **SIM** — via UQS → `user_rankings_full`. |
| 7 | Ranking pode estar errado | **SIM** — para todos os usuários cuja simulação divergia do snapshot da final. |
| 8 | Arquivos alterados | 1: `lib/bolao/qualification.ts`. |
| 9 | Migration? | **Nenhuma**. |

## Correção

Em `extractUserPrediction`, APÓS o `extractAdvancingTeams`, sobrescrevo
3 sets de `byPhase` derivando direto da bet do match correspondente:

```ts
overrideFromBet({ matchPhase: 'final',       targets: { winner: 'champion', loser: 'runner_up' }, ... });
overrideFromBet({ matchPhase: 'third_place', targets: { winner: 'third_place' }, ... });
```

A regra do `overrideFromBet`:

```
1. Se knockout_advancer = 'home'  → winner = bet_home_team_id, loser = bet_away_team_id
2. Se knockout_advancer = 'away'  → winner = bet_away_team_id, loser = bet_home_team_id
3. Se home_score > away_score     → winner = bet_home_team_id, loser = bet_away_team_id
4. Se away_score > home_score     → winner = bet_away_team_id, loser = bet_home_team_id
5. Empate sem advancer: NÃO inventa — mantém o que veio da simulação
   (se simulação não tem nada, fase fica sem aposta de campeão/vice).
```

Pré-requisito: `bet_home_team_id` e `bet_away_team_id` da bet devem estar
preenchidos. Caso contrário, **mantém o valor da simulação como fallback**
(compat com bets pré-backfill — improvável após v66).

## Arquivos alterados (1) · 0 migrations

| Arquivo | Mudança |
|---|---|
| `lib/bolao/qualification.ts` | • `extractUserPrediction` agora pós-processa `byPhase.champion`, `byPhase.runner_up`, `byPhase.third_place` via novo helper `overrideFromBet`.<br>• Snapshot da bet vira a fonte de verdade dessas 3 fases.<br>• `extractAdvancingTeams` e `simulateBracket` continuam intocados — só o consumo no `extractUserPrediction` mudou. |

Como o resto do código (`calculateUserQualificationScores`,
`buildPredictionCensus`, `recalc.ts`, página `/estatisticas`,
`MyPointsSummary`, `BetSummary`) lê `byPhase`/`runnerUpCounts`, todo o
fluxo se beneficia automaticamente.

## Auditoria — `semi_finals` (fora do escopo, recomendação)

`byPhase.semis` = vencedores das semifinais = finalistas. Como cada match
SF tem placeholder `winner_M93 × winner_M94`, o **mesmo bug pode afetar
quem está nos finalistas** se a simulação por palpites parciais resolveu
errado.

Mas:
- Em produção, `recalcAllQualificationScores` agora paginado (v68) +
  snapshots em todas as bets (v66) → simulação raramente erra `semis`.
- O usuário não pediu correção lá. **Vou deixar como está**.
- Se você quiser garantia 100%, peço para fazer uma v70 que aplica a
  mesma estratégia para os 2 matches SF (deriva vencedor de cada SF
  diretamente da bet, em vez da simulação).

## Como aplicar e validar

```bash
# 1) Aplicar o arquivo do zip
# 2) Build + deploy
rm -rf .next && npm run lint && npm run build && deploy

# 3) /admin/configuracao → 🔄 Recalcular tudo
#    (regera UQS usando a nova lógica)

# 4) Rodar a query de divergência que você compartilhou:
```

```sql
with final_bets as (
  select b.user_id,
    case
      when b.knockout_advancer = 'home' then b.bet_home_team_id
      when b.knockout_advancer = 'away' then b.bet_away_team_id
      when b.home_score > b.away_score then b.bet_home_team_id
      when b.away_score > b.home_score then b.bet_away_team_id
      else null
    end as champion_from_final,
    case
      when b.knockout_advancer = 'home' then b.bet_away_team_id
      when b.knockout_advancer = 'away' then b.bet_home_team_id
      when b.home_score > b.away_score then b.bet_away_team_id
      when b.away_score > b.home_score then b.bet_home_team_id
      else null
    end as runner_up_from_final
  from public.bets b
  join public.matches m on m.id = b.match_id
  where m.phase::text = 'final'
),
uqs_champion as (
  select user_id, team_id as champion_from_uqs
  from public.user_qualification_scores where phase::text = 'champion'
),
uqs_runner_up as (
  select user_id, team_id as runner_up_from_uqs
  from public.user_qualification_scores where phase::text = 'runner_up'
)
select p.display_name, p.email,
  champ_final.name as campeao_final_bets,
  champ_uqs.name as campeao_uqs,
  vice_final.name as vice_final_bets,
  vice_uqs.name as vice_uqs
from final_bets fb
left join public.profiles p on p.id = fb.user_id
left join uqs_champion uc on uc.user_id = fb.user_id
left join uqs_runner_up ur on ur.user_id = fb.user_id
left join public.teams champ_final on champ_final.id = fb.champion_from_final
left join public.teams champ_uqs on champ_uqs.id = uc.champion_from_uqs
left join public.teams vice_final on vice_final.id = fb.runner_up_from_final
left join public.teams vice_uqs on vice_uqs.id = ur.runner_up_from_uqs
where fb.champion_from_final is distinct from uc.champion_from_uqs
   or fb.runner_up_from_final is distinct from ur.runner_up_from_uqs
order by p.display_name;
```

**Esperado após "Recalcular tudo": 0 linhas.**

Para auditar 3º lugar:
```sql
with third_bets as (
  select b.user_id,
    case
      when b.knockout_advancer = 'home' then b.bet_home_team_id
      when b.knockout_advancer = 'away' then b.bet_away_team_id
      when b.home_score > b.away_score then b.bet_home_team_id
      when b.away_score > b.home_score then b.bet_away_team_id
      else null
    end as third_from_bet
  from public.bets b
  join public.matches m on m.id = b.match_id
  where m.phase::text = 'third_place'
),
uqs as (
  select user_id, team_id as third_from_uqs
  from public.user_qualification_scores where phase::text = 'third_place'
)
select tb.*, u.third_from_uqs
from third_bets tb
left join uqs u on u.user_id = tb.user_id
where tb.third_from_bet is distinct from u.third_from_uqs;
```

Esperado: 0 linhas.

## Checklist

- [ ] Campeão em UQS bate com `bets` da final (regra com advancer).
- [ ] Vice em UQS bate com `bets` da final.
- [ ] 3º em UQS bate com `bets` da disputa de 3º lugar.
- [ ] Query de divergência retorna 0 linhas após recalc.
- [ ] Pontuação de campeão usa o time correto (`points_final` do UQS).
- [ ] Pontuação de vice usa o time correto.
- [ ] Ranking (`user_rankings_full.total_points`) atualizado.
- [ ] Nenhuma aposta apagada/alterada.
- [ ] Snapshots de `bets` (`bet_home_team_id`/`bet_away_team_id`) intactos.
- [ ] Sem migration.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **1 arquivo** alterado (`lib/bolao/qualification.ts`).
- **0 migrations**.
- **0 alterações** em RLS, scoring base, recalc orquestração, ranking views.
- Champion/runner_up/third_place agora derivam **direto da bet** — snapshot
  é a fonte de verdade, simulação é fallback só se snapshot estiver vazio.
- "Recalcular tudo" após aplicar regenera UQS corretamente.
