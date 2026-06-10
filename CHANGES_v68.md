# Bolão Copa 2026 — Atualização v68 (HOTFIX da v67)

Antes de aplicar a v67, você perguntou: **a pontuação real é afetada?**
**o CSV foi corrigido?** A resposta é **sim, ambos eram bugs** que ficaram
de fora da v67. Esta v68 fecha as duas frentes.

## O que a v67 NÃO cobriu (e a v68 cobre)

### 1. Pontuação por classificados — **CRÍTICO**
`lib/bolao/recalc.ts` tinha 2 funções com o mesmo bug de limit 1000:

| Função | Query problemática | Impacto |
|---|---|---|
| `recalcAllQualificationScores` (linha 235) | `sb.from('bets').select('*')` | Apostas das linhas 1001-1556 ficavam fora do cálculo → ~36% dos usuários com bets parcialmente lidas → **`user_qualification_scores` incorreto** → pontuação por classificação errada. |
| `recalcKnockoutMatchupsForAllUsers` (linha 104) | `sb.from('bets').select('*')` | Cross-fase de KO scoring (a parte que confere "confronto em outra fase") usava bets truncadas → alguns `bets.points`/`bets.points_with_zebra` ficaram errados. |

**Status anterior à v68**: a pontuação que está no banco hoje em
`bets.points`, `bets.points_with_zebra` e `user_qualification_scores` **pode
estar incorreta** para a parte cross-fase do KO e para a fase de classificação.
Os pontos por placar da fase de grupos (`recalcMatchAndAllBets` quando o
match é grupo) estão OK porque essa função filtra por `match_id` específico
(linha 52 — `.eq('match_id', matchId)` — sem trazer >1000 bets).

### 2. Export CSV em `/admin/apostas`
`/admin/apostas/page.tsx` linha 20: `supabase.from('bets').select('*').limit(10000)`.

O `.limit(10000)` parecia resolver, **mas o PostgREST do Supabase no plano
hosted tem `max-rows = 1000` por default**. Qualquer `.limit(N>1000)` é
truncado para 1000 do mesmo jeito. O `downloadCSV()` em `BetsAdminTable.tsx`
itera as bets que vieram como prop — então o CSV exportava no máximo 1000
linhas mesmo com `.limit(10000)`.

## Arquivos alterados (2)

| Arquivo | Mudança |
|---|---|
| `lib/bolao/recalc.ts` | `recalcKnockoutMatchupsForAllUsers` e `recalcAllQualificationScores` agora usam `fetchAll` (v67) para `bets`, `profiles`, `matches`, `teams`, `fifa_annex_c` e `bracket_overrides`. `recalcBracket` ficou como está — só lê tabelas pequenas (teams=48, matches=104, annex=495 fixo, overrides=admin). `recalcMatchAndAllBets` ficou como está — já filtra por `match_id`. |
| `app/admin/apostas/page.tsx` | Substitui `.limit(10000)` (que era truncado para 1000 pelo `max-rows`) por `fetchAll` em todas as 5 queries. O CSV em `BetsAdminTable.tsx` agora recebe todas as 1.556 bets como prop e exporta tudo. |

**0 migrations**. **Nenhuma alteração em RLS, schema, scoring rules, view
SQL, ranking ou em outros componentes/páginas.**

## Importante: rodar "Recalcular tudo" após aplicar a v68

Como a `recalcAllQualificationScores` estava lendo bets truncadas, os pontos
de classificação no banco hoje **podem estar incorretos**. Para regenerar:

```
1) Aplicar a v68 + v67
2) /admin/configuracao → 🔄 Recalcular tudo
   (executa fullRecalc: recalcMatchAndAllBets de cada match + recalcBracket
    + recalcAllQualificationScores — todos agora paginados)
3) Conferir /ranking e /admin/pontuacao — pontos consistentes.
```

Isso **não altera bets** (scores/advancer/snapshots intactos). Só atualiza
`bets.points`, `bets.points_with_zebra` e regenera `user_qualification_scores`.

## Verificação do impacto real

Para confirmar quantos usuários foram afetados, rode no SQL Editor:

```sql
-- Bets com pontos > 0 cuja fase é KO e o cálculo cross-fase pode ter sumido:
select count(*) as bets_ko_pontuadas,
       count(distinct user_id) as users_afetados
  from public.bets b
  join public.matches m on m.id = b.match_id
 where m.phase not like 'group_stage_%'
   and (b.points > 0 or b.points_with_zebra > 0);

-- UQS rows count (deve crescer após recalcular):
select phase, count(*) as rows
  from public.user_qualification_scores
 group by phase
 order by phase;
```

Depois de rodar "Recalcular tudo" com a v68, esses números devem aumentar
(usuários que estavam "fora dos 1000" passam a ter `user_qualification_scores`).

## Outras superfícies auditadas (não precisavam de fix)

| Local | Status | Por quê |
|---|---|---|
| `recalcMatchAndAllBets` (recalc.ts:52) | OK | `.eq('match_id', matchId)` — ~16 bets por match. |
| `recalcBracket` (recalc.ts:175) | OK | Só lê teams/matches/annex/overrides — todas <1000. |
| `/admin/pontuacao` page | OK | `from('bets').eq('user_id', filterUserId)` — 1 usuário por vez. |
| `/apostas` page | OK | `from('bets').eq('user_id', user.id)` — só do próprio usuário. |
| `/api/recalc` | OK | Só dispara as funções de `recalc.ts` (corrigidas). |
| `app/api/admin/repair-bet-snapshots` | OK | Já usa `fetchAll` desde a v66. |
| `app/api/admin/backfill-bet-snapshots` | Obsoleta | v66 deprecou; ainda existe mas não é usada. |
| `lib/bolao/audit.ts` | OK | Recebe bets/matches como parâmetro (caller decide o universo). |
| `views user_rankings_full`, `user_rankings`, `user_rankings_zebra` | OK | São SQL views agregadas — não passam pelo PostgREST limit. |

## Como rodar e validar (v68 + v67 combinados)

```bash
# 1) Aplicar:
#    - bolao_v67_paginacao_e_cascade_snapshots.zip (já entregue)
#    - bolao_v68_recalc_e_csv_paginacao.zip       (este patch)
# 2) Build e deploy
rm -rf .next && npm run lint && npm run build && deploy

# 3) /admin/configuracao → 🔄 Recalcular tudo (regenera pontos com paginação fix)

# 4) Conferir:
#    - /ranking          → pontos consistentes (alguns users podem subir)
#    - /admin/pontuacao  → coluna "Pts Classific." preenchida pra todos
#    - /admin/apostas    → tabela mostra 1.556 bets; CSV exporta tudo
#    - /comparativo      → mostra todas as bets do match selecionado
#    - /estatisticas     → contagens por fase batem com o SQL

# 5) Smoke do cascade (v67):
#    - Logar como user, mexer placar de grupo
#    - DevTools Network: deve aparecer POST /api/bets/sync-team-snapshots
#    - Banco: bets KO downstream com novos team_ids
```

## Checklist de validação

### Pontuação (v68)
- [ ] `recalcAllQualificationScores` agora processa todas as 1.556 bets (logs do recálculo mostram contagem coerente).
- [ ] `recalcKnockoutMatchupsForAllUsers` idem.
- [ ] Após "Recalcular tudo", `user_qualification_scores` tem linhas para todos os usuários ativos (não só os 1000 primeiros).
- [ ] `bets.points` e `bets.points_with_zebra` corretos para KO cross-fase.
- [ ] `/ranking` mostra usuários que estavam zerados antes.
- [ ] `/admin/pontuacao` mostra "Pts Classific." > 0 para usuários com palpites.

### CSV (v68)
- [ ] `/admin/apostas` mostra 1.556 bets (todas) no contador da tabela.
- [ ] Clicar em "Exportar CSV" gera arquivo com 1.556 linhas (+ header).

### Sem regressão
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.
- [ ] Migrações, RLS, scoring rules, schema, view SQL **inalterados**.
- [ ] Home/hero/favicon/PixCopyBox/TeamNameWithFlag intactos.

## Resumo

- **2 arquivos modificados** (`lib/bolao/recalc.ts`, `app/admin/apostas/page.tsx`).
- **0 arquivos novos**.
- **0 migrations**.
- **Recalcular tudo recomendado** após aplicar (pra regenerar pontos corretamente).
- Cobre o que a v67 deixou de fora: pontuação real (recalc) e CSV (admin/apostas).
