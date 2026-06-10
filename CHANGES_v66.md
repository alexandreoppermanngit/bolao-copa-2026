# Bolão Copa 2026 — Atualização v66

Conserto definitivo do backfill de snapshots (`bets.bet_home_team_id` /
`bet_away_team_id`). Rota nova com **dry-run + repair**, fix do bug raiz
da v65, e nova fonte de dados (`user_qualification_scores`) para
final/3º lugar.

## Diagnóstico — por que a v65 deixou tantos pendentes

**Bug raiz**: o Supabase JS client **trunca SELECTs em 1000 linhas** por
padrão quando você não passa `range`/`limit` explícito. A rota da v65
fazia `sb.from('bets').select('*')` sem paginação. Com 1.556 bets totais
(374 + 374 + 372 + 215 + 104 + 52 + 26 + 13 + 13), só processou as
primeiras 1000 — exatamente o que bate com os 64% de cobertura que você
viu nos grupos.

Os outros pontos do checklist do v65:

| Pergunta | Verificado |
|---|---|
| Bets sem placar? | Não havia esse filtro — todas processadas. |
| Bets antigas? | Sem filtro por data. |
| Só preenchia ambos juntos? | Não — home e away são independentes. |
| Query trouxe campos? | `select('*')` traz tudo, **mas só 1000 linhas** (root cause). |
| Matches de grupo sem `home_team_id`? | Não — seed garante. |
| Final/3º quase nulos? | (a) truncamento; (b) simulação tolerante exigia `areAllGroupsMature` parcialmente; (c) UQS (`champion`, `runner_up`, `third_place`) era fonte óbvia e a v65 não usava. |

## v66 — rota nova

**`POST /api/admin/repair-bet-snapshots`**

| Querystring | Default | Efeito |
|---|---|---|
| (nenhum) | dryRun | Diagnostica, retorna propostas, **não toca no banco**. |
| `?mode=repair` | — | Aplica propostas de `confidence='high'`. |
| `?mode=repair&includeMedium=true` | — | Aplica `high` e `medium`. |
| `?force=true` | — | Sobrescreve snapshots existentes (use só após revisar divergences). |

## Estratégia de proposta por fase

| Fase | Fonte | Confidence | Observação |
|---|---|---|---|
| `group_stage_*` | `matches.home_team_id` / `away_team_id` | **high** | Slots fixos no schema — trivial. |
| `final` | UQS `champion` + `runner_up` | **high** se advancer presente; **medium** se inferida | Orientação via `knockout_advancer`; sem advancer marca `orientation_inferred=true`. |
| `third_place` | UQS `third_place` + simulação | **medium** se sim resolveu ambos; **low** se parcial | Adversário precisa vir da simulação. |
| `round_of_32`/`16`/QF/SF | Simulação tolerante por usuário | **medium** se ambos; **low** se parcial | Sem `areAllGroupsMature` como bloqueio. |
| Nenhum acima | — | — | Vai para `pending` como `source='manual_needed'`. |

## Proteções (todas garantidas)

- **Paginação explícita** via `fetchAll(page=1000)` — nunca mais perde linhas.
- Nunca apaga `bets`, scores, advancer, points.
- Nunca toca em `matches`/RLS/ranking/pontuação.
- Snapshot existente igual à proposta: **skip**.
- Snapshot existente diferente: **NÃO sobrescreve**, vai para `divergences`. Só com `?force=true` sobrescreve.
- `mode=repair` sem opt-in só aplica `high`.

## Estrutura do JSON de resposta

```json
{
  "success": true,
  "dryRun": true,
  "mode": "dryRun",
  "includeMedium": false,
  "force": false,
  "totalBets": 1556,
  "missingBefore": 970,
  "wouldUpdate": 1100,
  "updated": 0,
  "byPhase": {
    "group_stage_1": { "total": 374, "missing_before": 114, "proposals_high": 114, "proposals_medium": 0, "proposals_low": 0, "pending": 0, "divergences": 0, "applied": 0 },
    "round_of_32":   { "total": 215, "missing_before": 159, "proposals_high": 0, "proposals_medium": 120, "proposals_low": 20, "pending": 19, "divergences": 0, "applied": 0 },
    "final":         { "total": 13,  "missing_before": 12, "proposals_high": 10, "proposals_medium": 2, "proposals_low": 0, "pending": 0, "divergences": 0, "applied": 0 }
  },
  "proposals": [
    {
      "user_id": "uuid-1",
      "display_name": "Fulano",
      "match_id": 30,
      "phase": "group_stage_1",
      "current_home_team_id": null,
      "current_away_team_id": null,
      "proposed_home_team_id": 7,
      "proposed_away_team_id": 12,
      "source": "group_stage_match_fixed",
      "confidence": "high",
      "orientation_inferred": false,
      "reason": "Match de fase de grupos tem times fixos no schema."
    }
  ],
  "pending": [],
  "divergences": [],
  "diagnostics": {
    "pagination_used": true,
    "page_size": 1000,
    "bets_pages": 2,
    "note_v65_bug": "v65 esquecia paginação e truncava em 1000. v66 lê tudo via fetchAll()."
  },
  "ms": 1247
}
```

Listas grandes (`proposals`, `pending`, `divergences`) são truncadas em
500/200/200 itens na resposta para não estourar JSON. Diagnostics conta
os valores reais.

## Roteiro recomendado

```bash
# 1) Aplicar arquivo da rota
#    (sem migrations; tudo é código)

# 2) Deploy local
rm -rf .next && npm run lint && npm run build && npm run dev

# 3) DRY-RUN (1ª vez): só diagnóstico, não muda nada
curl -X POST https://seu-dominio.vercel.app/api/admin/repair-bet-snapshots \
  -H "Cookie: <cookies do admin logado>"

#    Revisar resposta:
#    - byPhase para entender quantas propostas high/medium/low por fase.
#    - divergences: idealmente vazio. Se aparecer, INVESTIGAR antes.
#    - pending: lista de bets que precisam de ação manual.

# 4) REPAIR — fase 1: aplica só HIGH (grupos + finais com advancer)
curl -X POST 'https://seu-dominio.vercel.app/api/admin/repair-bet-snapshots?mode=repair' \
  -H "Cookie: <cookies>"

#    Esperado: byPhase['group_stage_*'].applied = missing_before (todos
#    os grupos reparados). Final.applied = quantidade com champion+runner_up+advancer.

# 5) REPAIR — fase 2 (opcional): aplica HIGH + MEDIUM
curl -X POST 'https://seu-dominio.vercel.app/api/admin/repair-bet-snapshots?mode=repair&includeMedium=true' \
  -H "Cookie: <cookies>"

#    Esperado: maioria dos KO recebe snapshot via simulação.

# 6) Conferir no banco:
#    Você pode rodar a mesma query SQL que usou antes (por fase) — agora
#    os pendentes de group_stage_* devem ir a zero, e KO bem mais cheios.
```

## Por que dry-run primeiro?

A v65 mostrou que migrations + scripts sem dry-run quebram silenciosamente.
Agora você roda dry-run, lê `byPhase` e `divergences`, decide se gosta das
propostas, e só então aplica.

## Checklist de validação

- [ ] Dry-run não altera banco (`updated=0`, `wouldUpdate>0`).
- [ ] Fase de grupos pendente → todas viram `proposals_high`.
- [ ] `mode=repair` repara fase de grupos completamente.
- [ ] Final: tenta UQS `champion` + `runner_up`; orientação via `advancer`.
- [ ] 3º lugar: tenta UQS `third_place` + simulação.
- [ ] Snapshots existentes não são sobrescritos (sem `?force=true`).
- [ ] Snapshots divergentes vão para `divergences` e NÃO são tocados.
- [ ] Nenhuma aposta é apagada.
- [ ] Nenhum placar/advancer/points alterado.
- [ ] `/comparativo` volta a ter snapshot após reparo.
- [ ] `/estatisticas` volta a ter snapshot após reparo.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `app/api/admin/repair-bet-snapshots/route.ts` | **NOVO** — rota com dry-run + repair, paginação explícita, UQS-based para final/3º, divergence reporting. |

**0 migrations**. **0 alterações** em RLS, views, scoring, recalc, ranking, schema,
TS de páginas/componentes. Rota nova, isolada, idempotente, opt-in.

## O que a v65 segue valendo

A v65 fez o trabalho estrutural certo:
- Migration 008 (colunas) — ✓
- `/api/bets/save` salvando snapshots em novas apostas — ✓
- `BetForm.tsx` enviando snapshots — ✓
- `audit.ts`, `qualification.ts`, `BetsAdminTable.tsx` lendo snapshots — ✓
- Rota `/api/admin/backfill-bet-snapshots` (v65) — ainda existe, mas
  recomendo usar a `repair-bet-snapshots` (v66) que é mais robusta.
  Posso depreciar a antiga em um próximo patch se quiser limpeza.

A v66 só conserta o backfill que falhou.

## Resumo

- **1 rota nova** com dry-run e repair.
- **0 migrations**.
- Diagnóstico claro: bug do limit 1000.
- Reparo cirúrgico em fase de grupos garantido (`high confidence`).
- Final/3º agora usam UQS (`user_qualification_scores`) como fonte primária.
- KO usam simulação tolerante (sem `areAllGroupsMature` como bloqueio).
- Snapshots existentes nunca são sobrescritos sem opt-in.
