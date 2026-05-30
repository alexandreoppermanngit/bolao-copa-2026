# Bolão Copa 2026 — Atualização v63

Corrige 2 problemas na migration 007 antes de aplicar no Supabase:

1. **`ERROR 42601: syntax error at or near "position"`** — `position` é
   palavra reservada do Postgres. Escapado com aspas duplas (`"position"`)
   em todos os locais (declaração no `returns table` e aliases `as "position"`).
2. **Email exposto nas views públicas** — `user_rankings`, `user_rankings_full`
   e `user_rankings_zebra` deixam de retornar email real (`null::text as email`).
   Páginas admin que precisam do email passam a buscar diretamente em
   `public.profiles` (que continua com policy `Public read profiles`).

## Diagnóstico (resumo)

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Onde `position` aparece e como será corrigido | 6 lugares na migration: 2 declarações em `returns table (...)` (funções `compute_user_rankings_full`, `compute_user_rankings_zebra`) e 4 aliases `rank() over (...) as position` + 1 `select position from user_rankings_full`. Todos escapados com `"position"`. |
| 2 | Email usado por página pública? | Sim, em `/ranking` e `/ranking-zebra` apenas como fallback de `display_name`. Trocado por `'Anônimo'`. |
| 3 | Email usado por admin? | Sim em `/admin/pontuacao` (lista + detalhamento). Substituído por query separada em `profiles` + `emailByUserId.get(...)`. |
| 4 | Remove email ou retorna null? | **Retorna null** (opção B). Mantém schema → callers continuam compilando, com tipo `email: string \| null`. |
| 5 | Views/funções ajustadas | `compute_user_rankings_full()`, `compute_user_rankings_zebra()`, `user_rankings_full`, `user_rankings`, `user_rankings_zebra`. |
| 6 | Mudança em TS? | Sim — 3 arquivos: `app/ranking/page.tsx`, `app/ranking-zebra/page.tsx`, `app/admin/pontuacao/page.tsx`. |
| 7 | Idempotência | Mantida (`drop ... if exists` + `create or replace function`). |

## Arquivos alterados (4)

| Arquivo | Mudança |
|---|---|
| `supabase/migrations/007_security_invoker_views.sql` | • Todos os `position` viraram `"position"`.<br>• Views públicas devolvem `null::text as email`.<br>• Comments atualizados. |
| `app/ranking/page.tsx` | • Tipo `email: string \| null`.<br>• Fallback `r.display_name ?? 'Anônimo'`. |
| `app/ranking-zebra/page.tsx` | Idem. |
| `app/admin/pontuacao/page.tsx` | • Query extra `supabase.from('profiles').select('id, email')` em `Promise.all`.<br>• `emailByUserId: Map<string, string>` montado uma vez.<br>• Loop usa `emailByUserId.get(r.user_id) ?? ''` para exibir email. |

## Migration corrigida (resumo do SQL)

```sql
-- supabase/migrations/007_security_invoker_views.sql (v63)
drop view if exists public.user_rankings cascade;
drop view if exists public.user_rankings_full cascade;
drop view if exists public.user_rankings_zebra cascade;
drop view if exists public.match_bet_distribution cascade;
drop view if exists public.group_standings cascade;

create view public.group_standings        with (security_invoker = true) as <query>;
create view public.match_bet_distribution with (security_invoker = true) as <query>;

create or replace function public.compute_user_rankings_full()
returns table (
  user_id uuid, email text, display_name text,
  game_points numeric, game_points_base numeric,
  qualification_points numeric, qualification_points_base numeric,
  total_points numeric,
  games_correct bigint, exact_scores bigint, total_bets bigint,
  qualification_correct bigint,
  "position" bigint                       -- ← ESCAPADO
)
language sql security definer
set search_path = public, pg_temp stable
as $$
  with ... as (...)
  select p.id,
         null::text as email,             -- ← MASCARADO
         p.display_name,
         ...,
         rank() over (order by ... desc) as "position"   -- ← ESCAPADO
  from public.profiles p left join ...
$$;

create view public.user_rankings_full with (security_invoker = true)
  as select * from public.compute_user_rankings_full();

create view public.user_rankings with (security_invoker = true) as
  select user_id, display_name, email, total_points,
         games_correct as correct_results, exact_scores, total_bets,
         "position"                       -- ← ESCAPADO
  from public.user_rankings_full;

create or replace function public.compute_user_rankings_zebra()
returns table (
  user_id uuid, display_name text, email text,
  zebra_bonus numeric, zebra_hits bigint,
  "position" bigint                       -- ← ESCAPADO
)
language sql security definer
set search_path = public, pg_temp stable
as $$
  select p.id, p.display_name,
         null::text as email,             -- ← MASCARADO
         ...,
         rank() over (order by ... desc) as "position"   -- ← ESCAPADO
  ...
$$;

create view public.user_rankings_zebra with (security_invoker = true)
  as select * from public.compute_user_rankings_zebra();
```

Idempotente: pode rodar várias vezes. Não toca em bets, resultados,
usuários, overrides, audit_log nem em RLS.

## Como rodar e validar

```bash
# 1) Aplicar os 4 arquivos do zip
# 2) Abrir Supabase SQL Editor → colar o conteúdo de 007 corrigido → Run
# 3) Smoke tests (no SQL Editor):
select * from public.user_rankings limit 5;
select * from public.user_rankings_full limit 5;
select * from public.user_rankings_zebra limit 5;
select * from public.group_standings limit 5;
select * from public.match_bet_distribution limit 5;
# Esperado: linhas retornadas, `email` sempre NULL nas 3 views de ranking.

# 4) Database → Security Advisor → confirmar que `security_definer_view` sumiu.

# 5) Local
rm -rf .next
npm run dev
# Conferir:
#   /ranking          → tabela popula; "Apostador" mostra display_name (ou "Anônimo")
#   /ranking-zebra    → idem
#   /comparativo      → ordenação por ranking e destaque preservados
#   /estatisticas     → cards preenchidos
#   /admin/pontuacao  → lista mostra email completo (vindo de profiles)

# 6) Lint + build
npm run lint && npm run build
```

## Sobre `profiles.email`

A policy `Public read profiles` (migration 001) permite `select * from profiles`
para qualquer um (`using(true)`) — ou seja, o email **ainda é tecnicamente
público via essa tabela**. A migration 007 **não muda essa policy**. Mas o
SCOPO foi reduzido: nenhuma view pública mais retorna email; o app só busca
email diretamente em profiles na página admin.

Se você quiser também restringir email em `profiles` (sair de "público" para
"só admin + próprio"), isso é uma migration separada — quando quiser, peço
para gerar a 008.

## Checklist de validação

### Migration
- [ ] Migration 007 corrigida roda **sem erro 42601** no SQL Editor.
- [ ] Security Advisor: alerta `security_definer_view` **desapareceu** nas 5 views.
- [ ] `select * from public.user_rankings limit 5` retorna `email = NULL`.
- [ ] `select * from public.user_rankings_full limit 5` retorna `email = NULL`.
- [ ] `select * from public.user_rankings_zebra limit 5` retorna `email = NULL`.
- [ ] `select * from public.group_standings limit 5` funciona.
- [ ] `select * from public.match_bet_distribution limit 5` funciona.

### Rankings
- [ ] `/ranking` mostra display_name (ou 'Anônimo') — ranking populado.
- [ ] `/ranking-zebra` idem.
- [ ] Ordenação correta nas duas (pelo `position` da view).

### Comparativo / estatísticas
- [ ] `/comparativo` mantém ordenação por ranking (linhas em ordem `#1, #2, …`).
- [ ] Destaque visual de cores (v61) preservado.
- [ ] `/estatisticas` mostra todas as fases incluindo Vice.

### Admin
- [ ] `/admin/pontuacao` mostra coluna **Email** completa (vem de profiles).
- [ ] Coluna "Usuário" mostra display_name ou parte do email como fallback.
- [ ] Detalhamento (?user=…) continua exibindo email do usuário focado.
- [ ] Recálculo continua funcionando.

### Privacidade
- [ ] Usuário comum/anon **não vê email** de outros usuários nas páginas
      públicas (`/ranking`, `/ranking-zebra`, `/comparativo`, `/estatisticas`).
- [ ] Admin **continua vendo** email em `/admin/pontuacao`.

### Build
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **1 SQL** corrigido + **3 TS** ajustados.
- **0 migrations novas** (só corrigi a 007 existente).
- **0 alterações em RLS** de bets, profiles, matches, settings, audit_log.
- **0 mudanças** em scoring, recalc, audit, ranking-zebra-logic.
- Email real fica em `profiles` (que admin consulta) — fora das views públicas.
- `position` escapado com `"position"` em 6 lugares.
