/**
 * Permissões server-side do Bolão 2026.
 *
 * Hierarquia:
 *   - admin completo (is_admin = true OR email em ADMIN_EMAILS): pode tudo.
 *   - editor de resultados (can_edit_results = true): pode salvar resultados
 *     oficiais e disparar recálculo, mas NÃO acessa usuários, configurações,
 *     pontuação, overrides, apostas ou reset.
 *   - usuário comum: apenas /apostas (próprias).
 *
 * IMPORTANTE: estas verificações são feitas SERVER-SIDE em:
 *   - middleware.ts (bloqueia navegação a páginas admin)
 *   - APIs (validam permissão antes de gravar / disparar ação)
 *
 * Nunca confie em "esconder botão no front" para segurança.
 */

import { createClient } from '@/lib/supabase/server';

export type ActorRole = 'admin' | 'results_editor' | 'user' | 'anon';

export interface ActorContext {
  user: { id: string; email?: string | null } | null;
  isAdmin: boolean;
  canEditResults: boolean;
  role: ActorRole;
}

/**
 * Lê o usuário atual + flags de permissão. Single source of truth.
 *
 * Combina:
 *   - profiles.is_admin
 *   - profiles.can_edit_results
 *   - ADMIN_EMAILS (env var; útil em desenvolvimento)
 */
export async function getActorContext(): Promise<ActorContext> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { user: null, isAdmin: false, canEditResults: false, role: 'anon' };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin, can_edit_results, email')
    .eq('id', user.id)
    .maybeSingle();

  const adminEmails = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const profileEmail = (profile?.email ?? user.email ?? '').toLowerCase();
  const isAdmin =
    profile?.is_admin === true ||
    adminEmails.includes(profileEmail);

  // Admin completo implicitamente pode editar resultados, mas mantemos
  // a flag explícita separada para auditoria/UI.
  const canEditResults = isAdmin || profile?.can_edit_results === true;

  const role: ActorRole = isAdmin
    ? 'admin'
    : profile?.can_edit_results === true
    ? 'results_editor'
    : 'user';

  return {
    user: { id: user.id, email: user.email ?? profile?.email ?? null },
    isAdmin,
    canEditResults,
    role,
  };
}

/**
 * Helper de compatibilidade — mantém a mesma assinatura do `requireAdmin`
 * histórico, mas agora delega ao `getActorContext`.
 */
export async function requireAdmin() {
  const ctx = await getActorContext();
  return { user: ctx.user, isAdmin: ctx.isAdmin };
}

/**
 * Verifica se o ator pode editar resultados oficiais (admin OU editor).
 * Use nas rotas:
 *   - POST /api/results
 *   - POST /api/results/batch
 *   - POST /api/recalc
 *
 * NÃO use em /api/results/reset, /api/users/*, /api/settings (POST),
 * /api/bracket-overrides — essas continuam admin-only.
 */
export async function requireResultsEditor() {
  const ctx = await getActorContext();
  const allowed = ctx.isAdmin || ctx.canEditResults;
  return { ...ctx, allowed };
}

/**
 * Label legível da role para UI / audit_log.
 */
export function roleLabel(role: ActorRole): string {
  switch (role) {
    case 'admin': return 'Admin completo';
    case 'results_editor': return 'Editor de resultados';
    case 'user': return 'Usuário';
    case 'anon': return 'Anônimo';
  }
}
