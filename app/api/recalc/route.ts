/**
 * POST /api/recalc
 * Recálculo completo: percorre todos os jogos com placar, recalcula apostas
 * e cruzamentos do mata-mata, invalida caches.
 *
 * Permissão: admin OU header Authorization: Bearer ${CRON_SECRET}.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireResultsEditor } from '@/lib/bolao/permissions';
import { fullRecalc, recalcBracket } from '@/lib/bolao/recalc';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function jsonError(message: string, status = 500, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { success: false, error: message, ...(extra ?? {}) },
    { status }
  );
}

export async function POST(req: NextRequest) {
  try {
    const auth = req.headers.get('authorization');
    const cronOK = process.env.CRON_SECRET ? auth === `Bearer ${process.env.CRON_SECRET}` : false;

    let actorEmail: string | null = null;
    let actorId: string | null = null;
    let actorRole: string = 'cron';

    if (!cronOK) {
      const ctx = await requireResultsEditor();
      if (!ctx.allowed) return jsonError('Não autorizado: apenas admin ou editor de resultados', 403);
      actorEmail = ctx.user?.email ?? null;
      actorId = ctx.user?.id ?? null;
      actorRole = ctx.role;
    }

    // Buscar jogos com placar para reportar quais foram processados
    const sb = createServiceRoleClient();
    const { data: matches, error: matchErr } = await sb
      .from('matches')
      .select('id, home_score, away_score')
      .order('id');
    if (matchErr) return jsonError(`Erro buscando jogos: ${matchErr.message}`, 500);

    const completed = (matches ?? []).filter(
      (m): m is { id: number; home_score: number; away_score: number } =>
        m.home_score != null && m.away_score != null
    );

    // Executar fullRecalc com captura de erros por jogo
    try {
      await fullRecalc();
    } catch (e) {
      return jsonError(`Erro no fullRecalc: ${(e as Error).message}`, 500);
    }

    let bracket: Awaited<ReturnType<typeof recalcBracket>> | null = null;
    try {
      bracket = await recalcBracket();
    } catch (e) {
      console.warn('recalcBracket falhou:', (e as Error).message);
    }

    // Audit log
    try {
      await sb.from('audit_log').insert({
        actor_id: actorId,
        actor_email: actorEmail ?? 'system',
        action: 'full_recalc',
        payload: { matchesProcessed: completed.length, actor_role: actorRole },
      });
    } catch (e) {
      console.warn('audit_log falhou:', (e as Error).message);
    }

    // Invalidar caches
    try {
      revalidatePath('/ranking');
      revalidatePath('/ranking-zebra');
      revalidatePath('/comparativo');
      revalidatePath('/estatisticas');
      revalidatePath('/admin/resultados');
      revalidatePath('/admin/apostas');
      revalidatePath('/apostas');
    } catch (e) {
      console.warn('revalidatePath falhou:', (e as Error).message);
    }

    return NextResponse.json({
      success: true,
      message: `Recálculo completo: ${completed.length} jogo(s) processado(s)`,
      matchesProcessed: completed.length,
      bracket,
    });
  } catch (e) {
    return jsonError(`Erro inesperado: ${(e as Error).message}`, 500);
  }
}
