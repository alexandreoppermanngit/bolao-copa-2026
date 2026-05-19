/**
 * Callback do OAuth Google → Supabase.
 *
 * Fluxo:
 * 1. Recebe `code` e (opcional) `next` na query string
 * 2. Troca o code por sessão chamando `exchangeCodeForSession`
 * 3. Salva os cookies sb-* DIRETAMENTE no response de redirect
 *    (esse passo é o crucial — se você criar um NextResponse novo DEPOIS
 *     de chamar exchangeCodeForSession, os cookies se perdem)
 * 4. Redireciona para `next` (default `/apostas`)
 *
 * Forçamos a rota como dinâmica e sem cache.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/apostas';

  // Se não veio code, manda para login com mensagem
  if (!code) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent('missing_code')}`,
    );
  }

  // Resolver host correto (importante para Vercel preview/produção)
  const forwardedHost = request.headers.get('x-forwarded-host');
  const isLocalEnv = process.env.NODE_ENV === 'development';
  const safeNext = next.startsWith('/') ? next : '/apostas';
  const baseUrl =
    isLocalEnv ? origin
    : forwardedHost ? `https://${forwardedHost}`
    : origin;

  // Criar response de redirect ANTES de chamar Supabase, para que
  // o cliente Supabase escreva os cookies diretamente nesse response.
  const response = NextResponse.redirect(`${baseUrl}${safeNext}`);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    // Em caso de erro, redireciona para /login com mensagem
    return NextResponse.redirect(
      `${baseUrl}/login?error=${encodeURIComponent(error.message)}`,
    );
  }

  // response já contém os Set-Cookie headers sb-access-token e sb-refresh-token
  return response;
}
