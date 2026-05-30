-- =====================================================================
-- MIGRATION 007 — security_invoker nas views (Supabase Advisor fix)
--
-- Versão corrigida v63 — duas mudanças desde a primeira tentativa:
--   (a) `position` é palavra reservada em Postgres. Escapamos com aspas
--       duplas (`"position"`) em todos os lugares — declarações de tipo no
--       returns table e aliases nos `rank() over (...) as "position"`.
--   (b) Mascaramos `email` nas views públicas com `null::text as email`.
--       O schema fica idêntico (callers TS continuam compilando), mas
--       o email real nunca sai dessas views — RLS de `profiles` ainda
--       é a fonte para páginas que precisem do email (ex.: /admin/pontuacao).
--
-- Alerta original do Supabase Security Advisor: `security_definer_view` em
--   - public.group_standings
--   - public.user_rankings
--   - public.match_bet_distribution
--   - public.user_rankings_full
--   - public.user_rankings_zebra
--
-- Estratégia:
--   - Views que SÓ leem tabelas com leitura pública (group_standings,
--     match_bet_distribution) recebem `security_invoker = true` direto.
--   - Views de ranking (user_rankings_full, user_rankings, user_rankings_zebra)
--     viram wrappers de FUNÇÕES `SECURITY DEFINER` com `search_path` fixo
--     (auditáveis, não disparam `security_definer_view`). Só agregados saem
--     dessas funções; linhas individuais de `bets` continuam protegidas.
--
-- Idempotente. Não altera dados. Não apaga tabelas. Não toca em
-- bets/resultados/usuários/overrides/audit_log nem em RLS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0) Dropar views existentes (em ordem reversa de dependência)
-- ---------------------------------------------------------------------
drop view if exists public.user_rankings cascade;
drop view if exists public.user_rankings_full cascade;
drop view if exists public.user_rankings_zebra cascade;
drop view if exists public.match_bet_distribution cascade;
drop view if exists public.group_standings cascade;

-- ---------------------------------------------------------------------
-- 1) group_standings — só lê teams + matches (ambas com policy pública).
-- ---------------------------------------------------------------------
create view public.group_standings
with (security_invoker = true)
as
with team_results as (
  select
    t.id as team_id, t.name as team_name, t.group_code,
    m.id as match_id,
    case when m.home_team_id = t.id then m.home_score else m.away_score end as goals_for,
    case when m.home_team_id = t.id then m.away_score else m.home_score end as goals_against,
    case
      when m.home_score is null or m.away_score is null then null
      when (m.home_team_id = t.id and m.home_score > m.away_score)
        or (m.away_team_id = t.id and m.away_score > m.home_score) then 'W'
      when m.home_score = m.away_score then 'D'
      else 'L'
    end as outcome
  from public.teams t
  join public.matches m on (m.home_team_id = t.id or m.away_team_id = t.id)
  where m.phase in ('group_stage_1','group_stage_2','group_stage_3')
)
select
  team_id, team_name, group_code,
  count(outcome) filter (where outcome is not null) as played,
  count(outcome) filter (where outcome = 'W') as wins,
  count(outcome) filter (where outcome = 'D') as draws,
  count(outcome) filter (where outcome = 'L') as losses,
  coalesce(sum(goals_for) filter (where outcome is not null),0)::int as goals_for,
  coalesce(sum(goals_against) filter (where outcome is not null),0)::int as goals_against,
  coalesce(sum(goals_for) filter (where outcome is not null),0)::int -
    coalesce(sum(goals_against) filter (where outcome is not null),0)::int as goal_diff,
  count(outcome) filter (where outcome = 'W') * 3 + count(outcome) filter (where outcome = 'D') as points
from team_results
group by team_id, team_name, group_code;

-- ---------------------------------------------------------------------
-- 2) match_bet_distribution — não é usada pelo app hoje.
-- ---------------------------------------------------------------------
create view public.match_bet_distribution
with (security_invoker = true)
as
select
  m.id as match_id,
  count(b.id) as total_bets,
  count(b.id) filter (where b.home_score > b.away_score) as home_wins,
  count(b.id) filter (where b.home_score = b.away_score) as draws,
  count(b.id) filter (where b.away_score > b.home_score) as away_wins,
  case when count(b.id) > 0 then
    count(b.id) filter (where b.home_score > b.away_score)::numeric / count(b.id) else 0 end as pct_home,
  case when count(b.id) > 0 then
    count(b.id) filter (where b.home_score = b.away_score)::numeric / count(b.id) else 0 end as pct_draw,
  case when count(b.id) > 0 then
    count(b.id) filter (where b.away_score > b.home_score)::numeric / count(b.id) else 0 end as pct_away
from public.matches m
left join public.bets b on b.match_id = m.id
group by m.id;

-- ---------------------------------------------------------------------
-- 3) FUNÇÃO compute_user_rankings_full() — SECURITY DEFINER auditada.
--    NOTA: "position" entre aspas duplas porque é palavra reservada do PG.
-- ---------------------------------------------------------------------
create or replace function public.compute_user_rankings_full()
returns table (
  user_id uuid,
  email text,
  display_name text,
  game_points numeric,
  game_points_base numeric,
  qualification_points numeric,
  qualification_points_base numeric,
  total_points numeric,
  games_correct bigint,
  exact_scores bigint,
  total_bets bigint,
  qualification_correct bigint,
  "position" bigint
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  with bet_pts as (
    select b.user_id,
           coalesce(sum(b.points_with_zebra), 0)::numeric as game_points,
           coalesce(sum(b.points), 0)::numeric as game_points_base,
           count(b.id) filter (where b.points > 0) as games_correct,
           count(b.id) filter (where b.points >= 9) as exact_scores,
           count(b.id) as total_bets
    from public.bets b
    join public.matches m on m.id = b.match_id
    where m.home_score is not null and m.away_score is not null
    group by b.user_id
  ),
  qual_pts as (
    select user_id,
           coalesce(sum(points_final), 0)::numeric as qualification_points,
           coalesce(sum(points_base), 0)::numeric as qualification_points_base,
           count(*) filter (where is_correct) as qualification_correct
    from public.user_qualification_scores
    group by user_id
  )
  select
    p.id as user_id,
    -- Mascarado: NÃO expor email via view pública. Páginas admin que
    -- precisem do email devem buscar em `public.profiles` separadamente.
    null::text as email,
    p.display_name,
    coalesce(b.game_points, 0)::numeric as game_points,
    coalesce(b.game_points_base, 0)::numeric as game_points_base,
    coalesce(q.qualification_points, 0)::numeric as qualification_points,
    coalesce(q.qualification_points_base, 0)::numeric as qualification_points_base,
    coalesce(b.game_points, 0) + coalesce(q.qualification_points, 0) as total_points,
    coalesce(b.games_correct, 0) as games_correct,
    coalesce(b.exact_scores, 0) as exact_scores,
    coalesce(b.total_bets, 0) as total_bets,
    coalesce(q.qualification_correct, 0) as qualification_correct,
    rank() over (order by coalesce(b.game_points, 0) + coalesce(q.qualification_points, 0) desc) as "position"
  from public.profiles p
  left join bet_pts b on b.user_id = p.id
  left join qual_pts q on q.user_id = p.id
$$;

revoke all on function public.compute_user_rankings_full() from public;
grant execute on function public.compute_user_rankings_full() to anon, authenticated, service_role;

comment on function public.compute_user_rankings_full() is
  'Ranking geral (jogos + classificação). SECURITY DEFINER para bypass controlado da RLS de bets — só expõe agregados por usuário. Email mascarado como null.';

-- ---------------------------------------------------------------------
-- 4) View user_rankings_full — wrapper SECURITY INVOKER da função
-- ---------------------------------------------------------------------
create view public.user_rankings_full
with (security_invoker = true)
as select * from public.compute_user_rankings_full();

grant select on public.user_rankings_full to anon, authenticated;

comment on view public.user_rankings_full is
  'View pública do ranking geral. security_invoker = true; agregação via compute_user_rankings_full() (DEFINER). Email sempre null nesta view — buscar em profiles se precisar.';

-- ---------------------------------------------------------------------
-- 5) View user_rankings — wrapper compacto com a mesma forma de antes
-- ---------------------------------------------------------------------
create view public.user_rankings
with (security_invoker = true)
as
select
  user_id,
  display_name,
  email,                          -- já vem null do user_rankings_full
  total_points,
  games_correct as correct_results,
  exact_scores,
  total_bets,
  "position"
from public.user_rankings_full;

grant select on public.user_rankings to anon, authenticated;

comment on view public.user_rankings is
  'Subset de user_rankings_full para a tela /ranking. Email sempre null.';

-- ---------------------------------------------------------------------
-- 6) FUNÇÃO compute_user_rankings_zebra() — SECURITY DEFINER
-- ---------------------------------------------------------------------
create or replace function public.compute_user_rankings_zebra()
returns table (
  user_id uuid,
  display_name text,
  email text,
  zebra_bonus numeric,
  zebra_hits bigint,
  "position" bigint
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    p.id as user_id,
    p.display_name,
    -- Mascarado: ver comentário em compute_user_rankings_full().
    null::text as email,
    coalesce(sum(b.points_with_zebra - b.points), 0)::numeric as zebra_bonus,
    count(b.id) filter (where b.points_with_zebra > b.points) as zebra_hits,
    rank() over (order by coalesce(sum(b.points_with_zebra - b.points),0) desc) as "position"
  from public.profiles p
  left join public.bets b on b.user_id = p.id
  left join public.matches m on m.id = b.match_id
    and m.home_score is not null and m.away_score is not null
  group by p.id, p.display_name
$$;

revoke all on function public.compute_user_rankings_zebra() from public;
grant execute on function public.compute_user_rankings_zebra() to anon, authenticated, service_role;

comment on function public.compute_user_rankings_zebra() is
  'Ranking zebra (bônus do multiplicador). SECURITY DEFINER — só expõe agregados. Email mascarado.';

-- ---------------------------------------------------------------------
-- 7) View user_rankings_zebra — wrapper SECURITY INVOKER
-- ---------------------------------------------------------------------
create view public.user_rankings_zebra
with (security_invoker = true)
as select * from public.compute_user_rankings_zebra();

grant select on public.user_rankings_zebra to anon, authenticated;

comment on view public.user_rankings_zebra is
  'View pública do ranking zebra. security_invoker = true; agregação via compute_user_rankings_zebra() (DEFINER). Email sempre null.';

-- ---------------------------------------------------------------------
-- 8) GRANTs explícitos nas views sem função (defesa em profundidade)
-- ---------------------------------------------------------------------
grant select on public.group_standings        to anon, authenticated;
grant select on public.match_bet_distribution to anon, authenticated;

-- =====================================================================
-- Smoke tests (rodar logo após apply, no SQL Editor):
--   select * from public.user_rankings limit 5;
--   select * from public.user_rankings_full limit 5;
--   select * from public.user_rankings_zebra limit 5;
--   select * from public.group_standings limit 5;
--   select * from public.match_bet_distribution limit 5;
--
-- Esperado em todas: dados agregados retornam corretamente.
-- Esperado nas 3 de ranking: coluna `email` sempre NULL.
-- =====================================================================
