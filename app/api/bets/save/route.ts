/**
 * POST /api/bets/save
 * Salva (upsert) UMA aposta de um usuário logado, COM verificação de bloqueio
 * server-side (settings + match.locked_for_bets/bets_deadline).
 *
 * Substitui o `supabase.from('bets').upsert(...)` direto que o BetForm fazia.
 *
 * Cache:
 *   - `dynamic = 'force-dynamic'` (handler nunca cacheado)
 *   - `revalidatePath('/apostas' | '/comparativo')` invalida o Full Route Cache
 *     server-side. O Router Cache do cliente é invalidado por `router.refresh()`
 *     no BetForm e por `staleTimes.dynamic = 0` no next.config.js.
 *
 * Logs (visíveis em Vercel → Logs):
 *   - { event, user_id, email, match_id, home, away, advancer, ok, error?, ts }
 *   - Não loga tokens, service role keys, nem payloads sensíveis.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getMatchBetLockStatus } from '@/lib/bolao/lockStatus';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({
  match_id: z.number().int().positive(),
  home_score: z.number().int().min(0).max(30),
  away_score: z.number().int().min(0).max(30),
  knockout_advancer: z.enum(['home', 'away']).optional().nullable(),
  // Migration 008: snapshot dos times do palpite. Opcionais por compat
  // com clientes antigos que ainda não enviam. Quando ausentes ou null,
  // o upsert apenas não os define nesta operação — o backfill cuida do
  // resto. Valores recebidos só são aplicados se forem números válidos
  // (>= 1), nunca apagam um snapshot já gravado a partir de cliente
  // que não os envia (ver lógica de upsert abaixo).
  bet_home_team_id: z.number().int().positive().optional().nullable(),
  bet_away_team_id: z.number().int().positive().optional().nullable(),
});

function jsonError(msg: string, status = 500) {
  return NextResponse.json({ success: false, error: msg }, { status });
}

function safeLog(payload: Record<string, unknown>) {
  try {
    // Log único em formato JSON — fácil de filtrar em Vercel.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...payload }));
  } catch { /* ignore */ }
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    // 1) Autenticação (usuário, não admin)
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      safeLog({ event: 'bet_save_unauth' });
      return jsonError('Não autenticado', 401);
    }

    // 2) Validação do payload
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      safeLog({ event: 'bet_save_bad_payload', user_id: user.id, email: user.email });
      return jsonError('Payload inválido', 400);
    }

    // 3) Verificar bloqueio (settings + match)
    const [{ data: settings }, { data: match }] = await Promise.all([
      supabase.from('settings').select('bets_locked, global_bets_deadline').eq('id', 1).maybeSingle(),
      supabase.from('matches').select('locked_for_bets, bets_deadline').eq('id', parsed.data.match_id).maybeSingle(),
    ]);
    const lock = getMatchBetLockStatus(settings, match);
    if (lock.locked) {
      safeLog({
        event: 'bet_save_locked',
        user_id: user.id, email: user.email,
        match_id: parsed.data.match_id, reason: lock.message,
      });
      return jsonError(lock.message, 403);
    }

    // 4) Validação de empate em KO exigir advancer
    if (match) {
      const { data: matchFull } = await supabase
        .from('matches').select('group_code').eq('id', parsed.data.match_id).maybeSingle();
      const isKO = matchFull && matchFull.group_code == null;
      const isTie = parsed.data.home_score === parsed.data.away_score;
      if (isKO && isTie && !parsed.data.knockout_advancer) {
        safeLog({
          event: 'bet_save_ko_tie_no_advancer',
          user_id: user.id, email: user.email,
          match_id: parsed.data.match_id,
          home: parsed.data.home_score, away: parsed.data.away_score,
        });
        return jsonError('Mata-mata empatado exige escolher quem avança nos pênaltis.', 400);
      }
    }

    // 5) Persistir (service role para garantir, mas validação acima já foi feita)
    const sb = createServiceRoleClient();
    // Migration 008: incluir snapshots dos times APENAS quando o cliente
    // os envia explicitamente. Cliente antigo (ou backfill rodando depois)
    // não envia → manter o que já está no banco. Cliente novo (BetForm
    // atualizado) envia o que está vendo no slot naquele momento.
    const upsertRow: Record<string, unknown> = {
      user_id: user.id,
      match_id: parsed.data.match_id,
      home_score: parsed.data.home_score,
      away_score: parsed.data.away_score,
      knockout_advancer: (parsed.data.home_score === parsed.data.away_score)
        ? (parsed.data.knockout_advancer ?? null) : null,
    };
    if (parsed.data.bet_home_team_id !== undefined) {
      upsertRow.bet_home_team_id = parsed.data.bet_home_team_id;
    }
    if (parsed.data.bet_away_team_id !== undefined) {
      upsertRow.bet_away_team_id = parsed.data.bet_away_team_id;
    }
    const { data: saved, error } = await sb.from('bets').upsert(
      upsertRow,
      { onConflict: 'user_id,match_id' },
    ).select('match_id, home_score, away_score, knockout_advancer, bet_home_team_id, bet_away_team_id').single();

    if (error) {
      safeLog({
        event: 'bet_save_error',
        user_id: user.id, email: user.email,
        match_id: parsed.data.match_id,
        home: parsed.data.home_score, away: parsed.data.away_score,
        error: error.message,
        ms: Date.now() - t0,
      });
      return jsonError(`Erro salvando aposta: ${error.message}`);
    }

    // 6) Invalidar Full Route Cache das páginas dependentes
    try {
      revalidatePath('/apostas');
      revalidatePath('/comparativo');
    } catch { /* ignore */ }

    safeLog({
      event: 'bet_save_ok',
      user_id: user.id, email: user.email,
      match_id: parsed.data.match_id,
      home: parsed.data.home_score, away: parsed.data.away_score,
      advancer: saved?.knockout_advancer ?? null,
      ms: Date.now() - t0,
    });

    return NextResponse.json({
      success: true,
      saved: {
        match_id: saved?.match_id ?? parsed.data.match_id,
        home_score: saved?.home_score ?? parsed.data.home_score,
        away_score: saved?.away_score ?? parsed.data.away_score,
        knockout_advancer: saved?.knockout_advancer ?? null,
      },
    });
  } catch (e) {
    safeLog({ event: 'bet_save_exception', error: (e as Error).message, ms: Date.now() - t0 });
    return jsonError((e as Error).message);
  }
}
