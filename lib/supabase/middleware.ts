/**
 * Helper de Supabase para o middleware do Next.js.
 *
 * Implementa o padrão oficial recomendado:
 *   https://supabase.com/docs/guides/auth/server-side/nextjs
 *
 * Pontos críticos:
 * - Usa a API nova `getAll/setAll` (mais robusta)
 * - Quando o Supabase refresca tokens, atualizamos REQUEST.cookies + criamos
 *   um NOVO response para que as próximas middlewares/rotas enxerguem o token novo
 * - Ao redirecionar, COPIAMOS os cookies do supabaseResponse para o redirect,
 *   garantindo que Set-Cookie chegue ao navegador.
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: NÃO insira nenhuma lógica entre createServerClient e getUser.
  // (recomendação oficial Supabase para evitar deslogamento aleatório)
  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // Rotas que NÃO exigem login
  const isPublic =
    path === '/' ||
    path.startsWith('/login') ||
    path.startsWith('/auth') ||
    path.startsWith('/ranking') ||
    path.startsWith('/ranking-zebra') ||
    path.startsWith('/comparativo') ||
    path.startsWith('/estatisticas') ||
    path.startsWith('/_next') ||
    path.startsWith('/api/auth');

  // Rotas protegidas que exigem login
  const requiresLogin = !isPublic && (
    path.startsWith('/apostas') ||
    path.startsWith('/meus-resultados') ||
    path.startsWith('/admin')
  );

  // ---- 1) Não logado em rota protegida → redirect /login ----
  if (requiresLogin && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirectTo', path);
    const redirect = NextResponse.redirect(url);
    // Preservar cookies que o Supabase pode ter atualizado durante getUser
    supabaseResponse.cookies.getAll().forEach((c) => {
      redirect.cookies.set(c.name, c.value, c);
    });
    return redirect;
  }

  // ---- 2) Logado mas tentando entrar em /admin sem permissão ----
  if (user && path.startsWith('/admin')) {
    // Buscar is_admin + can_edit_results na tabela profiles
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
    const canEditResults = profile?.can_edit_results === true;

    // Editor de resultados: SÓ pode acessar /admin/resultados (e /admin home,
    // que filtra os atalhos conforme permissão).
    const isResultsEditorPath =
      path === '/admin' ||
      path === '/admin/' ||
      path.startsWith('/admin/resultados');

    const allowed = isAdmin || (canEditResults && isResultsEditorPath);

    if (!allowed) {
      const url = request.nextUrl.clone();
      // Editor de resultados tentando acessar página admin não permitida:
      // mandar direto para /admin/resultados (mais útil que home).
      url.pathname = canEditResults ? '/admin/resultados' : '/';
      const redirect = NextResponse.redirect(url);
      supabaseResponse.cookies.getAll().forEach((c) => {
        redirect.cookies.set(c.name, c.value, c);
      });
      return redirect;
    }
  }

  // ---- 3) Caso normal: retorna supabaseResponse com cookies refrescados ----
  // IMPORTANTE: você DEVE retornar o supabaseResponse exatamente como está
  // (com os cookies já populados). NÃO crie um novo response aqui.
  return supabaseResponse;
}
