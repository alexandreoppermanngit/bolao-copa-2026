/**
 * GET    /api/bracket-overrides       → lista todos
 * POST   /api/bracket-overrides       → cria/atualiza override { match_id, side, team_id, reason }
 * DELETE /api/bracket-overrides?id=N  → remove
 *
 * Apenas admin.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient, requireAdmin } from '@/lib/supabase/server';
import { recalcBracket, recalcAllQualificationScores, fullRecalc } from '@/lib/bolao/recalc';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({
  match_id: z.number().int().positive(),
  side: z.enum(['home', 'away']),
  team_id: z.number().int().positive().nullable(),
  reason: z.string().max(500).optional().nullable(),
});

function jsonError(message: string, status = 500) {
  return NextResponse.json({ success: false, error: message }, { status });
}

export async function GET() {
  try {
    const { isAdmin } = await requireAdmin();
    if (!isAdmin) return jsonError('Não autorizado', 403);
    const sb = createServiceRoleClient();
    const { data, error } = await sb.from('bracket_overrides').select('*').order('match_id');
    if (error) return jsonError(error.message);
    return NextResponse.json({ success: true, overrides: data ?? [] });
  } catch (e) {
    return jsonError((e as Error).message);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { isAdmin, user } = await requireAdmin();
    if (!isAdmin) return jsonError('Não autorizado', 403);

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError('Payload inválido', 400);

    const sb = createServiceRoleClient();
    const { error } = await sb.from('bracket_overrides').upsert({
      match_id: parsed.data.match_id,
      side: parsed.data.side,
      team_id: parsed.data.team_id,
      reason: parsed.data.reason ?? null,
      created_by: user?.id,
    }, { onConflict: 'match_id,side' });
    if (error) return jsonError(error.message);

    await sb.from('audit_log').insert({
      actor_id: user?.id, actor_email: user?.email,
      action: 'bracket_override_upsert', payload: parsed.data,
    });

    // Aplica override no bracket + recálculo completo
    await recalcBracket();
    await fullRecalc();

    revalidatePath('/admin/bracket-overrides');
    revalidatePath('/admin/resultados');
    revalidatePath('/ranking');
    revalidatePath('/estatisticas');

    return NextResponse.json({ success: true });
  } catch (e) {
    return jsonError((e as Error).message);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { isAdmin, user } = await requireAdmin();
    if (!isAdmin) return jsonError('Não autorizado', 403);
    const id = Number(new URL(req.url).searchParams.get('id'));
    if (!id) return jsonError('id obrigatório', 400);

    const sb = createServiceRoleClient();
    await sb.from('bracket_overrides').delete().eq('id', id);
    await sb.from('audit_log').insert({
      actor_id: user?.id, actor_email: user?.email,
      action: 'bracket_override_delete', payload: { id },
    });
    await recalcBracket();
    await recalcAllQualificationScores();
    revalidatePath('/admin/bracket-overrides');
    return NextResponse.json({ success: true });
  } catch (e) {
    return jsonError((e as Error).message);
  }
}
