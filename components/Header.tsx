import { getActorContext } from '@/lib/bolao/permissions';
import { HeaderClient } from './HeaderClient';

/**
 * Server wrapper: busca user + role no servidor (com cookies) e passa
 * para o HeaderClient que gerencia o burger menu.
 *
 * Inclui:
 *   - isAdmin: admin completo (vê "Admin" → todas as páginas).
 *   - canEditResults: editor de resultados que NÃO é admin completo.
 *     Esses usuários veem apenas um link direto "Admin Resultados" no menu.
 *     Middleware bloqueia tentativa de acesso a outras páginas admin.
 */
export async function Header() {
  const ctx = await getActorContext();

  return (
    <HeaderClient
      userEmail={ctx.user?.email ?? null}
      isAdmin={ctx.isAdmin}
      canEditResults={ctx.canEditResults && !ctx.isAdmin}
    />
  );
}
