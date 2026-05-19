-- =====================================================================
-- MIGRATION 002 — Bandeiras das seleções + índices auxiliares
--
-- Quando rodar: APÓS o 001_schema.sql + os 3 seeds já estarem aplicados.
-- Pode ser rodado várias vezes (idempotente — usa UPDATE).
-- =====================================================================

-- 1) Popular flag_url com URLs do flagcdn.com (CDN gratuito, SVG/PNG)
--    Tamanho w40 (~40px). Componente TeamNameWithFlag faz o resto.
update public.teams set flag_url = 'https://flagcdn.com/w40/mx.png'     where name = 'México';
update public.teams set flag_url = 'https://flagcdn.com/w40/za.png'     where name = 'África do Sul';
update public.teams set flag_url = 'https://flagcdn.com/w40/kr.png'     where name = 'Coreia do Sul';
update public.teams set flag_url = 'https://flagcdn.com/w40/cz.png'     where name = 'Rep. Tcheca';
update public.teams set flag_url = 'https://flagcdn.com/w40/ca.png'     where name = 'Canadá';
update public.teams set flag_url = 'https://flagcdn.com/w40/ba.png'     where name = 'Bósnia';
update public.teams set flag_url = 'https://flagcdn.com/w40/qa.png'     where name = 'Catar';
update public.teams set flag_url = 'https://flagcdn.com/w40/ch.png'     where name = 'Suíça';
update public.teams set flag_url = 'https://flagcdn.com/w40/br.png'     where name = 'Brasil';
update public.teams set flag_url = 'https://flagcdn.com/w40/ma.png'     where name = 'Marrocos';
update public.teams set flag_url = 'https://flagcdn.com/w40/ht.png'     where name = 'Haiti';
update public.teams set flag_url = 'https://flagcdn.com/w40/gb-sct.png' where name = 'Escócia';
update public.teams set flag_url = 'https://flagcdn.com/w40/us.png'     where name = 'Estados Unidos';
update public.teams set flag_url = 'https://flagcdn.com/w40/py.png'     where name = 'Paraguai';
update public.teams set flag_url = 'https://flagcdn.com/w40/au.png'     where name = 'Austrália';
update public.teams set flag_url = 'https://flagcdn.com/w40/tr.png'     where name = 'Turquia';
update public.teams set flag_url = 'https://flagcdn.com/w40/de.png'     where name = 'Alemanha';
update public.teams set flag_url = 'https://flagcdn.com/w40/cw.png'     where name = 'Curaçao';
update public.teams set flag_url = 'https://flagcdn.com/w40/ci.png'     where name = 'Costa do Marfim';
update public.teams set flag_url = 'https://flagcdn.com/w40/ec.png'     where name = 'Equador';
update public.teams set flag_url = 'https://flagcdn.com/w40/nl.png'     where name = 'Holanda';
update public.teams set flag_url = 'https://flagcdn.com/w40/jp.png'     where name = 'Japão';
update public.teams set flag_url = 'https://flagcdn.com/w40/se.png'     where name = 'Suécia';
update public.teams set flag_url = 'https://flagcdn.com/w40/tn.png'     where name = 'Tunísia';
update public.teams set flag_url = 'https://flagcdn.com/w40/be.png'     where name = 'Bélgica';
update public.teams set flag_url = 'https://flagcdn.com/w40/eg.png'     where name = 'Egito';
update public.teams set flag_url = 'https://flagcdn.com/w40/ir.png'     where name = 'Irã';
update public.teams set flag_url = 'https://flagcdn.com/w40/nz.png'     where name = 'Nova Zelândia';
update public.teams set flag_url = 'https://flagcdn.com/w40/es.png'     where name = 'Espanha';
update public.teams set flag_url = 'https://flagcdn.com/w40/cv.png'     where name = 'Cabo Verde';
update public.teams set flag_url = 'https://flagcdn.com/w40/sa.png'     where name = 'Arábia Saudita';
update public.teams set flag_url = 'https://flagcdn.com/w40/uy.png'     where name = 'Uruguai';
update public.teams set flag_url = 'https://flagcdn.com/w40/fr.png'     where name = 'França';
update public.teams set flag_url = 'https://flagcdn.com/w40/sn.png'     where name = 'Senegal';
update public.teams set flag_url = 'https://flagcdn.com/w40/iq.png'     where name = 'Iraque';
update public.teams set flag_url = 'https://flagcdn.com/w40/no.png'     where name = 'Noruega';
update public.teams set flag_url = 'https://flagcdn.com/w40/ar.png'     where name = 'Argentina';
update public.teams set flag_url = 'https://flagcdn.com/w40/dz.png'     where name = 'Argélia';
update public.teams set flag_url = 'https://flagcdn.com/w40/at.png'     where name = 'Áustria';
update public.teams set flag_url = 'https://flagcdn.com/w40/jo.png'     where name = 'Jordânia';
update public.teams set flag_url = 'https://flagcdn.com/w40/pt.png'     where name = 'Portugal';
update public.teams set flag_url = 'https://flagcdn.com/w40/cd.png'     where name = 'RD Congo';
update public.teams set flag_url = 'https://flagcdn.com/w40/uz.png'     where name = 'Uzbequistão';
update public.teams set flag_url = 'https://flagcdn.com/w40/co.png'     where name = 'Colômbia';
update public.teams set flag_url = 'https://flagcdn.com/w40/gb-eng.png' where name = 'Inglaterra';
update public.teams set flag_url = 'https://flagcdn.com/w40/hr.png'     where name = 'Croácia';
update public.teams set flag_url = 'https://flagcdn.com/w40/gh.png'     where name = 'Gana';
update public.teams set flag_url = 'https://flagcdn.com/w40/pa.png'     where name = 'Panamá';

-- 2) Índices auxiliares para acelerar consultas do comparativo e ranking
create index if not exists bets_match_user_idx on public.bets(match_id, user_id);
create index if not exists bets_user_match_idx on public.bets(user_id, match_id);

-- 3) Verificação final
do $$
declare v_count int;
begin
  select count(*) into v_count from public.teams where flag_url is null;
  if v_count > 0 then
    raise warning '% time(s) ainda sem flag_url', v_count;
  else
    raise notice 'Todas as 48 seleções com flag_url ✓';
  end if;
end $$;
