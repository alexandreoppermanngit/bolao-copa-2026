/**
 * POST /api/results/batch
 * Salva múltiplos placares de uma vez + recalcula tudo no final (mais rápido que N requests).
 *
 * Body: { results: [{ match_id, home_score, away_score, home_pens?, away_pens? }, ...] }
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient, requireAdmin } from '@/lib/supabase/server';
import {
  recalcMatchAndAllBets, recalcBracket, recalcAllQualificationScores,
} from '@/lib/bolao/recalc';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const ResultItem = z.object({
  match_id: z.number().int().positive(),
  home_score: z.number().int().min(0).max(30).nullable(),
  away_score: z.number().int().min(0).max(30).nullable(),
  home_pens: z.number().int().min(0).max(30).nullable().optional(),
  away_pens: z.number().int().min(0).max(30).nullable().optional(),
});
const Body = z.object({ results: z.array(ResultItem).min(1).max(120) });

function jsonError(msg: string, status = 500, extra?: Record<string, unknown>) {
  return NextResponse.json({ success: false, error: msg, ...(extra ?? {}) }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const { isAdmin, user } = await requireAdmin();
    if (!isAdmin) return jsonError('Não autorizado', 403);

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError('Payload inválido', 400);

    const sb = createServiceRoleClient();
    const failures: { match_id: number; error: string }[] = [];

    // 1) UPDATEs em paralelo nos matches
    await Promise.all(parsed.data.results.map(async r => {
      const { error } = await sb.from('matches').update({
        home_score: r.home_score, away_score: r.away_score,
        home_pens: r.home_pens ?? null, away_pens: r.away_pens ?? null,
      }).eq('id', r.match_id);
      if (error) failures.push({ match_id: r.match_id, error: error.message });
    }));

    // 2) Recalcular bets de cada match alterado (sequencial p/ evitar contenção)
    let updatedBets = 0;
    for (const r of parsed.data.results) {
      try {
        const out = await recalcMatchAndAllBets(r.match_id);
        updatedBets += out.updated ?? 0;
      } catch (e) {
        failures.push({ match_id: r.match_id, error: (e as Error).message });
      }
    }

    // 3) Bracket + qualification (uma vez só, no final)
    let bracket: Awaited<ReturnType<typeof recalcBracket>> | null = null;
    try { bracket = await recalcBracket(); } catch (e) { console.warn('recalcBracket:', (e as Error).message); }
    try { await recalcAllQualificationScores(); } catch (e) { console.warn('qual:', (e as Error).message); }

    // 4) Audit log
    await sb.from('audit_log').insert({
      actor_id: user?.id, actor_email: user?.email,
      action: 'batch_update_results',
      payload: { count: parsed.data.results.length, failures: failures.length },
    });

    // 5) Invalidar caches
    revalidatePath('/ranking'); revalidatePath('/ranking-zebra');
    revalidatePath('/comparativo'); revalidatePath('/estatisticas');
    revalidatePath('/admin/resultados'); revalidatePath('/admin/apostas');
    revalidatePath('/admin/pontuacao'); revalidatePath('/apostas');

    return NextResponse.json({
      success: true,
      message: `${parsed.data.results.length - failures.length} jogo(s) salvo(s) e recalculado(s)`,
      saved: parsed.data.results.length - failures.length,
      updatedBets,
      failures,
      bracket,
    });
  } catch (e) {
    return jsonError(`Erro inesperado: ${(e as Error).message}`, 500);
  }
}
