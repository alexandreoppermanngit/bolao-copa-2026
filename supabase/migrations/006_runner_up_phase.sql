-- =====================================================================
-- MIGRATION 006 — fase "runner_up" (vice-campeão) pontuando + pesos
--
-- Objetivos:
--   1) Adicionar o valor 'runner_up' ao enum `qualification_phase`.
--   2) Adicionar a coluna `pts_qual_runner_up int` na tabela `settings`
--      (default 30 pts), permitindo edição via admin.
--   3) Atualizar a linha de settings (id=1) com os pesos oficiais
--      atualizados — incluindo o vice (30 pts).
--
-- Garantias:
--   - Idempotente: pode rodar várias vezes sem erro.
--   - NÃO apaga bets, resultados, usuários, overrides ou audit_log.
--   - NÃO mexe em RLS nem nas migrations anteriores.
--   - Manter Admin UI editável: a coluna nova entra no SELECT * que o
--     SettingsForm já faz, e o salvar via /api/settings persiste o valor.
--   - Após rodar, o admin precisa clicar em "🔄 Recalcular tudo" para
--     regerar as linhas em user_qualification_scores incluindo a fase
--     'runner_up'. Antes disso, o vice aparece com 0 pts no ranking.
--
-- IMPORTANTE — Se o admin já tiver editado pontos por fase com valores
-- customizados (diferentes dos defaults originais), o UPDATE abaixo
-- SOBRESCREVE para os valores oficiais novos (10/12/15/25/30/30/30/40).
-- Caso queira preservar valores custom, comentar o bloco UPDATE.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Enum: adicionar 'runner_up'
-- ---------------------------------------------------------------------
-- `IF NOT EXISTS` é suportado em ALTER TYPE ADD VALUE a partir do PG 9.6.
-- Posiciona logo após 'champion' (ordem dentro do enum não afeta
-- semântica, mas mantém vice e campeão "juntos" no listing default).
alter type public.qualification_phase
  add value if not exists 'runner_up' after 'champion';

-- ---------------------------------------------------------------------
-- 2) Coluna: settings.pts_qual_runner_up
-- ---------------------------------------------------------------------
alter table public.settings
  add column if not exists pts_qual_runner_up int not null default 30;

comment on column public.settings.pts_qual_runner_up is
  'Pontos base por acertar o vice-campeão (perdedor da final). Aplicado com fator zebra de classificação, como nas demais fases.';

-- ---------------------------------------------------------------------
-- 3) UPDATE: pesos oficiais da nova regra
--    (linha id=1 — única linha de settings)
-- ---------------------------------------------------------------------
update public.settings set
  pts_qual_groups    = 10,
  pts_qual_r32       = 12,
  pts_qual_r16       = 15,
  pts_qual_quarters  = 25,
  pts_qual_semis     = 30,
  pts_qual_third     = 30,
  pts_qual_runner_up = 30,
  pts_qual_champion  = 40
where id = 1;

-- ---------------------------------------------------------------------
-- Pronto. Próximo passo (manual, pelo admin):
--   1. Confirmar que /admin/configuracao mostra o novo campo "Vice-campeão".
--   2. Clicar em "🔄 Recalcular tudo" para regerar user_qualification_scores
--      com a nova fase 'runner_up'.
-- =====================================================================
