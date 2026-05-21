-- =====================================================================
-- MIGRATION 005 — visibilidade ampla de bets quando apostas estão bloqueadas
--
-- Antes: política "User reads own bets" permitia SELECT em public.bets
--        apenas para auth.uid() = user_id OU is_admin = true.
--
-- Depois: a política também permite SELECT para qualquer usuário LOGADO
--         quando as apostas estão globalmente bloqueadas:
--           - settings.bets_locked = true; OU
--           - settings.global_bets_deadline <= now()
--
-- Defesa em profundidade: as páginas /comparativo e /estatisticas também
-- aplicam o gating no servidor (com service role) — esta política é o
-- complemento ao nível de banco, garantindo coerência caso algum cliente
-- consulte bets via cliente autenticado.
--
-- Idempotente: pode ser rodada várias vezes sem erro.
-- =====================================================================

drop policy if exists "User reads own bets" on public.bets;
create policy "User reads own bets" on public.bets for select
  using (
    -- 1) Próprio usuário sempre vê suas apostas
    auth.uid() = user_id
    -- 2) Admin completo vê tudo
    or exists (
      select 1 from public.profiles
      where id = auth.uid() and is_admin = true
    )
    -- 3) Qualquer usuário LOGADO quando apostas estão bloqueadas
    or (
      auth.uid() is not null
      and exists (
        select 1 from public.settings
        where id = 1
          and (
            bets_locked = true
            or (global_bets_deadline is not null and global_bets_deadline <= now())
          )
      )
    )
  );

-- Comentário documental
comment on policy "User reads own bets" on public.bets is
  'SELECT permitido: (a) próprio usuário; (b) admin; (c) qualquer logado quando apostas bloqueadas (settings.bets_locked OR global_bets_deadline <= now()).';
