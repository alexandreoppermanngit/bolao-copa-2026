# Bolão Copa 2026 — Atualização v77b (lint-fix da v77)

Patch incremental sobre a v77. **Só corrige lint** — toda a lógica
da v77 (status visual de eliminados + potencial perdido) está preservada.

**Sem migration. Sem alterar pontuação. Sem alterar recálculo. Sem alterar banco.
Sem alterar apostas/snapshots.** Único arquivo tocado: `components/MyResultsView.tsx`.

## Erros reportados (após v77)

```text
./components/MyResultsView.tsx
145:9   Error: 'completedByPhase' is assigned a value but never used.   @typescript-eslint/no-unused-vars
499:18  Error: `"` can be escaped with `&quot;`, ...                    react/no-unescaped-entities
499:40  Error: `"` can be escaped with `&quot;`, ...                    react/no-unescaped-entities
```

## Diagnóstico

| # | Resposta |
|---|---|
| 1 | `completedByPhase` declarado em `MyResultsView.tsx:145` como `useMemo<Record<QualificationPhase, boolean>>`. |
| 2 | **Sim, ficou obsoleto.** Era consumido pela versão anterior de `classificationStatus(phase, teamId, isCorrect)` para decidir entre ⏳ e ❌. A v77 reescreveu essa função para delegar tudo a `evaluateTeamPhaseStatus`, que já internaliza a verificação de fase completa via `extractAdvancingTeams` (gate v72 + h2h v75). Nenhum outro código no arquivo lia `completedByPhase` — verificado por grep. |
| 3 | JSX problemático: linha 499 da subtitle do card "Seleções com maior potencial de pontos": `soma "vivo + já conquistado" desc.` — as duas aspas retas (`"`) violam `react/no-unescaped-entities`. |
| 4 | Menor correção segura: (a) remover o bloco `useMemo` órfão (linhas 145–154) + tirar `isPhaseCompleted` do import (já que era o único consumidor); (b) trocar as duas `"` por `&quot;` na linha 499. |
| 5 | **1 arquivo alterado**: `components/MyResultsView.tsx`. `lib/bolao/qualification.ts` **não muda**. |

## Mudanças (1 arquivo · 0 migrations)

### `components/MyResultsView.tsx`

**1. Import — remove `isPhaseCompleted` (não há mais uso após v77)**

```diff
 import {
-  PHASE_DISPLAY_ORDER, isPhaseCompleted,
+  // v77 — `isPhaseCompleted` deixou de ser usado aqui; toda a lógica
+  // de "fase concluída / time eliminado" agora está em
+  // `evaluateTeamPhaseStatus`. Removido do import para evitar
+  // warning de no-unused-vars sem usar eslint-disable.
+  PHASE_DISPLAY_ORDER,
   getCompletedGroups, isGroupStageFullyComplete,
   phasePointsBase, evaluateTeamPhaseStatus,
   type TeamPhaseStatus,
 } from '@/lib/bolao/qualification';
```

**2. Bloco `completedByPhase` removido — substituído por comentário curto**

```diff
-  // ----- classificados (UQS) — ordenados por DISPLAY_ORDER, com fallback para fases concluídas -----
-  // v72 — usa `allMatches` (todos os 104) em vez de só os do usuário, para
-  // os gates de classificação funcionarem corretamente (precisamos saber
-  // se cada grupo da Copa tem 6 jogos, não só os do usuário).
-  const completedByPhase: Record<QualificationPhase, boolean> = useMemo(() => ({
-    group_stage: isPhaseCompleted('group_stage', allMatches),
-    r32:         isPhaseCompleted('r32', allMatches),
-    r16:         isPhaseCompleted('r16', allMatches),
-    quarters:    isPhaseCompleted('quarters', allMatches),
-    semis:       isPhaseCompleted('semis', allMatches),
-    third_place: isPhaseCompleted('third_place', allMatches),
-    runner_up:   isPhaseCompleted('runner_up', allMatches),
-    champion:    isPhaseCompleted('champion', allMatches),
-  }), [allMatches]);
+  // ----- classificados (UQS) — ordenados por DISPLAY_ORDER -----
+  // v77 — o antigo `completedByPhase` foi removido; toda a lógica de
+  // "fase concluída / time eliminado / pendente" agora vive dentro de
+  // `evaluateTeamPhaseStatus` (lib/bolao/qualification.ts), que já consome
+  // `allMatches` via `extractAdvancingTeams`. Mantido aqui só o cálculo
+  // de grupos completos que ainda é usado abaixo.
```

**3. Aspas escapadas no JSX**

```diff
-            soma "vivo + já conquistado" desc.
+            soma &quot;vivo + já conquistado&quot; desc.
```

## O que **não** muda

- ✅ `evaluateTeamPhaseStatus` em `qualification.ts` — intocado.
- ✅ Cálculo de potencial vivo / perdido / conquistado — intocado.
- ✅ Status `reached / pending / eliminated` — intocado.
- ✅ Tabela de classificados (linhas vermelhas + tooltip "−X.XX") — intocada.
- ✅ Card `PotentialCard` (4 métricas + chips coloridos) — intocado.
- ✅ Ordenação dos cards — intocada.
- ✅ Recálculo (`recalc.ts`) — intocado.
- ✅ Ranking (`/ranking`) — intocado.
- ✅ Banco, RLS, views, migrations — intocados.
- ✅ Apostas, snapshots, UQS — intocados.
- ✅ Admin troca de usuário — intocada.
- ✅ `emptyPrediction` — segue ausente (v76 removeu, v77/v77b não trazem de volta).
- ✅ Sem `eslint-disable` adicionado.

## Como aplicar e testar

```bash
# 1) Substituir apenas components/MyResultsView.tsx
# 2) Build limpo
rm -rf .next
npm run lint   # esperado: 0 erros (os 3 desapareceram)
npm run build  # esperado: passa

# 3) Smoke
#    a) /meus-resultados abre normalmente.
#    b) Linhas de times eliminados continuam vermelhas com ❌.
#    c) Coluna "Pts Finais" continua mostrando "−X.XX" em vermelho.
#    d) Cards com 4 métricas (Mult / Já conquistado / Potencial vivo / Pot. perdido).
#    e) Chips por fase: verde/cinza/vermelho com tooltip.
#    f) Subtitle do card mostra: soma "vivo + já conquistado" desc.
#       (as aspas aparecem normais no navegador — apenas o source HTML usa &quot;)
```

## Checklist

- [ ] `npm run lint` passa (sem os 3 erros da v77).
- [ ] `npm run build` passa.
- [ ] Sem `eslint-disable` adicionado.
- [ ] `emptyPrediction` segue ausente (`grep -R "function emptyPrediction" lib/bolao/qualification.ts` vazio).
- [ ] `/meus-resultados` abre.
- [ ] Status de eliminados continua funcionando (❌ + fundo vermelho).
- [ ] Potencial perdido em vermelho.
- [ ] Potencial vivo em âmbar.
- [ ] Pontos conquistados em verde.
- [ ] Admin pode trocar usuário (página continua aceitando query `?user=`).
- [ ] `/ranking` igual.
- [ ] Recálculo igual.
- [ ] Banco igual.
- [ ] Apostas iguais.
- [ ] Snapshots iguais.

## Resumo

- **1 arquivo modificado**, **0 novos**, **0 migrations**.
- Remove import órfão (`isPhaseCompleted`) e bloco `useMemo` órfão (`completedByPhase`).
- Escapa 2 aspas no JSX.
- Lógica da v77 100% preservada.
