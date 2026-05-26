# Bolão Copa 2026 — Atualização v59

Dois ajustes no detalhamento de pontuação por fase, em `/apostas` (topo) e
em `/admin/pontuacao`:

1. **Ordem final**: Terceiro → Vice → Campeão (antes vinha Terceiro →
   Campeão → Vice).
2. **Status tri-estado**: ✅ acertou / ❌ errou (fase concluída) / ⏳ pendente
   (fase ainda não concluída). Antes mostrava ⏳ até quando a fase já tinha
   acabado e o time não classificou.

Nenhuma alteração em scoring/cálculo. Nenhuma migration.
Home (`app/page.tsx`) intocada — alterações limitadas ao detalhamento.

## Diagnóstico

### 1. Onde a ordem atual estava definida
- `components/MyPointsSummary.tsx` chamava `.order('phase')` no Supabase
  para `user_qualification_scores`.
- `app/admin/pontuacao/page.tsx` idem.
- No Postgres, `ORDER BY <enum>` segue a **ordem física do enum**, e a
  migration 006 fez `ALTER TYPE … ADD VALUE 'runner_up' AFTER 'champion'`.
  A ordem física ficou:
  `group_stage, r32, r16, quarters, semis, third_place, champion, runner_up`
  → renderizada como Terceiro → Campeão → Vice (bug visual).

### 2. Ordem nova (DISPLAY_ORDER)
```
group_stage → r32 → r16 → quarters → semis → third_place → runner_up → champion
```
Aplicada **no client** via `.sort()` com índice em `PHASE_DISPLAY_ORDER`
(nova constante exportada de `lib/bolao/qualification.ts`). O enum no
banco continua igual; reordenar o enum exigiria recriar o tipo e migrar
todas as colunas dependentes — desnecessário para fix puramente visual.

### 3. Onde o ícone era definido
- `components/MyPointsSummary.tsx:87` → `{q.is_correct ? '✅' : '⏳'}`
- `app/admin/pontuacao/page.tsx:127` → `{q.is_correct ? '✅' : '❌'}`

Cada lugar tinha um comportamento diferente, e nenhum distinguia "errou"
de "pendente".

### 4. Como o sistema decidia se algo estava pendente
**Não decidia.** Os ícones só olhavam `is_correct`, sem checar a fase real.
`is_correct = false` cobria os dois casos (errou + ainda sem resultado).

### 5. Como decido agora que uma fase foi concluída
Novo helper em `lib/bolao/qualification.ts`:
```ts
export function isPhaseCompleted(phase, matches: Match[]): boolean
```
Regras:

| Fase | Concluída quando… |
|---|---|
| `group_stage` | todos os jogos `group_stage_1/2/3` têm `home_score` e `away_score` |
| `r32` | todos os 16 jogos `round_of_32` têm vencedor decidido (placar + pens se empate) |
| `r16` | idem 8 jogos `round_of_16` |
| `quarters` | idem 4 jogos `quarter_finals` |
| `semis` | idem 2 jogos `semi_finals` |
| `third_place` | 1 jogo `third_place` com vencedor decidido |
| `runner_up` / `champion` | 1 jogo `final` com vencedor decidido (mesmo jogo cobre ambos) |

Empate de KO sem `home_pens/away_pens` preenchidos é tratado como NÃO
decidido (e portanto a fase fica como `false` → status `⏳`).

### 6. Arquivos alterados (3)
| Arquivo | Mudança |
|---|---|
| `lib/bolao/qualification.ts` | Exporta `PHASE_DISPLAY_ORDER` e `isPhaseCompleted(phase, matches)`. Não altera scoring nem `PHASE_ORDER` (que continua usado pelo recálculo). |
| `components/MyPointsSummary.tsx` | • Nova query `matches`.<br>• `quals` ordenados no client por `PHASE_DISPLAY_ORDER`.<br>• Mapa `completedByPhase`.<br>• Status na linha: `is_correct ? ✅ : completed ? ❌ : ⏳`. |
| `app/admin/pontuacao/page.tsx` | • Ordena `userQuals` por `PHASE_DISPLAY_ORDER`.<br>• Reaproveita `allMatches` já carregado para `completedByPhase`.<br>• Mesmo tri-estado. |

### 7. Migration SQL
**Nenhuma.**

## Revisão de hardcoded (sem ação necessária)

- O cálculo real usa **sempre** `phasePointsBase(phase, settings)` onde
  `settings` vem do DB (carregado em `recalc.ts → recalcAllQualificationScores`).
- `DEFAULT_SETTINGS` (`lib/bolao/scoring.ts`) e `QUAL_DEFAULTS`
  (`components/SettingsForm.tsx`) ainda mostram os antigos
  10/12/15/25/30/30/30/40 — mas só são usados:
  - **DEFAULT_SETTINGS**: fallback se a linha de settings sumir do DB
    (cenário improvável). NÃO sobrescreve o valor do banco.
  - **QUAL_DEFAULTS**: apenas para o botão "↻ Restaurar padrões" no admin.
    Clicar lá *intencionalmente* restaura para esses valores (admin tem
    que confirmar com "Salvar"). Mesmo assim, atualmente vai jogar valor
    antigo na tela — se quiser eu atualizo num próximo patch, sem migration.

Recomendação: **não atualizar** por enquanto, para evitar mudar a
semântica do "restaurar padrões" sem o seu OK explícito.

## Nova ordem (objetiva)

Em `lib/bolao/qualification.ts`:

```ts
export const PHASE_DISPLAY_ORDER: QualificationPhase[] = [
  'group_stage', 'r32', 'r16', 'quarters', 'semis',
  'third_place', 'runner_up', 'champion',
];
```

Aplicada em `MyPointsSummary` e `admin/pontuacao` via:

```ts
const quals = [...qualsRaw].sort((a, b) =>
  PHASE_DISPLAY_ORDER.indexOf(a.phase) - PHASE_DISPLAY_ORDER.indexOf(b.phase)
);
```

## Regra do tri-estado

```ts
const status = q.is_correct
  ? '✅'
  : (completedByPhase[phase] ? '❌' : '⏳');
```

Onde `completedByPhase` é um `Record<QualificationPhase, boolean>` montado
uma vez por render via `isPhaseCompleted(phase, matches)`.

## Helper novo

`isPhaseCompleted(phase: QualificationPhase, matches: Match[]): boolean`
em **`lib/bolao/qualification.ts`**. Não duplicado em nenhum outro lugar.
Não afeta scoring (`is_correct` continua sendo determinado pelo recalc com
base em `extractAdvancingTeams(realMatches)`).

## Como testar

```bash
# 1) Aplicar os 3 arquivos do zip
# 2) Limpar cache + rodar dev
rm -rf .next
npm run dev

# 3) Logar como admin e como usuário comum
# 4) Lint + build
npm run lint && npm run build
```

### Cenários

**Cenário A — ordem**
1. Recalcular tudo (ou ter linhas de qual scores já gravadas).
2. Abrir `/apostas` → "Detalhar pontuação por fase".
3. Ver ordem: Avança dos grupos → Vence R32 → Vence R16 → Vence Quartas →
   Finalistas → 3º lugar → **Vice-campeão** → **Campeão**.
4. Idem em `/admin/pontuacao?user=<id>`.

**Cenário B — tri-estado: grupos concluídos, time não classificou**
1. Preencher resultados reais de TODOS os 72 jogos de grupos. Recalcular.
2. Para um usuário que apostou em uma seleção que **não** se classificou:
   o detalhamento mostra ❌ para essa seleção em `group_stage`.

**Cenário C — tri-estado: KO ainda pendente**
1. Grupos preenchidos, mas Quartas ainda sem resultado.
2. Para uma seleção apostada como vencedora das Quartas mas ainda sem
   resultado real: o detalhamento mostra ⏳ (não ❌).

**Cenário D — tri-estado: acertou**
1. Para qualquer fase em que o usuário acertou a seleção: ✅ continua
   aparecendo, independentemente de a fase estar completa ou não.

**Cenário E — KO empatado sem pens**
1. Resultado real de um jogo `final` com `home_score = away_score` e
   `home_pens = null, away_pens = null`.
2. `isPhaseCompleted('champion', matches)` retorna `false` → status para
   apostas de Campeão e Vice mostram ⏳ até que admin preencha os pênaltis.

## Checklist de validação

### Ordem
- [ ] `/apostas` → "Detalhar pontuação por fase" mostra **Terceiro → Vice → Campeão** no final.
- [ ] `/admin/pontuacao?user=<id>` mostra a mesma ordem na tabela de
      qualification scores.

### Status tri-estado
- [ ] Fase ainda não concluída → status pendente como **⏳**.
- [ ] Fase concluída e time não classificou → status como **❌**.
- [ ] Time classificou (independente da fase estar completa ou não) → **✅**.
- [ ] KO empatado sem pênaltis preenchidos → ainda **⏳** (não decidido).

### Vice continua pontuando
- [ ] Vice no detalhamento ainda mostra `points_final` correto (vindo do recalc).
- [ ] Valor de pontos vem de `settings.pts_qual_runner_up` (atualmente 30 no
      DB, mas admin pode alterar para qualquer valor — testado: ranking
      reflete o novo valor após "Recalcular tudo").

### Sem regressão
- [ ] `/comparativo` não afetado.
- [ ] `/estatisticas` não afetado.
- [ ] Admin (`/admin/*`) funciona normalmente.
- [ ] `app/page.tsx` (home) **não alterada**.
- [ ] `components/PixCopyBox.tsx`, `components/TeamNameWithFlag.tsx`,
      `app/globals.css` **não alterados**.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **3 arquivos** alterados.
- **0 migrations**.
- 1 helper novo (`isPhaseCompleted`) em `lib/bolao/qualification.ts`.
- 1 constante nova (`PHASE_DISPLAY_ORDER`) — separada de `PHASE_ORDER`
  para não acoplar exibição ao recálculo.
- Home, scoring, recalc, ranking, comparativo, estatísticas e admin
  intocados (exceto o detalhamento do `/admin/pontuacao`).
