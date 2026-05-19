import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

/**
 * Cliente Supabase para Server Components, Server Actions e Route Handlers.
 * Lê e escreve cookies via `cookies()` do next/headers.
 *
 * IMPORTANTE para Next.js 14 App Router:
 * - Em Server Components, `cookieStore.set()` é NO-OP (limitação do framework).
 *   Use o middleware (lib/supabase/middleware.ts) para garantir refresh de tokens.
 * - Em Route Handlers e Server Actions, `cookieStore.set()` funciona normalmente.
 */
export function createClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Components não podem setar cookies — o middleware cuida disso.
          }
        },
      },
    },
  );
}

/**
 * Cliente com SERVICE ROLE — privilégios totais, IGNORA RLS.
 * USAR SOMENTE em rotas server-side protegidas (admin/cron/webhooks).
 */
export function createServiceRoleClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * Helper: requer usuário admin no servidor.
 * Retorna { user, isAdmin } — `isAdmin` é true se:
 *   - profiles.is_admin = true; OU
 *   - email do usuário está em ADMIN_EMAILS (env var)
 */
export async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, isAdmin: false };

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin, email')
    .eq('id', user.id)
    .maybeSingle();

  const adminEmails = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const isAdmin =
    profile?.is_admin === true ||
    adminEmails.includes((profile?.email ?? user.email ?? '').toLowerCase());

  return { user, isAdmin };
}
