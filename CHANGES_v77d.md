# Bolão Copa 2026 — Atualização v77d

Patch sobre a v77/v77b/v77c. **Sem migration. Sem alterar pontuação,
ranking, recálculo, banco, apostas, snapshots ou regras de desempate.**

Corrige 3 problemas reportados em teste local da v77c:

1. **3º colocado marcado como ❌ antes do fim da 1ª fase** (caso BEL).
2. **`/estatisticas` mostrando classificados oficiais antes da hora**.
3. **Admin trocando jogador em `/meus-resultados`** — remount defensivo.

## Diagnóstico

| # | Resposta |
|---|---|
| 1 | **BEL eliminada antes da hora**: o walk-forward em `evaluateKOPhaseStatus` (introduzido na v77c) disparava SEMPRE que as 16 partidas R32 tinham `home_team_id`/`away_team_id` populados. Mas `populateKnockoutMatches` (em `lib/bolao/bracket.ts:141-189`) **popula o R32 provisoriamente** assim que cada grupo tem ≥2 jogos (`areAllGroupsMature` / `MIN_GAMES_PER_GROUP_FOR_BRACKET = 2`). Como BEL é 3ª em grupo aberto e o bracket provisório não a inclui em R32, o walk-forward cravava ❌ — mas BEL ainda pode subir como melhor 3ª quando a 1ª fase fechar. |
| 2 | Bug em **`evaluateKOPhaseStatus` (lib/bolao/qualification.ts)** + **`/estatisticas` (app/estatisticas/page.tsx)**. O group_stage de `evaluateTeamPhaseStatus` já estava correto (`getCompletedGroups` + `isGroupStageFullyComplete`). O `extractAdvancingTeams` com `gateGroupStage: true` também estava correto. |
| 3 | `/estatisticas` infere classificados em `app/estatisticas/page.tsx:120` via `extractAdvancingTeams(matches)` — **sem `gateGroupStage`**. Caía no caminho legado (popula `result.group_stage` direto de `matches.round_of_32.home/away_team_id`). |
| 4 | **Sim** — `/estatisticas` usava o bracket parcial provisório do R32 como prova de "Avançou? ✅", mesmo com grupos abertos. |
| 5 | **Admin remount**: page `/meus-resultados` é `force-dynamic`, refaz fetch correto quando `?user=` muda. Props novos chegam ao `MyResultsView` e as `useMemo` recomputam por dep change. A queixa "só ampulheta" é provavelmente esperada (Copa em fase de grupos → quase tudo `pending`), **mas adicionei `key={targetUserId}` como defesa em profundidade** para garantir remount completo (zera useState como `dayFilter`). |
| 6 | **Sem problema de query/URL/cache** — page é `force-no-store`. Bug puramente visual da v77c + ausência de gate em /estatisticas. |
| 7 | **3 arquivos**: `lib/bolao/qualification.ts`, `app/estatisticas/page.tsx`, `app/meus-resultados/page.tsx`. |
| 8 | **Sem migration**. |
| 9 | Ranking, recálculo, banco, UQS, points_final, is_correct, bets, matches, snapshots — **intocados**. |

## Mudanças por arquivo

### 1) `lib/bolao/qualification.ts` — walk-forward gateado

Antes (v77c):

```ts
const decidingMatches = matches.filter(m => m.phase === decidingPhase);
if (decidingMatches.length > 0) {
  const allPopulated = decidingMatches.every(m =>
    m.home_team_id != null && m.away_team_id != null
  );
  if (allPopulated) {
    const isParticipant = decidingMatches.some(m =>
      m.home_team_id === teamId || m.away_team_id === teamId
    );
    if (!isParticipant) return 'eliminated';  // ← disparava com bracket provisório
  }
}
```

Agora (v77d):

```ts
const prereqPhase: Partial<Record<QualificationPhase, QualificationPhase>> = {
  r32: 'group_stage',
  r16: 'r32',
  quarters: 'r16',
  semis: 'quarters',
  third_place: 'semis',
  runner_up: 'semis',
  champion: 'semis',
};
const prereq = prereqPhase[phase];

// Só confiamos no bracket de decidingPhase quando a fase PRÉ-REQUISITO
// está totalmente decidida (bracket atual é DEFINITIVO, não provisório).
if (prereq && isPhaseCompleted(prereq, matches)) {
  const decidingMatches = matches.filter(m => m.phase === decidingPhase);
  if (decidingMatches.length > 0) {
    const allPopulated = decidingMatches.every(m =>
      m.home_team_id != null && m.away_team_id != null
    );
    if (allPopulated) {
      const isParticipant = decidingMatches.some(m =>
        m.home_team_id === teamId || m.away_team_id === teamId
      );
      if (!isParticipant) return 'eliminated';
    }
  }
}
```

Mapeamento de pré-requisitos:

| Fase apostada | Match decisivo | Fase pré-requisito |
|---|---|---|
| `r32` | round_of_32 | `group_stage` (12 grupos × 6 jogos = 72) |
| `r16` | round_of_16 | `r32` (16 R32 decididos) |
| `quarters` | quarter_finals | `r16` (8 R16 decididos) |
| `semis` | semi_finals | `quarters` (4 QF decididos) |
| `third_place` | third_place | `semis` (2 SF decididos) |
| `runner_up` | final | `semis` (2 SF decididos) |
| `champion` | final | `semis` (2 SF decididos) |

`isPhaseCompleted` (já existente em qualification.ts) é a fonte:
- `group_stage` → `allGroupGamesPlayed` (72/72)
- `r32` → `allKoDecided(matches, 'round_of_32')` (16 winners definidos)
- etc.

Detecção de derrotas explícitas + 3 exclusões mútuas (final/3º) seguem
funcionando como antes.

### 2) `app/estatisticas/page.tsx` — gate v72 aplicado

```diff
-const real = extractAdvancingTeams(matches);
+const real = extractAdvancingTeams(matches, undefined, {
+  gateGroupStage: true,
+  teams,
+});
```

Efeito visível:
- "Avançou? ✅" em `group_stage` agora só aparece para 1º/2º quando os
  6 jogos do grupo estão completos; melhores 3ºs só quando toda a 1ª
  fase fechar. (Antes vinha do bracket provisório do R32.)
- Fases KO (`r32`/`r16`/...) continuam refletindo o estado real do
  bracket — `extractAdvancingTeams` deriva esses sets dos vencedores
  dos matches KO já decididos, independentemente do gate.

### 3) `app/meus-resultados/page.tsx` — remount admin

```diff
 return (
   <MyResultsView
+    key={targetUserId}
     isSelf={isSelf}
     ...
   />
 );
```

Por que isso ajuda mesmo com page `force-dynamic`:
- Server re-renderiza, props vão limpos para o client component.
- Sem `key`, React reaproveita a instância antiga (mesmo path) → useState
  como `dayFilter` sobrevive entre trocas de jogador.
- Com `key={targetUserId}`, instância antiga é desmontada e nova é
  montada quando o uuid muda — clean slate.
- `useMemo` em si já recomputava (deps mudam por reference), mas o
  remount é defesa em profundidade.

Custo: re-renderizar a árvore (barato — sem fetches client-side).

## O que **não** muda

- ✅ `user_qualification_scores` (não tocado)
- ✅ `points_final` / `is_correct` (não tocados)
- ✅ Regra de pontuação (`scoring.ts`)
- ✅ Regra de desempate (gate v72, h2h v75)
- ✅ Recálculo (`recalc.ts`)
- ✅ Ranking (`/ranking`)
- ✅ Bracket oficial e overrides
- ✅ Snapshots de apostas
- ✅ Banco / migrations / RLS / views
- ✅ `emptyPrediction` (segue ausente desde v76)
- ✅ Status `reached`/`pending`/`eliminated` — semântica mantida
- ✅ Cálculo de `alreadyWon`/`alivePotential`/`lostPotential` (intocado;
  só depende do status vir correto, que agora vem)
- ✅ Tabela "Classificados apostados" da v77c (0 negativos, sub-texto
  positivo) — mantida
- ✅ Card de potencial da v77c — mantido
- ✅ Nenhum `eslint-disable` adicionado

## Cenários

### Cenário 1 — BEL é 3ª no grupo aberto, user apostou BEL em r32/r16/etc

| Fase apostada | v77c (bug) | v77d (corrigido) |
|---|---|---|
| `r32` | ❌ (walk-forward via bracket provisório) | ⏳ (prereq group_stage não completo → walk-forward não dispara) |
| `r16` | ❌ | ⏳ |
| quarters/semis/etc | ❌ | ⏳ |

### Cenário 2 — 1ª fase fechou, BEL ficou em 3º fora dos top-8 melhores

| | v77c | v77d |
|---|---|---|
| group_stage | ❌ ("3º fora dos melhores") | ❌ (mesma resposta, via fast path + branch group_stage) |
| r32 | ❌ | ❌ (prereq group_stage agora completo → walk-forward dispara → BEL não está em R32 → eliminated) |

### Cenário 3 — ARG eliminada nas oitavas, user apostou ARG nas quartas

| | v77c | v77d |
|---|---|---|
| quarters | ❌ (walk-forward + loss-iter) | ❌ (mesma resposta — prereq r32 completo se oitavas começaram) |

### Cenário 4 — `/estatisticas` durante a fase de grupos

| Situação | v77c (bug) | v77d (corrigido) |
|---|---|---|
| Grupo A com 4/6 jogos, bracket provisório populado com 1º/2º atuais | "Avançou? ✅" pros 2 times atuais | "Avançou? —" (gate v72 impede) |
| Todos os grupos com 6/6 jogos | "Avançou? ✅" pros 24 (12×2) | "Avançou? ✅" pros 24 + 8 melhores 3ºs (mesma resposta) |

### Cenário 5 — admin troca jogador via dropdown

| | v77c | v77d |
|---|---|---|
| Filtro de dia (dayFilter) | persiste entre trocas | reseta (key remount) |
| useMemo `potentialBySelection` | recomputava por dep change | recomputa + array novo via remount |
| Status de cada fase | já era correto | igual (semântica não mudou) |
| Defesa contra vazamento de state | implícita | explícita via `key={targetUserId}` |

## Checklist

### Group stage
- [ ] Grupo incompleto nunca marca eliminado.
- [ ] 3º colocado com 1ª fase incompleta = ⏳.
- [ ] 3º colocado depois da 1ª fase, fora top-8 = ❌.
- [ ] 4º colocado com grupo completo = ❌.

### Walk-forward
- [ ] BEL em 3º com grupo aberto: aposta em r32/r16/etc = ⏳ (não ❌).
- [ ] Time eliminado em oitavas: quartas/semis/final/campeão = ❌
  (walk-forward dispara porque prereq r32 está completo, OU loss-iter).

### `/estatisticas`
- [ ] Durante fase de grupos com grupo aberto: "Avançou?" só ✅ para
  times de grupos já fechados (1º/2º).
- [ ] Melhores 3ºs só aparecem como ✅ depois que TODOS os grupos
  fecharem.
- [ ] Fases KO continuam refletindo vencedores reais.

### Admin `/meus-resultados`
- [ ] Admin troca jogador no dropdown → dados do novo jogador aparecem.
- [ ] Filtro de dia reseta na troca (esperado pelo remount).
- [ ] Sem usuário comum vendo dados de outro jogador (RLS + targetUserId
  no fetch).

### Display
- [ ] Sem número negativo em lugar nenhum.
- [ ] Eliminados mostram 0 + sub-texto positivo "pot. perdido: X.X pts".
- [ ] Cards mostram potencial vivo (âmbar), conquistado (verde),
  perdido (vermelho positivo).

### Sem regressão
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.
- [ ] Sem `eslint-disable`.
- [ ] `emptyPrediction` segue ausente.
- [ ] Banco/migrations/RLS/views — intocados.
- [ ] Recálculo, ranking, UQS, bets, snapshots — intocados.

## Como aplicar e testar

```bash
# 1) Substituir os 3 arquivos do zip
rm -rf .next
npm run lint
npm run build

# 2) Smoke
#    a) /meus-resultados como user normal
#       - apostas em time 3º de grupo aberto: ⏳ Aguardando
#       - apostas em time 3º DEPOIS da 1ª fase fechar: ✅ ou ❌
#       - sem números negativos
#
#    b) /meus-resultados como admin
#       - trocar jogador no dropdown
#       - filtro de dia reseta (esperado)
#       - dados do novo jogador aparecem
#       - status condizente com as apostas do jogador
#
#    c) /estatisticas durante fase de grupos
#       - colocar grupo A com 4/6 jogos jogados
#       - 1º/2º do grupo A NÃO aparecem como "Avançou? ✅"
#       - completar o grupo A
#       - 1º/2º agora SIM aparecem como "Avançou? ✅"
#       - melhores 3ºs só aparecem ✅ depois de todos os grupos fecharem
#
#    d) Recálculo
#       - rodar "Recalcular tudo" no admin
#       - pontos não devem mudar (regra de pontos intocada)
```

## Resumo

- **3 arquivos modificados**, **0 novos**, **0 migrations**.
- Walk-forward agora gateado pela fase pré-requisito → não elimina antes
  da hora.
- `/estatisticas` agora usa o mesmo gate v72 que o resto do app.
- Admin em `/meus-resultados` ganhou `key={targetUserId}` (defesa).
- Pontuação real, recálculo, banco, apostas, snapshots — **completamente
  intocados**.
