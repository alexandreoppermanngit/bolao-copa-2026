# Bolão Copa 2026 — Atualização v72

Gate de pontuação por classificados — fix de bug que liberava pontos
antes da hora. Sem migration, sem alterar apostas, sem alterar
recálculo de placares.

## Diagnóstico

Bug raiz em `lib/bolao/qualification.ts → extractAdvancingTeams`:

```ts
for (const m of matches) {
  if (m.phase === 'round_of_32') {
    if (m.home_team_id) result.group_stage.add(m.home_team_id);
    if (m.away_team_id) result.group_stage.add(m.away_team_id);
  }
}
```

Esses `home_team_id`/`away_team_id` dos jogos R32 são populados pelo
`recalcBracket → populateKnockoutMatches`, que só exige **2 jogos por
grupo** (`areAllGroupsMature`). Quando os grupos têm 2+ jogos preenchidos,
o R32 já mostra "1A vs 3rd_pos_X" resolvido com standings PARCIAIS — e o
set `real.group_stage` passa a conter os 32 times de standings parciais.

Resultado: `calculateUserQualificationScores` marca `is_correct=true`
para usuários que adivinharam um time que ainda não está oficialmente
classificado. `points_final > 0` entra na view `user_rankings_full` —
e o ranking subia antes da hora.

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Onde os classificados reais são calculados | `extractAdvancingTeams(allMatches)` em qualification.ts. |
| 2 | Onde UQS recebe `points_final` | `calculateUserQualificationScores` (qualification.ts). |
| 3 | Por que entrava antes da hora | `extractAdvancingTeams` lia `home/away_team_id` dos R32 (que são populados com standings parciais via areAllGroupsMature). |
| 4 | Diferencia 1º/2º de 3ºs? | **Não** — todos entravam em `result.group_stage`. |
| 5 | Saber se grupo tem 6 jogos | `countPlayedGamesPerGroup(matches)` em standings.ts — já existe. |
| 6 | Saber se 1ª fase completa | `allGroupGamesPlayed(matches)` (privado em qualification.ts). |
| 7 | Mudança no banco? | **Não**. Apenas código + recalcular. |
| 8 | Arquivos | `qualification.ts`, `recalc.ts`, `meus-resultados/page.tsx`, `MyResultsView.tsx`. |
| 9 | Ranking geral afetado? | **Sim** — view soma `points_final`. Após v72 + recalc, valores corrigidos. |
| 10 | Ranking zebra afetado? | **Sim** — usa `qualification_points - qualification_points_base`. Mesma correção propaga. |

## Estratégia

**Backend (ponto único de gate)**: `extractAdvancingTeams` ganha opt
`gateGroupStage` + `teams`. Quando true, ele **ignora** o atalho do
"home/away dos R32" e reconstrói `result.group_stage` direto dos
standings:

```ts
const completed = getCompletedGroups(matches);          // grupos com 6 jogos
for (const g of completed) {
  const std = standings.get(g);
  if (std[0]) result.group_stage.add(std[0].team_id);   // 1º
  if (std[1]) result.group_stage.add(std[1].team_id);   // 2º
}
if (isGroupStageFullyComplete(matches)) {               // todos 72 jogos
  const thirds = computeThirdPlaceRanking(standings);
  for (const t of thirds.filter(x => x.rank <= 8)) {
    result.group_stage.add(t.team.team_id);             // 8 melhores 3ºs
  }
}
```

`recalc.ts → recalcAllQualificationScores` passa `gateGroupStage: true`
+ `teams`. A árvore PREVISTA do usuário (`extractUserPrediction`) NÃO
passa — ela continua representando "o que o usuário acha", sem gate.

**UI (`/meus-resultados`)**: helper `classificationStatus(phase, teamId, isCorrect)`
devolve emoji + label legível, considerando os gates por grupo do team:

- `is_correct = true` → `✅ Acertou`
- `group_stage` + grupo do team incompleto → `⏳ Aguardando definição do grupo`
- `group_stage` + grupo completo mas 1ª fase incompleta → `⏳ Aguardando fim da 1ª fase` (cobre o caso do team poder vir como 3º melhor)
- `group_stage` + 1ª fase completa + `is_correct = false` → `❌ Errou`
- Outras fases: tri-estado original via `isPhaseCompleted`.

## Arquivos alterados (4) · 0 migrations

| Arquivo | Mudança |
|---|---|
| `lib/bolao/qualification.ts` | • Novos helpers exportados: `GAMES_PER_GROUP=6`, `getCompletedGroups(matches)`, `isGroupStageFullyComplete(matches)`.<br>• `extractAdvancingTeams` ganha 3º parâmetro `opts?: { gateGroupStage, teams }`. Quando true, reconstrói `result.group_stage` por gate de grupo + 3ºs só após 1ª fase. Comportamento original preservado (para USER predicted). |
| `lib/bolao/recalc.ts` | • `recalcAllQualificationScores` chama `extractAdvancingTeams(allMatches, undefined, { gateGroupStage: true, teams })`. |
| `app/meus-resultados/page.tsx` | • Passa `allMatches` para `MyResultsView`. |
| `components/MyResultsView.tsx` | • Recebe `allMatches`.<br>• Computa `completedGroups`, `groupStageFullyDone`, `teamGroup`.<br>• Função `classificationStatus(phase, teamId, isCorrect)` → status granular.<br>• Tabela de classificados usa esse status (com `title` no `<td>` mostrando o label completo).<br>• Legenda da seção atualizada. |

## Como aplicar e validar

```bash
# 1) Aplicar os 4 arquivos do zip
# 2) Build local
rm -rf .next && npm run lint && npm run build && deploy

# 3) IMPORTANTE — rodar "Recalcular tudo" no admin
/admin/configuracao → 🔄 Recalcular tudo
# Isso regenera user_qualification_scores e ajusta o ranking conforme o gate.

# 4) Validar com SQL:
#    - Conta linhas com is_correct=true por fase. Antes do v72 + recalc,
#      group_stage tinha linhas demais. Após, só os 32 oficiais (e zero
#      enquanto a fase não tiver grupos completos).
```

```sql
-- Quantos times classificados foram dados como "corretos" em UQS?
select count(*) filter (where phase::text = 'group_stage' and is_correct) as group_stage_acertos,
       sum(case when phase::text = 'group_stage' and is_correct then 1 else 0 end) as ditto;

-- Quais grupos têm 6 jogos completos?
select group_code, count(*) filter (where home_score is not null and away_score is not null) as preenchidos
  from public.matches
 where phase like 'group_stage_%'
 group by group_code
 order by group_code;
```

## Cenários (alinhados ao spec)

| Cenário | Antes (bug) | Depois (v72) |
|---|---|---|
| Grupo A com 5/6 jogos preenchidos. Usuário apostou 1A. | `is_correct=true` (se a standings parcial disser 1A). Pontos contam. | `is_correct=false`. Status: ⏳ "Aguardando definição do grupo". Pontos = 0. |
| Grupo A com 6/6 jogos. Usuário acertou 1º colocado. | OK. | OK. ✅ Acertou. Pontos contam. |
| 8 grupos completos, 4 ainda não. Usuário apostou um 3º melhor. | `is_correct=true` se o time aparece em R32 populado parcialmente. | `is_correct=false`. Status: ⏳ "Aguardando fim da 1ª fase". |
| Todos os 12 grupos com 6/6. Usuário acertou um melhor 3º. | OK. | OK. ✅ Acertou. Pontos contam. |

## Checklist de validação

### Pontos (após "Recalcular tudo")
- [ ] `user_qualification_scores.is_correct = true` em group_stage **só** para times que são 1º/2º de grupos com 6 jogos ou 3ºs definidos após 12 grupos completos.
- [ ] `points_final` de classificados pendentes = 0.
- [ ] View `user_rankings_full.qualification_points` não soma pendentes.
- [ ] Ranking zebra (bônus) não inclui pendentes.

### UI
- [ ] `/meus-resultados` mostra ⏳ "Aguardando definição do grupo" para times em grupos incompletos.
- [ ] Mostra ⏳ "Aguardando fim da 1ª fase" para grupos completos enquanto outros estão pendentes (cobre o caso do 3º).
- [ ] Mostra ✅ ou ❌ só quando o gate libera.

### Sem regressão
- [ ] Pontuação por placar dos jogos (`bets.points`) inalterada.
- [ ] Multiplicador zebra de placar de grupo inalterado.
- [ ] Regras de KO inalteradas.
- [ ] Campeão/vice/3º (v69) continuam corretos.
- [ ] Snapshots de bets (v65–v66) intactos.
- [ ] Placar cheio (v71) intacto.
- [ ] Fator/multiplicador (v71) intacto.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **4 arquivos** alterados, **0 migrations**.
- **3 helpers novos** exportados em `qualification.ts`.
- `extractAdvancingTeams` ganha opt-in para gate sem quebrar callers.
- Apenas o caminho REAL (em `recalcAllQualificationScores`) passa
  `gateGroupStage: true`. A árvore PREVISTA do usuário continua igual.
- Ranking volta a refletir só pontos efetivamente liberados.
- "Recalcular tudo" é **necessário** após aplicar para regenerar UQS.
