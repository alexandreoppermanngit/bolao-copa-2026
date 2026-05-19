-- =====================================================================
-- BOLÃO COPA DO MUNDO FIFA 2026 — SCHEMA POSTGRES (SUPABASE)
-- Execute este arquivo no SQL Editor do Supabase ANTES dos seeds.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) USUÁRIOS (profile estendendo auth.users do Supabase)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text,
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Trigger para criar profile automaticamente quando user se cadastra
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean := false;
begin
  -- Lista de admins lida via variável de ambiente; aqui só marcamos o seu
  if new.email = 'alexandre.oppermann@gmail.com' then
    v_is_admin := true;
  end if;
  insert into public.profiles (id, email, display_name, avatar_url, is_admin)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', new.email),
    new.raw_user_meta_data->>'avatar_url',
    v_is_admin
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 2) GRUPOS E SELEÇÕES
-- ---------------------------------------------------------------------
create table if not exists public.groups (
  code text primary key check (code ~ '^[A-L]$'),
  display_order int not null
);

create table if not exists public.teams (
  id serial primary key,
  name text not null unique,
  group_code text not null references public.groups(code),
  flag_url text,
  fifa_ranking int,
  created_at timestamptz not null default now()
);
create index if not exists teams_group_idx on public.teams(group_code);

-- ---------------------------------------------------------------------
-- 3) JOGOS (104 partidas: 72 grupos + 32 mata-mata)
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'match_phase') then
    create type public.match_phase as enum (
      'group_stage_1', 'group_stage_2', 'group_stage_3',
      'round_of_32', 'round_of_16', 'quarter_finals',
      'semi_finals', 'third_place', 'final'
    );
  end if;
end $$;

create table if not exists public.matches (
  id int primary key,                       -- 1..104 (FIFA numbering)
  phase public.match_phase not null,
  group_code text references public.groups(code),  -- só para fase de grupos
  match_date date not null,
  kickoff_brt time not null,                -- horário Brasília
  venue text,
  home_team_id int references public.teams(id),
  away_team_id int references public.teams(id),
  -- Para mata-mata: referências simbólicas (ex: "2A", "1E", "3rd_pos_1A", "winner_M77")
  home_placeholder text,
  away_placeholder text,
  home_score int,
  away_score int,
  -- Para mata-mata: pênaltis quando empata
  home_pens int,
  away_pens int,
  -- Calculado pelo backend após resultado: 'home' | 'away' | 'draw' | null
  result_code text,
  locked_for_bets boolean not null default false,
  bets_deadline timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists matches_phase_idx on public.matches(phase);
create index if not exists matches_date_idx on public.matches(match_date, kickoff_brt);

-- ---------------------------------------------------------------------
-- 4) APOSTAS DOS USUÁRIOS
-- ---------------------------------------------------------------------
create table if not exists public.bets (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  match_id int not null references public.matches(id) on delete cascade,
  home_score int not null check (home_score between 0 and 30),
  away_score int not null check (away_score between 0 and 30),
  -- Para mata-mata, palpite de quem avança em caso de empate (penal)
  knockout_advancer text check (knockout_advancer in ('home','away')),
  points int not null default 0,            -- pontos brutos (sem multiplicador zebra)
  points_with_zebra numeric(8,2) not null default 0, -- pontos finais
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, match_id)               -- aposta única por usuário/jogo
);
create index if not exists bets_user_idx on public.bets(user_id);
create index if not exists bets_match_idx on public.bets(match_id);

-- ---------------------------------------------------------------------
-- 5) ANEXO C FIFA — 495 combinações dos 8 melhores 3ºs colocados
-- ---------------------------------------------------------------------
create table if not exists public.fifa_annex_c (
  option_number int primary key,            -- 1..495
  sorted_key text not null unique,          -- 8 letras ordenadas, ex: "BCEGHIJL"
  -- Para cada uma das 8 posições (1A,1B,1D,1E,1G,1I,1K,1L), qual grupo cede seu 3º
  pos_1a char(1) not null,
  pos_1b char(1) not null,
  pos_1d char(1) not null,
  pos_1e char(1) not null,
  pos_1g char(1) not null,
  pos_1i char(1) not null,
  pos_1k char(1) not null,
  pos_1l char(1) not null
);
create index if not exists fifa_annex_c_key_idx on public.fifa_annex_c(sorted_key);

-- ---------------------------------------------------------------------
-- 6) CONFIGURAÇÃO GLOBAL (singleton via id=1)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  global_bets_deadline timestamptz,         -- prazo global; matches têm prazo individual também
  bets_locked boolean not null default false,
  -- Pontuação configurável (defaults conforme Excel original)
  pts_correct_result int not null default 5,
  pts_correct_home int not null default 2,
  pts_correct_away int not null default 2,
  pts_correct_diff int not null default 1,
  zebra_threshold_easy numeric not null default 0.35, -- > 35%: mult 1
  zebra_threshold_mid numeric not null default 0.20,  -- 20-35%: 1.5; <=20%: 2
  zebra_mult_easy numeric not null default 1.0,
  zebra_mult_mid numeric not null default 1.5,
  zebra_mult_hard numeric not null default 2.0,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 7) LOGS de auditoria (admin actions, recalcs, API syncs)
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id bigserial primary key,
  actor_id uuid references public.profiles(id),
  actor_email text,
  action text not null,                     -- ex: 'update_result', 'recalc_rankings', 'lock_bets'
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_action_idx on public.audit_log(action);
create index if not exists audit_log_created_idx on public.audit_log(created_at desc);

-- =====================================================================
-- VIEWS DERIVADAS
-- =====================================================================

-- Classificação dos grupos (calculada dinamicamente)
create or replace view public.group_standings as
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

-- Ranking geral de usuários (soma dos pontos)
create or replace view public.user_rankings as
select
  p.id as user_id,
  p.display_name,
  p.email,
  coalesce(sum(b.points_with_zebra), 0)::numeric as total_points,
  count(b.id) filter (where b.points > 0) as correct_results,
  count(b.id) filter (where b.points >= 9) as exact_scores,
  count(b.id) as total_bets,
  rank() over (order by coalesce(sum(b.points_with_zebra),0) desc) as position
from public.profiles p
left join public.bets b on b.user_id = p.id
left join public.matches m on m.id = b.match_id
  and m.home_score is not null and m.away_score is not null
group by p.id, p.display_name, p.email;

-- Ranking zebra (apenas pontos extras vindos do multiplicador zebra > 1)
create or replace view public.user_rankings_zebra as
select
  p.id as user_id,
  p.display_name,
  p.email,
  coalesce(sum(b.points_with_zebra - b.points), 0)::numeric as zebra_bonus,
  count(b.id) filter (where b.points_with_zebra > b.points) as zebra_hits,
  rank() over (order by coalesce(sum(b.points_with_zebra - b.points),0) desc) as position
from public.profiles p
left join public.bets b on b.user_id = p.id
left join public.matches m on m.id = b.match_id
  and m.home_score is not null and m.away_score is not null
group by p.id, p.display_name, p.email;

-- Distribuição de apostas por jogo
create or replace view public.match_bet_distribution as
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

-- =====================================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.bets enable row level security;
alter table public.matches enable row level security;
alter table public.groups enable row level security;
alter table public.teams enable row level security;
alter table public.fifa_annex_c enable row level security;
alter table public.settings enable row level security;
alter table public.audit_log enable row level security;

-- Policies: leitura pública (DROP+CREATE para ser idempotente)
drop policy if exists "Public read groups" on public.groups;
create policy "Public read groups" on public.groups for select using (true);

drop policy if exists "Public read teams" on public.teams;
create policy "Public read teams"  on public.teams  for select using (true);

drop policy if exists "Public read matches" on public.matches;
create policy "Public read matches" on public.matches for select using (true);

drop policy if exists "Public read fifa_annex_c" on public.fifa_annex_c;
create policy "Public read fifa_annex_c" on public.fifa_annex_c for select using (true);

drop policy if exists "Public read settings" on public.settings;
create policy "Public read settings" on public.settings for select using (true);

-- Profiles: leitura pública (mostrar nomes no ranking)
drop policy if exists "Public read profiles" on public.profiles;
create policy "Public read profiles" on public.profiles for select using (true);

drop policy if exists "User updates own profile" on public.profiles;
create policy "User updates own profile" on public.profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);

-- Bets: usuário só vê e edita as próprias; admins veem tudo
drop policy if exists "User reads own bets" on public.bets;
create policy "User reads own bets" on public.bets for select
  using (auth.uid() = user_id or exists (
    select 1 from public.profiles where id = auth.uid() and is_admin = true));

drop policy if exists "User inserts own bets" on public.bets;
create policy "User inserts own bets" on public.bets for insert
  with check (auth.uid() = user_id);

drop policy if exists "User updates own bets" on public.bets;
create policy "User updates own bets" on public.bets for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Admins delete bets" on public.bets;
create policy "Admins delete bets" on public.bets for delete
  using (exists (select 1 from public.profiles where id = auth.uid() and is_admin = true));

-- Audit log: somente admins
drop policy if exists "Admins read audit" on public.audit_log;
create policy "Admins read audit" on public.audit_log for select
  using (exists (select 1 from public.profiles where id = auth.uid() and is_admin = true));

drop policy if exists "Admins insert audit" on public.audit_log;
create policy "Admins insert audit" on public.audit_log for insert
  with check (exists (select 1 from public.profiles where id = auth.uid() and is_admin = true));

-- Matches: somente admins editam (writes via service role na API)
-- (sem policy de UPDATE = ninguém atualiza via cliente; rotas usam service role)

-- =====================================================================
-- FUNÇÕES UTILITÁRIAS
-- =====================================================================

-- Trigger para atualizar updated_at automaticamente
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists set_updated_at_profiles on public.profiles;
create trigger set_updated_at_profiles before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at_bets on public.bets;
create trigger set_updated_at_bets before update on public.bets
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at_matches on public.matches;
create trigger set_updated_at_matches before update on public.matches
  for each row execute function public.set_updated_at();

-- Função: verificar se usuário é admin
create or replace function public.is_admin()
returns boolean language sql security definer stable as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;
