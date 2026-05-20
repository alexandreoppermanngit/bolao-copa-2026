-- =====================================================================
-- MIGRATION 004 — permissão intermediária "editor de resultados"
--
-- Adiciona `profiles.can_edit_results boolean`. Usuários com esta flag
-- podem editar APENAS resultados oficiais (e disparar recálculo), SEM
-- acesso a usuários, configurações, pontuação, apostas ou overrides.
--
-- Hierarquia:
--   is_admin = true                  → tudo
--   can_edit_results = true          → só /admin/resultados + APIs de resultado
--   ambos = false                    → usuário comum
--
-- Idempotente: pode ser rodada várias vezes sem erro.
-- =====================================================================

-- 1) Coluna
alter table public.profiles
  add column if not exists can_edit_results boolean not null default false;

create index if not exists profiles_can_edit_results_idx
  on public.profiles (can_edit_results)
  where can_edit_results = true;

-- 2) Manter a coluna sincronizada quando is_admin = true (admin completo
--    naturalmente pode editar resultados — não precisa de flag adicional,
--    mas mantemos can_edit_results visível para auditoria/UI).
--    NOTA: NÃO forçamos can_edit_results=true automaticamente; o helper
--    server-side `requireResultsEditor` aceita is_admin OR can_edit_results.

-- 3) Comentário documental
comment on column public.profiles.can_edit_results is
  'Se true, o usuário pode editar resultados oficiais dos jogos (POST /api/results, /api/results/batch, /api/recalc) e acessar /admin/resultados, mas NÃO outras páginas admin. Não permite reset de placares, edição de usuários, configurações, pontuação, overrides ou apostas. Concedido por admin completo via /admin/usuarios.';

-- 4) Audit log: ações de results editor (registradas a partir das rotas)
--    Já existe a tabela `audit_log` — apenas documentamos as actions novas:
--    - grant_results_editor  (admin concedeu permissão)
--    - revoke_results_editor (admin removeu permissão)
--    - (campos existentes em payload registram alvo + ator)
