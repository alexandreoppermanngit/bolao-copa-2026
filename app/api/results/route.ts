/**
 * POST /api/results
 * Admin grava resultado oficial de um jogo + dispara recálculo.
 *
 * Sempre retorna JSON, mesmo em erro (evita "Unexpected end of JSON input" no front).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient, requireAdmin } from '@/lib/supabase/server';
import { recalcMatchAndAllBets, recalcBracket, recalcAllQualificationScores } from '@/lib/bolao/recalc';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({
  match_id: z.number().int().positive(),
  home_score: z.number().int().min(0).max(30).nullable(),
  away_score: z.number().int().min(0).max(30).nullable(),
  home_pens: z.number().int().min(0).max(30).nullable().optional(),
  away_pens: z.number().int().min(0).max(30).nullable().optional(),
});

function jsonError(message: string, status = 500, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { success: false, error: message, ...(extra ?? {}) },
    { status }
  );
}

export async function POST(req: NextRequest) {
  try {
    const { isAdmin, user } = await requireAdmin();
    if (!isAdmin) return jsonError('Não autorizado: apenas admin', 403);

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return jsonError('Corpo da requisição não é JSON válido', 400);
    }
    const parsed = Body.safeParse(payload);
    if (!parsed.success) {
      return jsonError('Validação falhou', 400, { issues: parsed.error.format() });
    }

    const sb = createServiceRoleClient();

    // 1) Atualizar matches
    const { error: updErr } = await sb.from('matches').update({
      home_score: parsed.data.home_score,
      away_score: parsed.data.away_score,
      home_pens: parsed.data.home_pens ?? null,
      away_pens: parsed.data.away_pens ?? null,
    }).eq('id', parsed.data.match_id);
    if (updErr) return jsonError(`Erro ao salvar matches: ${updErr.message}`, 500);

    // 2) Audit log (não bloqueante)
    try {
      await sb.from('audit_log').insert({
        actor_id: user?.id, actor_email: user?.email,
        action: 'update_result', payload: parsed.data,
      });
    } catch (e) {
      console.warn('audit_log falhou:', (e as Error).message);
    }

    // 3) Recalcular esta aposta
    let recalc: { updated?: number; multiplier?: number; pctSame?: number; message?: string } = {};
    try {
      const r = await recalcMatchAndAllBets(parsed.data.match_id);
      recalc = r;
    } catch (e) {
      return jsonError(`Erro ao recalcular apostas do jogo: ${(e as Error).message}`, 500);
    }

    // 4) Recalcular bracket (idempotente). Não falha a request se der erro aqui.
    let bracket: { sortedKey?: string; annexCOption?: number | null; updatedMatches?: number; mature?: boolean } = {};
    try {
      bracket = await recalcBracket();
    } catch (e) {
      console.warn('recalcBracket falhou (não bloqueante):', (e as Error).message);
    }

    // 4b) Recalcular qualificação (não bloqueante)
    try {
      await recalcAllQualificationScores();
    } catch (e) {
      console.warn('recalcAllQualificationScores falhou (não bloqueante):', (e as Error).message);
    }

    // 5) Invalidar cache das páginas dependentes
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
      message: 'Resultado salvo e rankings recalculados',
      updated: recalc.updated ?? 0,
      multiplier: recalc.multiplier,
      pctSame: recalc.pctSame,
      bracket,
    });
  } catch (e) {
    return jsonError(`Erro inesperado: ${(e as Error).message}`, 500);
  }
}
