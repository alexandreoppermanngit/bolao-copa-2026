/**
 * POST /api/bets/sync-team-snapshots
 *
 * Sincronização EM LOTE de snapshots de times. Usado pelo BetForm para
 * cascatear a atualização de `bet_home_team_id` / `bet_away_team_id`
 * quando o usuário muda um placar de fase de grupos (que muda os
 * cruzamentos do mata-mata) e os snapshots dos KO downstream ficam
 * desatualizados.
 *
 * NÃO toca em:
 *   - home_score, away_score
 *   - home_pens, away_pens
 *   - knockout_advancer
 *   - points, points_with_zebra
 *
 * Só faz UPDATE nos dois campos de snapshot, e SOMENTE em bets do próprio
 * usuário autenticado (via auth.uid()). Não é admin-only — qualquer
 * usuário logado pode sincronizar os PRÓPRIOS snapshots, que é a operação
 * natural do BetForm.
 *
 * Body:
 *   { updates: [{ match_id, bet_home_team_id, bet_away_team_id }, ...] }
 *
 * Permite valores null em `bet_home_team_id`/`bet_away_team_id` para os
 * casos em que o usuário "desfez" um palpite de grupo e o KO downstream
 * volta a ficar indefinido.
 *
 * Sem lock check: estamos só re-sincronizando o que já está visivelmente
 * no formulário. Bets bloqueados ainda exibem inputs desabilitados, então
 * o BetForm não dispara cascata nesses casos. Para defesa em profundidade,
 * o servidor ainda checa o lock antes de aplicar.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getGlobalLockStatus } from '@/lib/bolao/lockStatus';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({
  updates: z.array(z.object({
    match_id: z.number().int().positive(),
    bet_home_team_id: z.number().int().positive().nullable(),
    bet_away_team_id: z.number().int().positive().nullable(),
  })).max(200),  // cap defensivo — uma cascata real raramente passa de ~30 jogos
});

function jsonError(msg: string, status = 500) {
  return NextResponse.json({ success: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  try {
    // 1) Autenticação
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return jsonError('Não autenticado', 401);

    // 2) Validação do payload
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError('Payload inválido', 400);
    if (parsed.data.updates.length === 0) {
      return NextResponse.json({ success: true, applied: 0 });
    }

    // 3) Lock check global. Se bloqueado, recusa silenciosamente (200 com
    //    applied=0) — não é erro do usuário, é defesa em profundidade.
    const { data: settings } = await supabase
      .from('settings')
      .select('bets_locked, global_bets_deadline')
      .eq('id', 1)
      .maybeSingle();
    const lock = getGlobalLockStatus(settings);
    if (lock.locked) {
      return NextResponse.json({
        success: true, applied: 0, skipped_locked: parsed.data.updates.length,
      });
    }

    // 4) Aplicar via service role (mais simples que múltiplos updates via RLS).
    //    Cada UPDATE é restrito por user_id=user.id + match_id — não é
    //    possível um usuário sincronizar bets de outro.
    const sb = createServiceRoleClient();
    let applied = 0;
    let notFound = 0;
    const errors: string[] = [];

    await Promise.all(parsed.data.updates.map(async (u) => {
      const { data, error } = await sb.from('bets')
        .update({
          bet_home_team_id: u.bet_home_team_id,
          bet_away_team_id: u.bet_away_team_id,
        })
        .eq('user_id', user.id)
        .eq('match_id', u.match_id)
        .select('id');
      if (error) {
        errors.push(`match ${u.match_id}: ${error.message}`);
        return;
      }
      const rows = data ?? [];
      if (rows.length === 0) notFound++;
      else applied += rows.length;
    }));

    // 5) Invalidar páginas dependentes
    try {
      revalidatePath('/apostas');
      revalidatePath('/comparativo');
      revalidatePath('/estatisticas');
    } catch { /* ignore */ }

    return NextResponse.json({
      success: true,
      applied,
      not_found: notFound,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (e) {
    return jsonError((e as Error).message);
  }
}
