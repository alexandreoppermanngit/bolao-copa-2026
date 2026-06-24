# Bolão Copa 2026 — Atualização v74

`/admin/resultados` ganha **scroll automático para hoje/próximos jogos**
no carregamento + **botão "📅 Ir para hoje / próximos jogos"** para repetir
o atalho. Lista agrupada visualmente por data, com a row do dia-alvo em
destaque. Sem migration, sem alterar pontuação/recálculo/permissões.

## Diagnóstico

| # | Resposta |
|---|---|
| 1 | `components/ResultsEditor.tsx` (Client Component) renderiza a tabela única; `app/admin/resultados/page.tsx` é o wrapper server. |
| 2 | **Não** — tabela contínua ordenada por `id`. Agrupamento por data foi feito **nesta v74**. |
| 3 | `match_date` (ISO `YYYY-MM-DD`) + `kickoff_brt` (`HH:MM`). Exibido como `MM-DD` cortado. |
| 4 | Helper `getBrtTodayISO()` existia inline em `MyResultsView.tsx` (v71). **v74 extraiu para `lib/bolao/matchSchedule.ts`** + `pickInitialDayFromDates(sortedDates, today)`. Reutilizados pelos dois lados. |
| 5 | **Botão + âncoras por data** (opção A). Filtro não — manteria a regra do spec de "não esconder anteriores". |
| 6 | 3 arquivos: `lib/bolao/matchSchedule.ts`, `components/MyResultsView.tsx`, `components/ResultsEditor.tsx`. |
| 7 | **Sem migration**. |

## Estratégia

### Backend (zero impacto)
- `app/admin/resultados/page.tsx` inalterado.
- Permissões/recálculo/salvamento individual/lote/reset inalterados.

### Frontend (`ResultsEditor.tsx`)
- **Agrupamento**: matches agrupados por `match_date`; dentro de cada
  dia, ordenados por `kickoff_brt` asc, depois `id` asc.
- **Row-header por data**: `<tr id="results-date-YYYY-MM-DD" class="...">`
  com `colSpan={9}` mostrando "📅 11/06/2026 · 4 jogos". Funciona como
  âncora `scrollIntoView`. Estilo:
  - **Alvo (hoje/próximos)**: `bg-amber-50` + borda âmbar + badge
    `HOJE` ou `PRÓXIMOS JOGOS` em accent-red.
  - **Passado**: `bg-gray-50` + label "passado".
  - **Futuro**: `bg-blue-50/40`.
- **Scroll automático**: `useEffect` no mount roda `scrollIntoView` na
  row do `targetDate`. Apenas 1× por mount (via `useRef` guard).
- **Botão "📅 Ir para hoje / próximos jogos"**: no toolbar, ao lado dos
  outros botões. Re-executa o scroll quando o admin quiser voltar ao
  dia-alvo após rolar pra cima.
- **Dica discreta**: parágrafo curto abaixo da toolbar explicando o
  comportamento.

### Helpers (`matchSchedule.ts`)
- `getBrtTodayISO()`: `YYYY-MM-DD` do hoje em horário de Brasília
  (UTC-3 fixo). Imune ao fuso do client.
- `pickInitialDayFromDates(sortedDates, today)`: retorna a data-alvo
  (hoje → próximo → último → `'all'` se vazio).

Ambos antes inline em `MyResultsView`, agora compartilhados.

## Arquivos alterados (3) · 0 migrations

| Arquivo | Mudança |
|---|---|
| `lib/bolao/matchSchedule.ts` | + `getBrtTodayISO()` exportado.<br>+ `pickInitialDayFromDates(sortedDates, today)` exportado. |
| `components/MyResultsView.tsx` | Remove helpers inline; passa a importar do `matchSchedule`. Chamada renomeada `pickInitialDay` → `pickInitialDayFromDates`. |
| `components/ResultsEditor.tsx` | • Imports novos (`Fragment`, `useCallback`, `useEffect`, `useRef`, helpers).<br>• `matchesByDate`/`sortedDates` via `useMemo`.<br>• `targetDate` via `pickInitialDayFromDates(getBrtTodayISO)`.<br>• `goToToday()` + `useEffect` para scroll automático.<br>• Toolbar ganha botão `📅 Ir para hoje / próximos jogos`.<br>• `<tbody>` reescrito: `<tr>` de cabeçalho por data + jogos do dia. Destaque visual sutil para a row alvo. |

## Comportamento por cenário

| Cenário | Comportamento |
|---|---|
| Há jogos hoje (BRT) | Abre rolada até a row "📅 hoje · N jogos" com badge "HOJE". |
| Sem jogos hoje, há próximos | Abre rolada até o próximo dia futuro, com badge "PRÓXIMOS JOGOS". |
| Todos os jogos passaram | Abre rolada até o último dia da lista. |
| Lista vazia | Botão fica oculto; tabela vazia. |
| Admin clica em "Ir para hoje / próximos" | Repete o scroll para a row-alvo (mesmo se ele já tinha rolado pra cima). |
| Admin rola pra cima | Lista completa preservada — pode editar qualquer data anterior normalmente. |

## Cuidados preservados

- ✅ Salvar individual (`/api/results`).
- ✅ Salvar em lote (`/api/results/batch`).
- ✅ Recalcular tudo (`/api/recalc`).
- ✅ Resetar placares (admin completo).
- ✅ Audit log.
- ✅ Permissões (admin vs editor de resultados).
- ✅ Pontuação/ranking.
- ✅ Banco/migrations.

Sem nenhuma alteração de regra ou de RLS.

## Como testar

```bash
rm -rf .next && npm run lint && npm run build && npm run dev

# 1) /admin/resultados (logado como admin ou editor)
# 2) Página deve abrir já rolada até a row de "hoje" (badge HOJE).
#    - Se hoje não tem jogos: abre na primeira data futura (badge PRÓXIMOS JOGOS).
#    - Se Copa acabou: abre no último dia.
# 3) Rolar para cima → conferir que datas anteriores aparecem (com badge "passado").
# 4) Clicar "📅 Ir para hoje / próximos jogos" → deve voltar à row-alvo.
# 5) Salvar individual / em lote / reset / recalcular: tudo continua funcionando.
# 6) Permissões: editor de resultados não vê o botão de reset (já estava assim).
# 7) Mobile: testar em DevTools responsivo. Row-header tem texto curto.
```

## Checklist

- [ ] `/admin/resultados` abre para admin e editor de resultados.
- [ ] Página rola automaticamente até jogos de hoje (BRT) se existirem.
- [ ] Sem hoje → próximo dia com jogos.
- [ ] Sem futuros → último dia com jogos.
- [ ] Jogos anteriores continuam visíveis (lista completa preservada).
- [ ] Admin consegue rolar para cima e editar datas anteriores.
- [ ] Botão "Ir para hoje / próximos jogos" repete o scroll.
- [ ] Linhas de cabeçalho de data com `id="results-date-YYYY-MM-DD"`.
- [ ] Row alvo com destaque âmbar + badge `HOJE` ou `PRÓXIMOS JOGOS`.
- [ ] Salvar individual continua funcionando.
- [ ] Salvar em lote continua funcionando.
- [ ] Resetar placares só aparece para admin completo.
- [ ] Sem mudança de regra de pontuação, ranking, banco, migration.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **3 arquivos modificados**, **0 novos**, **0 migrations**.
- 2 helpers extraídos para `matchSchedule.ts` (reuso entre `/meus-resultados`
  e `/admin/resultados`).
- Agrupamento por data em `<tbody>` com âncoras por id, scroll automático
  e botão de atalho.
- Estado salvo, lógica de save/lote/reset/recálculo **intocados**.
