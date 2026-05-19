/**
 * POST /api/users/promote
 * Body: { user_id: string, is_admin: boolean }
 *
 * Promove ou rebaixa um usuário. Guards:
 *   - apenas admin pode chamar
 *   - não pode rebaixar `alexandre.oppermann@gmail.com` (admin principal)
 *   - não pode rebaixar o último admin restante
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient, requireAdmin } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAIN_ADMIN_EMAIL = 'alexandre.oppermann@gmail.com';

const Body = z.object({
  user_id: z.string().uuid(),
  is_admin: z.boolean(),
});

function jsonError(msg: string, status = 500) {
  return NextResponse.json({ success: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const { isAdmin, user: actor } = await requireAdmin();
    if (!isAdmin) return jsonError('Não autorizado', 403);

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError('Payload inválido', 400);

    const sb = createServiceRoleClient();

    // Buscar perfil a alterar
    const { data: target, error: tErr } = await sb
      .from('profiles')
      .select('id, email, is_admin')
      .eq('id', parsed.data.user_id)
      .maybeSingle();
    if (tErr) return jsonError(tErr.message);
    if (!target) return jsonError('Usuário não encontrado', 404);

    // Guard: não rebaixar admin principal
    if (parsed.data.is_admin === false && target.email?.toLowerCase() === MAIN_ADMIN_EMAIL) {
      return jsonError(`Não é possível remover privilégios do admin principal (${MAIN_ADMIN_EMAIL}).`, 400);
    }

    // Guard: não remover o último admin restante
    if (parsed.data.is_admin === false && target.is_admin === true) {
      const { count } = await sb
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('is_admin', true);
      if ((count ?? 0) <= 1) {
        return jsonError('Não é possível remover o último admin do sistema.', 400);
      }
    }

    // Aplicar mudança
    const { error: uErr } = await sb
      .from('profiles')
      .update({ is_admin: parsed.data.is_admin })
      .eq('id', parsed.data.user_id);
    if (uErr) return jsonError(uErr.message);

    await sb.from('audit_log').insert({
      actor_id: actor?.id, actor_email: actor?.email,
      action: parsed.data.is_admin ? 'promote_to_admin' : 'demote_from_admin',
      payload: { target_user_id: parsed.data.user_id, target_email: target.email },
    });

    revalidatePath('/admin/usuarios');
    return NextResponse.json({
      success: true,
      message: parsed.data.is_admin
        ? `${target.email} agora é admin.`
        : `${target.email} não é mais admin.`,
    });
  } catch (e) {
    return jsonError((e as Error).message);
  }
}
