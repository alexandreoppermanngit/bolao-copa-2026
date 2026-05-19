/**
 * POST /api/results/reset
 * Apaga TODOS os placares oficiais + zera pontos das bets + apaga qualification scores.
 *
 * Preserva: apostas (D/E/advancer), usuários, grupos, times, overrides, settings.
 *
 * Exige body: { confirm: 'RESET_ALL_RESULTS' } para evitar acidente.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient, requireAdmin } from '@/lib/supabase/server';
import { resetAllResults } from '@/lib/bolao/recalc';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({ confirm: z.literal('RESET_ALL_RESULTS') });

function jsonError(msg: string, status = 500) {
  return NextResponse.json({ success: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const { isAdmin, user } = await requireAdmin();
    if (!isAdmin) return jsonError('Não autorizado', 403);

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonError('Confirmação obrigatória: { confirm: "RESET_ALL_RESULTS" }', 400);
    }

    const sb = createServiceRoleClient();
    await resetAllResults();

    await sb.from('audit_log').insert({
      actor_id: user?.id, actor_email: user?.email,
      action: 'reset_all_results',
      payload: { at: new Date().toISOString() },
    });

    revalidatePath('/ranking'); revalidatePath('/ranking-zebra');
    revalidatePath('/comparativo'); revalidatePath('/estatisticas');
    revalidatePath('/admin/resultados'); revalidatePath('/admin/apostas');
    revalidatePath('/admin/pontuacao'); revalidatePath('/apostas');

    return NextResponse.json({
      success: true,
      message: 'Todos os placares foram apagados. Apostas e usuários preservados.',
    });
  } catch (e) {
    return jsonError(`Erro: ${(e as Error).message}`, 500);
  }
}
