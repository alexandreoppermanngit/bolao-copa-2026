/**
 * POST /api/users/delete
 * Body: { user_id: string, confirm: 'DELETE_USER' }
 *
 * Deleta usuário do Supabase Auth (Admin API). Como a FK
 *   profiles.id → auth.users.id ON DELETE CASCADE
 * já cascateia, isso também apaga:
 *   - profiles
 *   - bets (FK em profiles)
 *   - user_qualification_scores (FK em profiles)
 *
 * Guards:
 *   - apenas admin
 *   - não pode deletar `alexandre.oppermann@gmail.com`
 *   - não pode deletar a si mesmo
 *   - não pode deletar o último admin
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
  confirm: z.literal('DELETE_USER'),
});

function jsonError(msg: string, status = 500) {
  return NextResponse.json({ success: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const { isAdmin, user: actor } = await requireAdmin();
    if (!isAdmin) return jsonError('Não autorizado', 403);

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError('Payload inválido — confirme com {confirm: "DELETE_USER"}', 400);

    const sb = createServiceRoleClient();

    // Buscar alvo
    const { data: target, error: tErr } = await sb
      .from('profiles')
      .select('id, email, is_admin')
      .eq('id', parsed.data.user_id)
      .maybeSingle();
    if (tErr) return jsonError(tErr.message);
    if (!target) return jsonError('Usuário não encontrado', 404);

    // Guard: admin principal
    if (target.email?.toLowerCase() === MAIN_ADMIN_EMAIL) {
      return jsonError(`Não é possível deletar o admin principal (${MAIN_ADMIN_EMAIL}).`, 400);
    }
    // Guard: deletar a si mesmo
    if (actor?.id === target.id) {
      return jsonError('Você não pode deletar a si mesmo.', 400);
    }
    // Guard: último admin
    if (target.is_admin) {
      const { count } = await sb
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('is_admin', true);
      if ((count ?? 0) <= 1) {
        return jsonError('Não é possível deletar o último admin.', 400);
      }
    }

    // Deletar via Admin API (Supabase Auth). Cascata limpa profiles + bets + uqs.
    const { error: dErr } = await sb.auth.admin.deleteUser(parsed.data.user_id);
    if (dErr) {
      // Fallback: limpar profiles + dados relacionados, mesmo sem apagar auth.users
      // (não é o ideal, mas evita usuário "morto" travando o sistema)
      await sb.from('user_qualification_scores').delete().eq('user_id', parsed.data.user_id);
      await sb.from('bets').delete().eq('user_id', parsed.data.user_id);
      await sb.from('profiles').delete().eq('id', parsed.data.user_id);
      console.warn('auth.admin.deleteUser falhou — limpamos só profile+bets+uqs:', dErr.message);
    }

    await sb.from('audit_log').insert({
      actor_id: actor?.id, actor_email: actor?.email,
      action: 'delete_user',
      payload: { target_user_id: parsed.data.user_id, target_email: target.email },
    });

    revalidatePath('/admin/usuarios');
    revalidatePath('/admin/apostas');
    revalidatePath('/admin/pontuacao');
    revalidatePath('/ranking');
    revalidatePath('/ranking-zebra');

    return NextResponse.json({
      success: true,
      message: `Usuário ${target.email} removido (apostas e dados relacionados também).`,
    });
  } catch (e) {
    return jsonError((e as Error).message);
  }
}
