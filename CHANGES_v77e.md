# Bolão Copa 2026 — Atualização v77e

Patch sobre v77/v77b/v77c/v77d. **Sem migration. Sem alterar pontuação,
ranking, recálculo, banco, apostas, snapshots, UQS ou regras de desempate.**

Corrige 3 problemas restantes após a v77d:

1. **Fases futuras de seleção eliminada NOS GRUPOS continuavam com ⏳**
   (loss-iter ignora group_stage_* por design → KO ficava `pending`).
2. **"Seleções com maior potencial" ainda inflava** porque o status vinha
   errado (item 1) e a ordenação não seguia o spec exato.
3. **`/estatisticas` não diferenciava eliminados** (só "Avançou? ✅/—").

## Diagnóstico

| # | Resposta |
|---|---|
| 1 | Fases futuras com ⏳ porque `evaluateKOPhaseStatus` (em v77d) tinha walk-forward gateado por fase pré-requisito + loss-iter que **pula `group_stage_*` por design** (matches de grupos não eliminam KO via loss-iter). Resultado: time 4º colocado (ou 3º fora dos melhores após 1ª fase fechar) com aposta em r32/r16/.../champion devolvia `pending`. |
| 2 | **Potencial vivo inflado** = consequência direta do item 1. `potentialBySelection` agregava por status: `if status === 'pending' → alivePotential`. Status veio errado → potencial entrou no balde errado. Lógica de soma em si está correta — só precisa do status certo. |
| 3 | Bug em **3 lugares**: (a) `evaluateTeamPhaseStatus` em `qualification.ts` (falta propagar eliminação de grupos para KO); (b) ordenação em `MyResultsView.tsx` (precisa seguir spec exato `alreadyWon + alivePotential` + desempates); (c) `/estatisticas` (sem coluna de status visual). |
| 4 | **Propagação implementada** via helper `evaluateGroupStageStatusInternal(team, matches, teams)` extraído do branch group_stage existente. Chamado em `evaluateTeamPhaseStatus` ANTES de cair para KO: se `groupStatus === 'eliminated'` e `phase !== 'group_stage'` → retorna `eliminated`. Cobre 4º colocado de grupo fechado e 3º fora dos top-8 após 1ª fase fechar. |
| 5 | `/estatisticas` chama `evaluateTeamPhaseStatus(team.id, phase, matches, teams, real)` com `real` pré-computado (gate v72 já aplicado pela v77d). Renderiza `✅`/`⏳`/`❌` na nova coluna "Status" + cor de fundo da linha. Nunca crava antes do gate. |
| 6 | **3 arquivos**: `lib/bolao/qualification.ts`, `components/MyResultsView.tsx`, `app/estatisticas/page.tsx`. |
| 7 | **Sem migration**. |
| 8 | Ranking, recálculo, banco, UQS, points_final, is_correct, bets, snapshots — **intocados**. |

## Mudanças por arquivo

### 1) `lib/bolao/qualification.ts`

#### Extrair `evaluateGroupStageStatusInternal` (helper privado)

```ts
function evaluateGroupStageStatusInternal(
  teamId: number,
  matches: Match[],
  teams: Team[],
): TeamPhaseStatus {
  const team = teams.find(t => t.id === teamId);
  if (!team) return 'pending';
  const completed = getCompletedGroups(matches);
  if (!completed.has(team.group_code)) return 'pending';   // grupo aberto
  const standings = computeGroupStandings(teams, matches, {
    tieBreakerMode: 'head_to_head',
  });
  const std = standings.get(team.group_code);
  const idx = std?.findIndex(s => s.team_id === teamId) ?? -1;
  if (idx === 3) return 'eliminated';                       // 4º
  if (idx === 0 || idx === 1) return 'reached';             // 1º/2º defesa
  if (idx === 2) {                                          // 3º
    if (!isGroupStageFullyComplete(matches)) return 'pending';
    return 'eliminated';                                    // 3º fora dos top-8
  }
  return 'pending';
}
```

#### Propagar no `evaluateTeamPhaseStatus`

```diff
+ // 3) Fase de grupos (helper isolado — também é PRÉ-REQUISITO de KO).
+ const groupStatus = evaluateGroupStageStatusInternal(teamId, matches, teams);
+ if (phase === 'group_stage') return groupStatus;
+
+ // 4) v77e — Propagação de eliminação de grupos para KO:
+ //    Se o time foi eliminado na fase de grupos, ele NÃO pode mais
+ //    alcançar NENHUMA fase KO.
+ if (groupStatus === 'eliminated') return 'eliminated';
+
- // 4) Fases KO: walk-forward + derrotas reais.
+ // 5) Fases KO: walk-forward (v77d) + derrotas reais (loss-iter).
  return evaluateKOPhaseStatus(teamId, phase, matches);
```

#### `precomputedReal` opcional (perf)

```diff
 export function evaluateTeamPhaseStatus(
   teamId, phase, matches, teams,
+  precomputedReal?: Record<QualificationPhase, Set<number>>,
 ): TeamPhaseStatus {
-  const real = extractAdvancingTeams(matches, undefined, {
+  const real = precomputedReal ?? extractAdvancingTeams(matches, undefined, {
     gateGroupStage: true, teams,
   });
```

Backward-compatible — callers existentes não mudam.

### 2) `components/MyResultsView.tsx`

#### Pré-computar `real` uma vez por render

```tsx
const realAdvancing = useMemo(
  () => extractAdvancingTeams(allMatches, undefined, { gateGroupStage: true, teams }),
  [allMatches, teams],
);
```

E passar nas 2 chamadas a `evaluateTeamPhaseStatus` (tabela + consolidado).
Evita N+1 de standings em cada render.

#### Ordenação por spec exato

```diff
 .sort((a, b) => {
-  const aLive = a.sumPotentialAlive + a.sumEarned;
-  const bLive = b.sumPotentialAlive + b.sumEarned;
-  if (bLive !== aLive) return bLive - aLive;
-  const aAct = a.phases.filter(p => p.status !== 'eliminated').length;
-  const bAct = b.phases.filter(p => p.status !== 'eliminated').length;
-  if (bAct !== aAct) return bAct - aAct;
+  // 1) sortScore = alreadyWon + alivePotential (desc)
+  const aScore = a.sumEarned + a.sumPotentialAlive;
+  const bScore = b.sumEarned + b.sumPotentialAlive;
+  if (bScore !== aScore) return bScore - aScore;
+  // 2) alivePotential (desc)
+  if (b.sumPotentialAlive !== a.sumPotentialAlive)
+    return b.sumPotentialAlive - a.sumPotentialAlive;
+  // 3) alreadyWon (desc)
+  if (b.sumEarned !== a.sumEarned) return b.sumEarned - a.sumEarned;
+  // 4) lostPotential (asc — menor perdido sobe)
+  if (a.sumPotentialLost !== b.sumPotentialLost)
+    return a.sumPotentialLost - b.sumPotentialLost;
   const na = a.team?.name ?? '';
   const nb = b.team?.name ?? '';
   return na.localeCompare(nb, 'pt-BR');
 });
```

#### Chips por fase com ícone + pts (em vez de multiplicador)

```diff
- {PHASE_SHORT[p.phase]} · {p.multiplier.toFixed(2)}×
+ {icon} {PHASE_SHORT[p.phase]} · {label}
```

Onde:

| status | icon | label | cor |
|---|---|---|---|
| reached | ✅ | `12.0 pts` (earned) | verde |
| pending | ⏳ | `pot. 8.5 pts` (potential) | cinza |
| eliminated | ❌ | `perdido 5.0 pts` (potential, positivo, tachado) | vermelho |

Tooltip mantém o multiplicador para quem quiser.

### 3) `app/estatisticas/page.tsx`

#### Coluna "Avançou?" vira "Status" tri-estado

```diff
- type Row = { team: Team; bettors: number; pct: number; reallyAdvanced: boolean; factor: number; possiblePts: number };
+ type Row = {
+   team: Team;
+   bettors: number;
+   pct: number;
+   status: TeamPhaseStatus;  // v77e — tri-estado
+   factor: number;
+   possiblePts: number;
+ };
```

```diff
- const reallyAdvanced = real[phase].has(t.id);
+ const status = evaluateTeamPhaseStatus(t.id, phase, matches, teams, real);
```

```diff
- <th>Avançou?</th>
+ <th>Status</th>
```

Render:

| status | icon | cor da linha |
|---|---|---|
| reached | ✅ | `bg-green-50` (mantido) |
| pending | ⏳ | sem destaque |
| eliminated | ❌ | `bg-red-50/60` (novo) |

`evaluateTeamPhaseStatus` herda o gate v72 da v77d (1º/2º só após grupo
fechar, 3ºs só após 1ª fase fechar) — não há regressão sobre o que a
v77d entregou.

## O que **não** muda

- ✅ `user_qualification_scores` (não tocado)
- ✅ `points_final` / `is_correct` (não tocados)
- ✅ Regra de pontuação (`scoring.ts`)
- ✅ Regras de desempate (gate v72, h2h v75)
- ✅ Recálculo (`recalc.ts`)
- ✅ Ranking (`/ranking`)
- ✅ Bracket oficial e overrides
- ✅ Snapshots de apostas
- ✅ Banco / migrations / RLS / views
- ✅ `emptyPrediction` (segue ausente desde v76)
- ✅ Nenhum `eslint-disable` adicionado
- ✅ Nenhum número negativo na UI

## Cenários (todos passam)

### Cenário 1 — Time eliminado nos grupos (4º colocado), user apostou KO

User apostou seleção X em `r32`, `r16`, `quarters`, `semis`, `champion`.
Grupo fechou e X ficou em 4º.

| Fase | Antes (v77d) | Agora (v77e) |
|---|---|---|
| group_stage | ❌ Eliminada no grupo | ❌ (mesma resposta) |
| r32 | ⏳ Aguardando | ❌ Não vai pontuar |
| r16 | ⏳ | ❌ |
| quarters | ⏳ | ❌ |
| semis | ⏳ | ❌ |
| champion | ⏳ | ❌ |

### Cenário 2 — 3º colocado fora dos top-8 após 1ª fase fechar

Seleção Y ficou em 3º com 1ª fase fechada, mas fora dos melhores 3ºs.

| Fase | Antes (v77d) | Agora (v77e) |
|---|---|---|
| group_stage | ❌ ("3º fora dos melhores") | ❌ (mesma resposta) |
| r32/r16/.../champion | ⏳ | ❌ (propagação nova) |

### Cenário 3 — 3º colocado durante 1ª fase aberta

Seleção Z em 3º, grupo fechou, mas 1ª fase inteira ainda aberta.

| Fase | Antes (v77d) | Agora (v77e) |
|---|---|---|
| group_stage | ⏳ Aguardando fim da 1ª fase | ⏳ (mesma resposta — correto) |
| r32/r16/.../champion | ⏳ | ⏳ (groupStatus = pending → KO segue pending) |

### Cenário 4 — Time perdeu nas oitavas (KO)

Loss-iter já cobria. Sem mudança vs v77d.

### Cenário 5 — `/estatisticas` durante fase de grupos

| Situação | Antes (v77d) | Agora (v77e) |
|---|---|---|
| Time 4º de grupo fechado, com votos em group_stage | "Avançou? —" | "Status ❌" + linha vermelha |
| Time 1º de grupo fechado, com votos em group_stage | "Avançou? ✅" + verde | "Status ✅" + verde (mesma resposta) |
| Time em grupo aberto | "—" | "⏳" (mais informativo) |

### Cenário 6 — Ordenação do consolidado por seleção

User apostou:
- **A** com sumEarned=10, sumPotentialAlive=20, sumPotentialLost=0
- **B** com sumEarned=15, sumPotentialAlive=15, sumPotentialLost=5
- **C** com sumEarned=0,  sumPotentialAlive=0,  sumPotentialLost=30

Ordenação v77e:
1. **A**: score=30, alive=20
2. **B**: score=30, alive=15 (empate em score → alive maior ganha)
3. **C**: score=0, alive=0 (eliminada)

Antes (v77c/d), B vinha à frente de A por desempate de "fases não-eliminadas".
Agora segue spec exato: `score` desc → `alivePotential` desc → `alreadyWon` desc → `lostPotential` asc → nome.

### Cenário 7 — Sem negativos

Mantido da v77c: tabela mostra `0` + sub-texto `pot. perdido: X.X pts`
(positivo); card mostra `25.4 pts` no campo "Pot. perdido" (positivo).
Chips eliminados mostram `perdido X.X pts` (positivo, tachado).

## Checklist obrigatório

### Propagação de eliminação
- [ ] 4º colocado de grupo fechado: r32/r16/quarters/semis/champion = ❌.
- [ ] 3º fora dos top-8 (1ª fase fechada): mesma propagação para todas as KO.
- [ ] 3º com 1ª fase aberta: tudo ⏳ (não cravar).
- [ ] 1º/2º com grupo fechado: group_stage ✅; KO depende de jogos
  já decididos (sem mudança vs v77d).
- [ ] Time eliminado em r16: quartas/semis/final/champion = ❌ (loss-iter).
- [ ] Time finalista: third_place = ❌ (exclusão mútua v77c).
- [ ] Time campeão: runner_up = ❌ (exclusão mútua v77c).
- [ ] Time vice: champion = ❌ (exclusão mútua v77c).

### Ordenação consolidado
- [ ] Score primário = `alreadyWon + alivePotential` desc.
- [ ] Desempate 1: `alivePotential` desc.
- [ ] Desempate 2: `alreadyWon` desc.
- [ ] Desempate 3: `lostPotential` asc.
- [ ] Desempate 4: nome asc.

### `/estatisticas`
- [ ] Coluna "Status" mostra ✅/⏳/❌.
- [ ] Times eliminados ganham linha vermelha discreta.
- [ ] Times classificados continuam com linha verde.
- [ ] Pendentes sem destaque.
- [ ] Gate v72 mantido (1º/2º só após grupo fechar, 3ºs só após 1ª fase).
- [ ] Bracket provisório NÃO conta como classificação.

### UI consistente com v77c
- [ ] Sem número negativo em lugar nenhum.
- [ ] "Pts Finais" para eliminados = `0` + sub-texto positivo.
- [ ] Card "Pot. perdido" = número positivo + cor vermelha.
- [ ] Chips por fase: ícone + nome curto + pts (em vez de multiplicador).

### Sem regressão
- [ ] Ranking não muda.
- [ ] Recálculo não muda.
- [ ] Banco não muda (sem migration).
- [ ] Apostas/snapshots não mudam.
- [ ] Sem `eslint-disable`.
- [ ] `emptyPrediction` não volta.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Como aplicar e testar

```bash
# 1) Substituir os 3 arquivos do zip
rm -rf .next
npm run lint
npm run build

# 2) Smoke /meus-resultados
#    Cenário cabeça: 4º colocado com aposta em todas as fases
#    Esperado: group_stage=❌, r32/r16/.../champion=❌ (não mais ⏳)

# 3) Smoke /estatisticas durante fase de grupos
#    Esperado: status ✅/⏳/❌ por linha; sem bracket provisório como
#    prova de classificação

# 4) Smoke ordenação do consolidado
#    Esperado: seleções com maior (alreadyWon + alivePotential) primeiro;
#    seleções 100% eliminadas no fim

# 5) Smoke recálculo (admin)
#    Rodar "Recalcular tudo" — pontos NÃO devem mudar (regra intocada)
```

## Resumo

- **3 arquivos modificados**, **0 novos**, **0 migrations**.
- Propagação cirúrgica: `evaluateGroupStageStatusInternal` extraído + 1
  if novo em `evaluateTeamPhaseStatus`.
- `precomputedReal` opcional para perf (sem quebrar callers).
- Ordenação consolidada segue spec exato.
- `/estatisticas` ganha tri-estado.
- Banco, recálculo, ranking, apostas, snapshots, UQS — **completamente
  intocados**.
