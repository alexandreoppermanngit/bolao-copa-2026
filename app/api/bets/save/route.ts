/**
 * POST /api/bets/save
 * Salva (upsert) UMA aposta de um usuário logado, COM verificação de bloqueio
 * server-side (settings + match.locked_for_bets/bets_deadline).
 *
 * Substitui o `supabase.from('bets').upsert(...)` direto que o BetForm fazia.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getMatchBetLockStatus } from '@/lib/bolao/lockStatus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({
  match_id: z.number().int().positive(),
  home_score: z.number().int().min(0).max(30),
  away_score: z.number().int().min(0).max(30),
  knockout_advancer: z.enum(['home', 'away']).optional().nullable(),
});

function jsonError(msg: string, status = 500) {
  return NextResponse.json({ success: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  try {
    // 1) Autenticação (usuário, não admin)
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return jsonError('Não autenticado', 401);

    // 2) Validação do payload
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError('Payload inválido', 400);

    // 3) Verificar bloqueio (settings + match)
    const [{ data: settings }, { data: match }] = await Promise.all([
      supabase.from('settings').select('bets_locked, global_bets_deadline').eq('id', 1).maybeSingle(),
      supabase.from('matches').select('locked_for_bets, bets_deadline').eq('id', parsed.data.match_id).maybeSingle(),
    ]);
    const lock = getMatchBetLockStatus(settings, match);
    if (lock.locked) return jsonError(lock.message, 403);

    // 4) Validação de empate em KO exigir advancer
    if (match) {
      const { data: matchFull } = await supabase
        .from('matches').select('group_code').eq('id', parsed.data.match_id).maybeSingle();
      const isKO = matchFull && matchFull.group_code == null;
      const isTie = parsed.data.home_score === parsed.data.away_score;
      if (isKO && isTie && !parsed.data.knockout_advancer) {
        return jsonError('Mata-mata empatado exige escolher quem avança nos pênaltis.', 400);
      }
    }

    // 5) Persistir (service role para garantir, mas validação acima já foi feita)
    const sb = createServiceRoleClient();
    const { error } = await sb.from('bets').upsert({
      user_id: user.id,
      match_id: parsed.data.match_id,
      home_score: parsed.data.home_score,
      away_score: parsed.data.away_score,
      knockout_advancer: (parsed.data.home_score === parsed.data.away_score)
        ? (parsed.data.knockout_advancer ?? null) : null,
    }, { onConflict: 'user_id,match_id' });
    if (error) return jsonError(`Erro salvando aposta: ${error.message}`);

    return NextResponse.json({ success: true });
  } catch (e) {
    return jsonError((e as Error).message);
  }
}
