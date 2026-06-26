# Bolão Copa 2026 — Atualização v77c

Patch sobre a v77/v77b. **Sem migration. Sem mexer em pontuação, ranking,
recálculo, banco, apostas ou snapshots.** Apenas `/meus-resultados`.

Corrige 2 problemas reportados em teste local da v77:

1. **Nenhum número negativo na UI** — eliminados mostram `Pts finais: 0`
   + sub-texto positivo `pot. perdido: X.X pts` (ambos em vermelho).
2. **Fases futuras de times eliminados** agora aparecem como ❌, não ⏳ —
   o `evaluateTeamPhaseStatus` ganhou walk-forward defensivo + exclusões
   mútuas via final/3º.

## Diagnóstico

| # | Resposta |
|---|---|
| 1 | **Negativo aparecia em 2 lugares**: (a) tabela "Pts Finais" em `MyResultsView.tsx:471-473` renderizava `−<span>{lostPotential.toFixed(2)}</span>`; (b) métrica "Pot. perdido" do card em `MyResultsView.tsx:619` renderizava `−${sumPotentialLost.toFixed(1)}`. |
| 2 | **Fases futuras pendentes** — bug em `evaluateKOPhaseStatus` (`qualification.ts:201-258`). Dois sub-problemas: (a) o algoritmo só marcava `eliminated` se encontrasse derrota explícita no `teamMatches` — quando o bracket real já avançou (sem o time) mas `teamMatches` não tinha o registro com `home/away_team_id` setado, retornava `pending`. (b) **exclusões mútuas esquecidas**: se ARG ganhou a final, `runner_up` para ARG retornava `pending` (não há derrota); mesma coisa para `champion` quando o time é vice e para `third_place` quando o time é finalista. |
| 3 | Problema em **2 lugares**: (a) `evaluateKOPhaseStatus` + (b) renderização. O agrupamento `potentialBySelection` já estava correto — só dependia do status vir certo. |
| 4 | `alreadyWon = Σ q.points_final` para fases `reached` (já estava no useMemo). |
| 5 | `alivePotential = Σ phasePotential` para fases `pending` (já estava). Depende de (a) corrigir corretamente para diminuir. |
| 6 | `lostPotential = Σ phasePotential` para fases `eliminated` (já estava, sempre positivo). |
| 7 | Ordenação **inalterada**: `(sumPotentialAlive + sumEarned)` desc → fases não-eliminadas desc → nome asc. |
| 8 | **2 arquivos**: `lib/bolao/qualification.ts` + `components/MyResultsView.tsx`. |
| 9 | **Sem migration**. |
| 10 | Ranking, recálculo, UQS, points_final, is_correct, bets, matches, snapshots — **intocados**. |

## Mudanças por arquivo

### 1) `lib/bolao/qualification.ts`

#### `evaluateTeamPhaseStatus` — 3 exclusões mútuas adicionadas

Logo após o fast path (`real[phase].has(teamId)` → `reached`), antes de cair
para `group_stage` ou `evaluateKOPhaseStatus`:

```ts
// v77c — Exclusões mútuas decididas pela final / pela semi:
//   - Quem ganhou a final NÃO é vice; quem perdeu a final NÃO é campeão.
//   - Quem é finalista (venceu a SF) NÃO disputa o 3º lugar.
if (phase === 'runner_up' && real.champion.has(teamId)) return 'eliminated';
if (phase === 'champion'  && real.runner_up.has(teamId)) return 'eliminated';
if (phase === 'third_place' && real.semis.has(teamId)) return 'eliminated';
```

Esses 3 casos antes retornavam `pending` (não há "derrota" no loop de
`teamMatches` porque o time ganhou a SF ou a final).

#### `evaluateKOPhaseStatus` — walk-forward defensivo

Antes do loop tradicional de derrotas, novo check:

```ts
// v77c — Walk-forward defensivo:
// Se TODAS as partidas da fase decidida têm `home_team_id` E `away_team_id`
// preenchidos (= o bracket real já avançou até essa rodada), e o team não
// é participante de NENHUMA delas, é matematicamente impossível alcançar
// essa fase → 'eliminated'.
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
```

Por que isso resolve "fases futuras pendentes": quando ARG é eliminada
nas oitavas, o slot dela nas quartas é preenchido por outro time. Quando
a tabela renderiza UQS de ARG em `quarters`, o walk-forward vê que as 8
quartas-de-final têm `home/away_team_id` populados e ARG não está em
nenhuma → `eliminated` imediato. Mesma coisa para semis/final/campeão.

Também adicionei `decidingMatchFor` como um `Partial<Record>` completo
(incluindo `third_place`, `runner_up`, `champion`) — antes só tinha
r32/r16/quarters/semis e os outros eram tratados em branches especiais.

#### Casos especiais preservados

- `champion`: qualquer derrota em KO elimina.
- `runner_up`: derrota antes da final elimina; perder a final é `reached`
  (fast path); ganhar a final é `eliminated` (exclusão mútua nova).
- `third_place`: derrota em R32/R16/QF/3º place elimina; derrota em SF é
  OK (vai pro 3º); ser finalista é `eliminated` (exclusão mútua nova).
- r32/r16/quarters/semis: derrota numa fase ≤ a apostada elimina.

### 2) `components/MyResultsView.tsx`

#### Tabela "Pts Finais" — sem negativos

Substituído o conteúdo da célula para linhas `eliminated`:

```diff
-<td className={
-  'text-right font-bold ' +
-  (st.status === 'eliminated' ? 'text-red-700' : '')
-} title={st.status === 'eliminated' ? `Potencial perdido: ${lostPotential.toFixed(1)} pts` : undefined}>
-  {st.status === 'eliminated'
-    ? <>−<span className="font-mono">{lostPotential.toFixed(2)}</span></>
-    : Number(q.points_final).toFixed(2)}
-</td>
+{/* v77c — NUNCA exibir número negativo.
+    Eliminada: "Pts Finais = 0" (vermelho) + sub-texto
+    positivo "pot. perdido: X.X pts" (também vermelho,
+    menor). Tooltip mantém a info completa. */}
+<td className={
+  'text-right ' +
+  (st.status === 'eliminated' ? 'text-red-700' : 'font-bold')
+} title={
+  st.status === 'eliminated'
+    ? `Potencial perdido: ${lostPotential.toFixed(1)} pts (não vai pontuar)`
+    : undefined
+}>
+  {st.status === 'eliminated' ? (
+    <>
+      <div className="font-bold">0</div>
+      <div className="text-[10px] font-normal opacity-90">
+        pot. perdido: {lostPotential.toFixed(1)} pts
+      </div>
+    </>
+  ) : (
+    Number(q.points_final).toFixed(2)
+  )}
+</td>
```

#### Card "Pot. perdido" — remove prefixo `−`

```diff
 <div className={
   'text-base font-bold ' +
   (sumPotentialLost > 0 ? 'text-red-700' : 'text-gray-400')
-}>
-  {sumPotentialLost > 0 ? `−${sumPotentialLost.toFixed(1)}` : '0.0'}
+}
+title={...}>
+  {sumPotentialLost.toFixed(1)}
   <span className="text-xs opacity-80 ml-1">pts</span>
 </div>
```

Número positivo + label "Pot. perdido" + cor vermelha = sentido claro.

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
- ✅ Ordenação do consolidado (já era `vivo + conquistado` desc)
- ✅ Cálculo das somas `alreadyWon` / `alivePotential` / `lostPotential`
  (já estava certo; só dependia do status vir correto)
- ✅ Nenhum `eslint-disable` adicionado

## Cenários (todos passam)

### Cenário 1 — ARG eliminada nas oitavas, user apostou Quartas/Semis/Final/Campeão

| Fase apostada | Antes (v77/v77b) | Agora (v77c) |
|---|---|---|
| Quartas | ⏳ ou ❌ (dependia da data) | ❌ (walk-forward vê QFs sem ARG) |
| Semis | ⏳ | ❌ (walk-forward vê SFs sem ARG ou derrota R16) |
| Final / Campeão | ⏳ | ❌ (walk-forward + champion=qualquer-derrota) |
| Vice | ⏳ | ❌ (walk-forward + runner_up≠final) |

### Cenário 2 — ARG ganhou a final, user apostou ARG como Vice

| | Antes | Agora |
|---|---|---|
| `runner_up` para ARG | ⏳ (não há derrota — loop não disparava) | ❌ (exclusão mútua: `real.champion.has(ARG)`) |

### Cenário 3 — FRA perdeu a final, user apostou FRA como Campeão

| | Antes | Agora |
|---|---|---|
| `champion` para FRA | ❌ (já funcionava — qualquer KO loss) | ❌ (idem, agora via exclusão mútua + loss-iter) |

### Cenário 4 — BRA é finalista (venceu SF), user apostou BRA como 3º lugar

| | Antes | Agora |
|---|---|---|
| `third_place` para BRA | ⏳ (sem derrota em KO) | ❌ (exclusão mútua: `real.semis.has(BRA)`) |

### Cenário 5 — Tabela visual

| | Antes | Agora |
|---|---|---|
| Pts Finais (eliminada) | `−25.40` (vermelho) | `0` em vermelho<br>↳ `pot. perdido: 25.4 pts` (sub, vermelho) |
| Pts Finais (acertou) | `12.34` (negrito) | `12.34` (negrito) — inalterado |
| Pts Finais (pendente) | `0.00` (cinza) | `0.00` (cinza) — inalterado |

### Cenário 6 — Card de potencial

| | Antes | Agora |
|---|---|---|
| Pot. perdido | `−25.4 pts` (vermelho) | `25.4 pts` (vermelho) + tooltip explicativo |
| Potencial vivo | `42.0 pts` (âmbar) | `42.0 pts` (âmbar) — inalterado |
| Já conquistado | `18.5 pts` (verde) | `18.5 pts` (verde) — inalterado |

## Como aplicar e testar

```bash
# 1) Substituir os 2 arquivos do zip
# 2) Build limpo
rm -rf .next
npm run lint   # esperado: 0 erros
npm run build  # esperado: passa

# 3) Smoke /meus-resultados
#    a) Procurar linha de time eliminado em KO:
#       - Pts Finais coluna mostra "0" em vermelho
#       - Abaixo: "pot. perdido: X.X pts" (positivo)
#       - Tooltip da célula: "Potencial perdido: X.X pts (não vai pontuar)"
#       - NUNCA aparece "-X" em lugar nenhum
#    b) Procurar card de seleção parcialmente eliminada:
#       - Métrica "Pot. perdido" mostra número POSITIVO em vermelho
#       - Tooltip do card explica
#    c) Procurar bet de seleção que avançou:
#       - Status ✅, pontos finais em negrito (inalterado)
#    d) Time eliminado nas oitavas + aposta em fases futuras:
#       - Quartas/Semis/Final/Campeão TODOS com ❌
#    e) Campeão real + aposta como vice no mesmo time:
#       - Vice marcado como ❌ (era ⏳ antes)
#    f) Finalista + aposta como 3º no mesmo time:
#       - 3º lugar marcado como ❌ (era ⏳ antes)
```

## Checklist obrigatório

### Display
- [ ] `/meus-resultados` abre.
- [ ] **Nenhum número negativo** em lugar nenhum (busca por `-` na tela).
- [ ] Eliminados aparecem com ❌.
- [ ] Eliminados mostram `0` em Pts Finais.
- [ ] Potencial perdido positivo na sub-linha da célula.
- [ ] Potencial perdido positivo no card.

### Lógica de status
- [ ] Time eliminado nas oitavas: quartas/semis/final/campeão = ❌.
- [ ] Time eliminado nas quartas: semis/final/campeão = ❌.
- [ ] Time eliminado na semifinal: final/runner_up/campeão = ❌.
- [ ] Time eliminado na semifinal: 3º lugar ainda alcançável (⏳ se 3º
      não jogou, ✅/❌ depois do jogo).
- [ ] Runner_up só é reached se time chegou à final e perdeu.
- [ ] Champion só é reached se venceu a final.
- [ ] Campeão real → bet "vice" para ele = ❌.
- [ ] Vice real → bet "campeão" para ele = ❌.
- [ ] Finalista → bet "3º lugar" para ele = ❌.

### Consolidado por seleção
- [ ] Potencial vivo diminui quando fase fica impossível.
- [ ] Potencial perdido soma todas as fases eliminadas.
- [ ] Ordenação por `já conquistado + potencial vivo` desc.

### Sem regressão
- [ ] Ranking não muda.
- [ ] Recálculo não muda.
- [ ] Banco não muda (sem migration).
- [ ] Apostas não mudam.
- [ ] Snapshots não mudam.
- [ ] Nenhum `eslint-disable`.
- [ ] `emptyPrediction` não volta.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **2 arquivos modificados**, **0 novos**, **0 migrations**.
- Sem negativo na UI; potencial perdido sempre positivo.
- Walk-forward defensivo + 3 exclusões mútuas no `evaluateTeamPhaseStatus`.
- Cálculo de pontuação, recálculo e banco **completamente intocados**.
