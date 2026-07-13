# Bolão Copa 2026 — Hotfix v80b (timeout `Recalcular tudo`)

Ajuste sobre v80_hotfix. **Sem migration. Sem alterar banco/apostas/snapshots.**

Corrige o erro observado ao clicar "Recalcular tudo":

```
Erro: An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT
```

## Causa-raiz

`fullRecalc` em `lib/bolao/recalc.ts` era:

```ts
export async function fullRecalc() {
  const { data: matches } = await sb.from('matches').select('...');
  for (const m of (matches ?? [])) {
    if (m.home_score != null && m.away_score != null) {
      await recalcMatchAndAllBets(m.id);  // ← LOOP SEQUENCIAL
    }
  }
  await recalcBracket();
  await recalcAllQualificationScores();
}
```

**Problema**: `recalcMatchAndAllBets(m.id)` para cada match KO dispara
`recalcKnockoutMatchupsForAllUsers` INTERNAMENTE. Essa passagem pagina
todos os profiles/bets/matches/teams/annexC/overrides e simula bracket
por usuário — é a operação mais pesada do recalc.

Com N matches KO com placar, essa passagem pesada rodava **N vezes**. Com
~1500 bets em produção, cada passagem levava vários segundos → total
estourava o `maxDuration = 60` da Vercel → `FUNCTION_INVOCATION_TIMEOUT`.

## Fix

Refatoração de `fullRecalc` (arquivo `lib/bolao/recalc.ts`):

1. Carrega `settings` + `matches` **uma vez** no início.
2. **Grupos**: pontuação direta com zebra por match via helper novo
   `recalcGroupMatchInline` (paralelo nas bets do match; loop sequencial
   entre os matches para preservar isolamento de zebra por match).
3. **KO**: zera TODAS as bets KO em lote (`.in('match_id', koMatchIds)`) e
   grava `result_code` em batch paralelo.
4. **Cross-phase KO recalc**: chama `recalcKnockoutMatchupsForAllUsers`
   **UMA vez** no fim do bloco KO.
5. `recalcBracket` e `recalcAllQualificationScores` como antes.

Também bump em `app/api/recalc/route.ts`:
- `maxDuration = 60` → `maxDuration = 300`.
- No plano Hobby fica limitado a 60s de qualquer forma; no Pro sobe pra
  300s. O refactor já reduz o tempo pra caber em 60s no caso comum —
  o bump é rede de segurança para picos.

## Ganho estimado

| Momento | Passagens pesadas em `recalcKnockoutMatchupsForAllUsers` |
|---|---|
| Antes | N (uma por KO match com placar) |
| Agora | 1 |

Com 8-16 matches KO já jogados em produção, isso reduz ~8-16× o tempo do
cross-phase. Se ~40s eram gastos nele antes, cai pra ~2-5s.

## Arquivos modificados (2 · 0 migrations)

| Arquivo | Mudança |
|---|---|
| `lib/bolao/recalc.ts` | Novo helper `recalcGroupMatchInline` (privado). `fullRecalc` refatorado para chamar cross-phase KO uma vez. Comportamento externo de `recalcMatchAndAllBets` inalterado — quando admin edita um placar isolado, o flow existente continua igual. |
| `app/api/recalc/route.ts` | `maxDuration = 60 → 300`. |

## O que **não** muda

- ✅ `recalcMatchAndAllBets` (usada pelo admin ao editar placar isolado)
  — comportamento intocado. Continua chamando cross-phase interno para
  refletir o novo placar imediatamente naquela rota.
- ✅ `recalcKnockoutMatchupsForAllUsers` — intocada; só passa a ser
  chamada 1× no `fullRecalc` (era N×).
- ✅ `recalcBracket`, `recalcAllQualificationScores` — intocadas.
- ✅ Regra de pontuação, snapshot, banco, apostas — intocados.
- ✅ v79_hotfix + v80_hotfix (snapshot + pens=null) — preservados.
- ✅ Nenhum `eslint-disable`.

## Como aplicar

```bash
# 1) Substituir os 2 arquivos do zip:
#    - lib/bolao/recalc.ts
#    - app/api/recalc/route.ts

# 2) Build + deploy
rm -rf .next && npm run lint && npm run build && deploy

# 3) Testar
/admin/configuracao → 🔄 Recalcular tudo
# Esperado: retorna 200 dentro de 60s. UQS + bets KO regenerados
# com a regra v79 + v80 (snapshot + advancer sem pens reais).
```

## Notas sobre os erros de sandbox

Ao rodar `tsc --noEmit` no sandbox aparece:

```
app/api/recalc/route.ts(33,20): error TS2591: Cannot find name 'process'.
```

Isso é **falso positivo do sandbox** — a linha `process.env.CRON_SECRET`
já existia antes da minha mudança e sempre compilou no ambiente do
projeto (que tem `@types/node`). Não é regressão introduzida pela v80b.

## Se ainda estourar após v80b

Se estiver no plano Vercel Hobby (60s max efetivo), e ainda estourar:
1. Migrar para Vercel Pro (permite 300s).
2. Ou dividir em 2 endpoints: `/api/recalc/games` (grupos + cross-phase KO)
   e `/api/recalc/quals` (UQS + bracket). Chamar sequencial no client.

Mas a expectativa é que o refactor sozinho já resolva o timeout.
