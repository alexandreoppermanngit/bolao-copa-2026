/**
 * GET  /api/settings  — público (lê valores atuais)
 * POST /api/settings  — admin (salva alterações + audit log)
 *
 * Necessário porque a tabela `settings` tem RLS habilitada e só permite SELECT
 * para o público. UPDATE precisa rodar com service role no server.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient, requireAdmin } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(msg: string, status = 500) {
  return NextResponse.json({ success: false, error: msg }, { status });
}

// Schema: todos os campos opcionais (admin pode salvar só o que mudou)
const Body = z.object({
  global_bets_deadline: z.string().nullable().optional(),
  bets_locked: z.boolean().optional(),
  pts_correct_result: z.number().int().min(0).optional(),
  pts_correct_home: z.number().int().min(0).optional(),
  pts_correct_away: z.number().int().min(0).optional(),
  pts_correct_diff: z.number().int().min(0).optional(),
  zebra_threshold_easy: z.number().min(0).optional(),
  zebra_threshold_mid: z.number().min(0).optional(),
  zebra_mult_easy: z.number().min(0).optional(),
  zebra_mult_mid: z.number().min(0).optional(),
  zebra_mult_hard: z.number().min(0).optional(),
  pts_qual_groups: z.number().int().min(0).optional(),
  pts_qual_r32: z.number().int().min(0).optional(),
  pts_qual_r16: z.number().int().min(0).optional(),
  pts_qual_quarters: z.number().int().min(0).optional(),
  pts_qual_semis: z.number().int().min(0).optional(),
  pts_qual_third: z.number().int().min(0).optional(),
  pts_qual_champion: z.number().int().min(0).optional(),
});

export async function GET() {
  try {
    const supabase = createClient();
    const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single();
    if (error) return jsonError(error.message);
    return NextResponse.json({ success: true, settings: data });
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

    // Normaliza deadline vazio para null
    const payload: Record<string, unknown> = { ...parsed.data };
    if (payload.global_bets_deadline === '') payload.global_bets_deadline = null;

    const sb = createServiceRoleClient();
    const { error } = await sb.from('settings').update(payload).eq('id', 1);
    if (error) return jsonError(`Erro salvando: ${error.message}`);

    // Audit
    await sb.from('audit_log').insert({
      actor_id: user?.id, actor_email: user?.email,
      action: 'update_settings', payload,
    });

    // Invalidar páginas que dependem de settings
    revalidatePath('/admin/configuracao');
    revalidatePath('/apostas');
    revalidatePath('/');

    return NextResponse.json({ success: true, message: 'Configurações salvas.' });
  } catch (e) {
    return jsonError((e as Error).message);
  }
}
