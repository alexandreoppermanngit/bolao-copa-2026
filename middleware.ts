import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  /**
   * Roda em TODAS as rotas exceto:
   * - _next (assets)
   * - favicon, imagens, fontes etc (qualquer caminho com extensão)
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
