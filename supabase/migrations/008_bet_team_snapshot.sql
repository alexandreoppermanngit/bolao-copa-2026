-- =====================================================================
-- MIGRATION 008 — snapshot dos times apostados em cada bet (KO + grupos)
--
-- Motivação:
--   Hoje `public.bets` guarda apenas (home_score, away_score, knockout_advancer).
--   Os TIMES que o usuário escolheu em cada jogo de mata-mata eram
--   derivados via simulação reversa a partir dos palpites de fase de
--   grupos. Quando `recalcBracket()` zera os `home_team_id`/`away_team_id`
--   oficiais dos KO (acontece quando placares de grupo são apagados),
--   e/ou quando o usuário tem palpites parciais de grupos, a simulação
--   aborta e os times "somem" no /comparativo e /estatisticas.
--
--   As apostas NUNCA são perdidas (placares + advancer ficam), mas a
--   VISUALIZAÇÃO dos times depende dessa simulação frágil.
--
--   Esta migration adiciona DUAS colunas nullable em `bets`:
--     - bet_home_team_id : id do time que estava no slot "home" no momento da aposta
--     - bet_away_team_id : id do time que estava no slot "away" no momento da aposta
--
--   A partir daqui:
--     - /api/bets/save preenche os dois snapshots a cada save (BetForm
--       envia teamForMatchSide(m, 'home/away').id).
--     - /comparativo, /admin/apostas, /admin/pontuacao e /estatisticas
--       passam a LER esses campos com prioridade sobre simulação.
--     - recalc.ts/reset NUNCA tocam nesses campos (eles só fazem UPDATE
--       em points/points_with_zebra). Verificado.
--
-- Garantias:
--   - Idempotente (`add column if not exists`).
--   - NULL-able — bets antigas não quebram.
--   - Sem GRANT novo: a tabela `bets` já tem RLS configurada para
--     usuário ler/editar próprios + admin ler todos. Os novos campos
--     herdam essa policy.
--
-- Backfill:
--   Rodar APÓS aplicar esta migration. Rota dedicada:
--     POST /api/admin/backfill-bet-snapshots
--   (autenticada com cookie de admin). Ver `app/api/admin/backfill-bet-snapshots/route.ts`.
--   A rota não sobrescreve snapshots já preenchidos a menos que receba
--   `?force=true`.
-- =====================================================================

alter table public.bets
  add column if not exists bet_home_team_id int references public.teams(id),
  add column if not exists bet_away_team_id int references public.teams(id);

comment on column public.bets.bet_home_team_id is
  'Snapshot do time que estava no slot HOME do jogo no momento da aposta. Usado por /comparativo, /admin/apostas, /admin/pontuacao e /estatisticas como fonte primária — elimina dependência de simulação reversa quando o bracket oficial é resetado. Nullable: bets antigas pré-migration 008 podem ter null até o backfill rodar.';

comment on column public.bets.bet_away_team_id is
  'Snapshot do time que estava no slot AWAY do jogo no momento da aposta. Ver comentário em bet_home_team_id.';

-- Índices: usados em joins/lookups quando o app exibe nome do time apostado.
create index if not exists idx_bets_bet_home_team_id on public.bets(bet_home_team_id);
create index if not exists idx_bets_bet_away_team_id on public.bets(bet_away_team_id);

-- =====================================================================
-- Smoke tests (rodar logo após apply no SQL Editor):
--
--   -- 1) Estrutura criada:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'bets'
--      and column_name in ('bet_home_team_id','bet_away_team_id');
--
--   -- 2) Apostas existentes preservadas (todos os campos antigos intactos):
--   select count(*) as total_bets,
--          count(home_score) as com_home_score,
--          count(away_score) as com_away_score,
--          count(knockout_advancer) as com_advancer,
--          count(bet_home_team_id) as com_snapshot_home,
--          count(bet_away_team_id) as com_snapshot_away
--     from public.bets;
--   -- Esperado: total_bets == com_home_score == com_away_score (preservados).
--   --           com_snapshot_* == 0 antes do backfill, > 0 depois.
-- =====================================================================
