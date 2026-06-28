# Bolão Copa 2026 — Atualização v77f

Patch sobre v77/v77b/v77c/v77d/v77e. **Sem migration. Sem alterar
pontuação, ranking, recálculo, banco, apostas, snapshots, UQS ou regras
de desempate.**

**1 arquivo modificado** (`lib/bolao/qualification.ts`).

## Bug reportado

Após v77e, seleções **classificadas para o round_of_32** estavam sendo
marcadas como ❌ nas fases SEGUINTES (r16/quartas/.../campeão) antes
mesmo do R32 acontecer.

Pista do usuário: "Cheque principalmente as seleções que se classificaram
em terceiro colocadas".

## Causa-raiz

A v77e introduziu o helper `evaluateGroupStageStatusInternal` para
propagar eliminação de grupos para fases KO. O helper devolvia
`eliminated` para QUALQUER 3º colocado com 1ª fase fechada — **inclusive
os 8 melhores 3ºs que se classificaram** — porque o comentário "fast
path captura top-8 thirds" estava errado.

### O que o "fast path" REALMENTE faz

Em `evaluateTeamPhaseStatus`:

```ts
if (real[phase].has(teamId)) return 'reached';
```

Esse fast path checa `real` para a fase **QUERIDA** pelo caller.

- Se caller pergunta `phase='group_stage'` para um 3º top-8 → checa
  `real.group_stage.has(team)` → SIM (gate v72 inclui top-8) → 'reached'. ✓
- Se caller pergunta `phase='r16'` para o MESMO 3º top-8 → checa
  `real.r16.has(team)` → NÃO (R16 não jogou ainda) → cai para o helper.

### O que o helper fazia (errado)

```ts
if (idx === 2) {                         // 3º colocado
  if (!isGroupStageFullyComplete(matches)) return 'pending';
  return 'eliminated';   // ← INCORRETO: marca top-8 também!
}
```

Comentário enganoso: "se caímos aqui é porque NÃO está em top-8". Errado
— a função era invocada SEMPRE para 3ºs com 1ª fase fechada, top-8 ou não.

### Resultado

Para 3º top-8 X com aposta em `r16`/`quartas`/.../`champion`:
1. `real[phase]` não tem X → não dispara fast path.
2. `evaluateGroupStageStatusInternal` retorna `eliminated` (bug).
3. Propagação v77e: `if (groupStatus === 'eliminated') return 'eliminated'`.
4. ❌ marcado em TODAS as fases futuras, mesmo com R32 não jogado.

## Fix

Adicionar **fast path local** no início de
`evaluateGroupStageStatusInternal`: se o time está em `real.group_stage`
(que via gate v72 inclui 1º/2º de grupos fechados + top-8 3ºs), retornar
`'reached'` imediatamente.

```diff
 function evaluateGroupStageStatusInternal(
   teamId: number,
   matches: Match[],
   teams: Team[],
+  real: Record<QualificationPhase, Set<number>>,
 ): TeamPhaseStatus {
+  // v77f — Fast path local: time em real.group_stage = avançou para KO.
+  if (real.group_stage.has(teamId)) return 'reached';
+
   const team = teams.find(t => t.id === teamId);
   ...
 }
```

E passar `real` no call site em `evaluateTeamPhaseStatus`:

```diff
- const groupStatus = evaluateGroupStageStatusInternal(teamId, matches, teams);
+ const groupStatus = evaluateGroupStageStatusInternal(teamId, matches, teams, real);
```

## Como isso resolve cada cenário

### 3º top-8 X classificado para R32 (1ª fase fechada), aposta r16/.../champion

| Fase | v77e (bug) | v77f |
|---|---|---|
| group_stage | ✅ (fast path do caller) | ✅ |
| r16 | ❌ (bug) | ⏳ (groupStatus = 'reached' agora → fall through → KO loss-iter sem perdas → 'pending') |
| quartas | ❌ | ⏳ |
| semis | ❌ | ⏳ |
| final / champion / runner_up | ❌ | ⏳ |

### 1º/2º Y de grupo fechado, aposta em r16/.../champion

| Fase | v77e | v77f |
|---|---|---|
| group_stage | ✅ | ✅ |
| r16/.../champion | ⏳ (já funcionava — idx 0/1 fazia 'reached') | ⏳ (mesma resposta, agora via fast path) |

### 3º NÃO top-8 Z (1ª fase fechada), aposta r16/.../champion

| Fase | v77e | v77f |
|---|---|---|
| group_stage | ❌ ("3º fora dos melhores") | ❌ |
| r16/.../champion | ❌ (propagação v77e — correto) | ❌ (mesma resposta — propagação mantida; helper agora chega no branch idx===2 e retorna 'eliminated' porque real.group_stage.has(Z) é false) |

### 4º colocado W de grupo fechado, aposta r16/.../champion

| Fase | v77e | v77f |
|---|---|---|
| group_stage | ❌ | ❌ |
| r16/.../champion | ❌ (propagação) | ❌ (mesma resposta) |

### 3º com 1ª fase aberta

| Fase | v77e | v77f |
|---|---|---|
| group_stage | ⏳ | ⏳ |
| r16/.../champion | ⏳ (groupStatus 'pending' → KO 'pending') | ⏳ (mesma resposta) |

## O que **não** muda

- ✅ Walk-forward gateado por prereq (v77d) — intocado.
- ✅ Exclusões mútuas via final/SF (v77c) — intocadas.
- ✅ Propagação de `groupStatus === 'eliminated'` (v77e) — mantida; agora
  só dispara para casos REAIS de eliminação (4º colocado, 3º fora top-8).
- ✅ `extractAdvancingTeams` (gate v72, h2h v75) — intocado.
- ✅ `user_qualification_scores`, `points_final`, `is_correct`.
- ✅ Recálculo, ranking, banco, RLS, migrations.
- ✅ Bracket oficial, snapshots, apostas.
- ✅ Tabela "Classificados apostados" da v77c (sem negativos).
- ✅ Card de potencial (vivo/conquistado/perdido) da v77c.
- ✅ Ordenação consolidada (alreadyWon + alivePotential) da v77e.
- ✅ Chips com ícone + pts da v77e.
- ✅ Status visual ✅/⏳/❌ em /estatisticas da v77e.
- ✅ Admin remount via `key={targetUserId}` da v77d.
- ✅ `emptyPrediction` segue ausente desde v76.
- ✅ Nenhum `eslint-disable` adicionado.

## Efeito automático em outras telas

Como `/meus-resultados` e `/estatisticas` chamam o mesmo
`evaluateTeamPhaseStatus`, o fix se propaga sem alterar essas páginas:

- **/meus-resultados**: 3º top-8 com apostas KO mostra ⏳ em vez de ❌
  → potencial entra em `alivePotential` em vez de `lostPotential` →
  card mostra potencial vivo correto e ordenação fica certa.
- **/estatisticas**: coluna "Status" para 3º top-8 fica ⏳ até o R32
  acontecer; depois evolui para ✅/❌ conforme o resultado.

## Checklist

### Caso central (3º top-8)
- [ ] Time 3º classificado top-8 com aposta em r16: ⏳ (não ❌).
- [ ] Mesma coisa para quartas/semis/final/champion/runner_up.
- [ ] Após R32 jogado, status reflete vitória/derrota real.

### Regressão (casos da v77e devem continuar)
- [ ] 4º colocado de grupo fechado: r16/.../champion = ❌.
- [ ] 3º NÃO top-8 (1ª fase fechada): r16/.../champion = ❌.
- [ ] 3º com 1ª fase aberta: tudo ⏳.
- [ ] 1º/2º de grupo fechado: group_stage ✅, KO depende do bracket.
- [ ] Time eliminado em r16 (KO loss-iter): quartas/.../champion = ❌.
- [ ] Time finalista: third_place = ❌.
- [ ] Time campeão: runner_up = ❌.
- [ ] Time vice: champion = ❌.

### /meus-resultados
- [ ] Potencial vivo do 3º top-8 inclui r16/quartas/semis/final/champion
  enquanto eles ainda podem acontecer.
- [ ] Sem número negativo.
- [ ] Ordenação consolidada por (alreadyWon + alivePotential) desc.

### /estatisticas
- [ ] 3º top-8 mostra ⏳ em fases futuras (não ❌).
- [ ] 4º/3º fora top-8 mostram ❌ em fases futuras (propagação correta).
- [ ] Pendentes sem destaque visual.
- [ ] Classificados continuam com linha verde.
- [ ] Eliminados continuam com linha vermelha.

### Sem regressão
- [ ] Ranking não muda.
- [ ] Recálculo não muda.
- [ ] Banco não muda (sem migration).
- [ ] Apostas/snapshots não mudam.
- [ ] Sem `eslint-disable`.
- [ ] `emptyPrediction` segue ausente.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Como aplicar

```bash
# 1) Substituir apenas lib/bolao/qualification.ts
rm -rf .next
npm run lint
npm run build

# 2) Smoke
#    Cenário crítico: 3º top-8 com aposta em todas as fases KO
#    Esperado: group_stage=✅; r16/quartas/semis/final/champion=⏳

#    Cenário regressão: 3º fora top-8 com aposta em todas as fases KO
#    Esperado: group_stage=❌; r16/.../champion=❌ (propagação mantida)

#    Cenário regressão: 4º colocado com aposta em todas as fases KO
#    Esperado: group_stage=❌; r16/.../champion=❌
```

## Resumo

- **1 arquivo modificado**, **0 novos**, **0 migrations**.
- Fix de 4 linhas no helper interno + ajuste de signature.
- Resolve o bug crítico v77e sem regressão dos cenários já cobertos.
- Banco, recálculo, ranking, apostas, snapshots, UQS — **intocados**.
