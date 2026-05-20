/**
 * POST /api/users/results-editor
 * Body: { user_id: string, can_edit_results: boolean }
 *
 * Apenas ADMIN COMPLETO pode chamar (editor de resultados NÃO pode
 * conceder permissão a outros usuários — isso é regra de segurança).
 *
 * Guards:
 *   - requireAdmin no servidor (não basta esconder botão no front)
 *   - registra em audit_log com action grant_results_editor / revoke_results_editor
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient, requireAdmin } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({
  user_id: z.string().uuid(),
  can_edit_results: z.boolean(),
});

function jsonError(msg: string, status = 500) {
  return NextResponse.json({ success: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const { isAdmin, user: actor } = await requireAdmin();
    if (!isAdmin) return jsonError('Não autorizado: apenas admin completo', 403);

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError('Payload inválido', 400);

    const sb = createServiceRoleClient();

    // Buscar perfil a alterar (para validar existência + audit)
    const { data: target, error: tErr } = await sb
      .from('profiles')
      .select('id, email, is_admin, can_edit_results')
      .eq('id', parsed.data.user_id)
      .maybeSingle();
    if (tErr) return jsonError(tErr.message);
    if (!target) return jsonError('Usuário não encontrado', 404);

    // Admin completo já pode editar resultados — flag é redundante mas
    // não bloqueamos: serve para deixar explícito na UI.

    const { error: uErr } = await sb
      .from('profiles')
      .update({ can_edit_results: parsed.data.can_edit_results })
      .eq('id', parsed.data.user_id);
    if (uErr) return jsonError(uErr.message);

    await sb.from('audit_log').insert({
      actor_id: actor?.id, actor_email: actor?.email,
      action: parsed.data.can_edit_results ? 'grant_results_editor' : 'revoke_results_editor',
      payload: {
        target_user_id: parsed.data.user_id,
        target_email: target.email,
        actor_role: 'admin',
      },
    });

    revalidatePath('/admin/usuarios');
    return NextResponse.json({
      success: true,
      message: parsed.data.can_edit_results
        ? `${target.email} agora é editor de resultados.`
        : `${target.email} não é mais editor de resultados.`,
    });
  } catch (e) {
    return jsonError((e as Error).message);
  }
}
