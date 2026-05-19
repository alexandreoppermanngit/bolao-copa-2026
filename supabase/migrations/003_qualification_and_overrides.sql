-- =====================================================================
-- MIGRATION 003 — Pontuação de classificados + overrides do bracket
--
-- Quando rodar: depois das migrations 001 e 002 já estarem aplicadas.
-- É idempotente: usa CREATE TABLE IF NOT EXISTS e CREATE OR REPLACE VIEW.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Tabela: overrides manuais de bracket (admin pode forçar classificados)
-- ---------------------------------------------------------------------
create table if not exists public.bracket_overrides (
  id bigserial primary key,
  match_id int not null references public.matches(id) on delete cascade,
  side text not null check (side in ('home','away')),
  team_id int references public.teams(id), -- null = limpar override
  reason text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (match_id, side)
);
create index if not exists bracket_overrides_match_idx on public.bracket_overrides(match_id);

-- ---------------------------------------------------------------------
-- 2) Tabela: pontuação por classificação de seleções (snapshot)
-- Uma linha por (usuário, fase, time_previsto)
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'qualification_phase') then
    create type public.qualification_phase as enum (
      'group_stage',     -- avança da fase de grupos para R32 (32 times)
      'r32',             -- vence R32, avança para R16 (16 times)
      'r16',             -- vence R16, avança para QF (8 times)
      'quarters',        -- vence QF, avança para SF (4 times)
      'semis',           -- vence SF, avança para final (2 finalistas)
      'third_place',     -- ganha disputa de 3º (1 time)
      'champion'         -- ganha a final (1 time)
    );
  end if;
end $$;

create table if not exists public.user_qualification_scores (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  phase public.qualification_phase not null,
  team_id int not null references public.teams(id),
  predicted boolean not null default true,    -- true = usuário previu este time
  is_correct boolean not null default false,  -- true = o time realmente chegou a essa fase
  points_base int not null default 0,
  factor numeric(6,4) not null default 1,     -- (1 + zebra_factor); 1.0 a 2.0
  points_final numeric(8,2) not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, phase, team_id)
);
create index if not exists uqs_user_idx on public.user_qualification_scores(user_id);
create index if not exists uqs_phase_idx on public.user_qualification_scores(phase);
create index if not exists uqs_team_idx on public.user_qualification_scores(team_id);

-- ---------------------------------------------------------------------
-- 3) Extensão da tabela settings com pesos da pontuação de classificados
-- ---------------------------------------------------------------------
do $$ begin
  alter table public.settings add column if not exists pts_qual_groups int not null default 10;
  alter table public.settings add column if not exists pts_qual_r32 int not null default 12;
  alter table public.settings add column if not exists pts_qual_r16 int not null default 15;
  alter table public.settings add column if not exists pts_qual_quarters int not null default 25;
  alter table public.settings add column if not exists pts_qual_semis int not null default 30;
  alter table public.settings add column if not exists pts_qual_third int not null default 30;
  alter table public.settings add column if not exists pts_qual_champion int not null default 40;
end $$;

-- ---------------------------------------------------------------------
-- 4) View: ranking geral combinando jogos + classificados
-- ---------------------------------------------------------------------
create or replace view public.user_rankings_full as
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
  p.email,
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
  rank() over (order by coalesce(b.game_points, 0) + coalesce(q.qualification_points, 0) desc) as position
from public.profiles p
left join bet_pts b on b.user_id = p.id
left join qual_pts q on q.user_id = p.id;

-- Substituir view antiga user_rankings para apontar para a nova
create or replace view public.user_rankings as
select user_id, display_name, email, total_points, games_correct as correct_results,
       exact_scores, total_bets, position
from public.user_rankings_full;

-- ---------------------------------------------------------------------
-- 5) RLS
-- ---------------------------------------------------------------------
alter table public.bracket_overrides enable row level security;
alter table public.user_qualification_scores enable row level security;

drop policy if exists "Public read overrides" on public.bracket_overrides;
create policy "Public read overrides" on public.bracket_overrides for select using (true);

drop policy if exists "Public read qual scores" on public.user_qualification_scores;
create policy "Public read qual scores" on public.user_qualification_scores for select using (true);

-- Apenas service role escreve (não há policies de INSERT/UPDATE/DELETE → ninguém grava via cliente)

-- ---------------------------------------------------------------------
-- 6) Trigger updated_at
-- ---------------------------------------------------------------------
drop trigger if exists set_updated_at_overrides on public.bracket_overrides;
create trigger set_updated_at_overrides before update on public.bracket_overrides
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at_uqs on public.user_qualification_scores;
create trigger set_updated_at_uqs before update on public.user_qualification_scores
  for each row execute function public.set_updated_at();
