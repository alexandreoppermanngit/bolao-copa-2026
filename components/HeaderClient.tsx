'use client';

/**
 * Header responsivo com burger menu no mobile.
 * Desktop (≥ md): menu horizontal completo.
 * Mobile (< md): logo + ícone burger; ao clicar, abre drawer com links.
 *
 * Acessibilidade:
 *   - botão com aria-label e aria-expanded
 *   - fecha ao clicar em link, ao apertar Esc, ao clicar fora
 *   - foco visível
 */

import Link from 'next/link';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

const NAV_LINKS = [
  { href: '/', label: 'Início' },
  { href: '/apostas', label: 'Minhas Apostas', loggedOnly: true },
  { href: '/meus-resultados', label: 'Meus Resultados', loggedOnly: true },
  { href: '/ranking', label: 'Ranking' },
  { href: '/ranking-zebra', label: 'Ranking Zebra' },
  { href: '/comparativo', label: 'Comparativo' },
  { href: '/estatisticas', label: 'Estatísticas' },
];

interface Props {
  userEmail: string | null;
  isAdmin: boolean;
  /** True quando é editor de resultados mas NÃO admin completo. */
  canEditResults?: boolean;
}

export function HeaderClient({ userEmail, isAdmin, canEditResults = false }: Props) {
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  const close = useCallback(() => setOpen(false), []);

  // Fechar ao trocar de rota
  useEffect(() => { close(); }, [pathname, close]);

  // Fechar com Esc + clique fora
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    function onClick(e: MouseEvent) {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open, close]);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    close();
    router.refresh();
    router.push('/');
  }

  const navLinkClass = 'px-3 py-1 hover:text-brand-100 transition-colors';

  // Links que aparecem no menu (filtrados por permissão)
  const visibleLinks = NAV_LINKS.filter(l => !l.loggedOnly || userEmail);

  return (
    <header className="bg-brand-500 text-white sticky top-0 z-50 shadow-md">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        {/* Logo */}
        <Link href="/" className="text-lg font-bold shrink-0">🏆 Bolão Copa 2026</Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1 text-sm flex-wrap">
          {visibleLinks.map(l => (
            <Link key={l.href} href={l.href} className={navLinkClass}>{l.label}</Link>
          ))}
          {isAdmin && <Link href="/admin" className={`${navLinkClass} bg-accent-red rounded`}>Admin</Link>}
          {!isAdmin && canEditResults && (
            <Link href="/admin/resultados" className={`${navLinkClass} bg-blue-600 rounded`}>
              🏟️ Admin Resultados
            </Link>
          )}
        </nav>

        {/* Auth state (desktop) + Burger (mobile) */}
        <div className="flex items-center gap-2">
          <div className="hidden md:block">
            {userEmail
              ? (
                <button onClick={signOut} className="text-sm hover:underline" title={`Logado como ${userEmail}`}>
                  Sair ({userEmail.split('@')[0]})
                </button>
              )
              : <Link href="/login" className="bg-white text-brand-600 px-3 py-1 rounded font-medium text-sm">Entrar</Link>}
          </div>

          {/* Burger (mobile only) */}
          <button
            className="md:hidden p-2 -mr-2 rounded hover:bg-brand-600 focus:outline-none focus:ring-2 focus:ring-white/40"
            aria-label={open ? 'Fechar menu' : 'Abrir menu'}
            aria-expanded={open}
            aria-controls="mobile-drawer"
            onClick={() => setOpen(o => !o)}
          >
            {open ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Drawer (mobile only) */}
      {open && (
        <div
          ref={drawerRef}
          id="mobile-drawer"
          className="md:hidden bg-brand-600 border-t border-brand-700 shadow-lg"
        >
          <nav className="flex flex-col py-2">
            {visibleLinks.map(l => (
              <Link
                key={l.href}
                href={l.href}
                onClick={close}
                className="px-4 py-3 text-sm hover:bg-brand-700 active:bg-brand-700 border-b border-brand-700/40 last:border-0"
              >
                {l.label}
              </Link>
            ))}
            {isAdmin && (
              <Link
                href="/admin"
                onClick={close}
                className="px-4 py-3 text-sm bg-accent-red hover:opacity-90 active:opacity-90 border-b border-brand-700/40"
              >
                Admin
              </Link>
            )}
            {!isAdmin && canEditResults && (
              <Link
                href="/admin/resultados"
                onClick={close}
                className="px-4 py-3 text-sm bg-blue-600 hover:opacity-90 active:opacity-90 border-b border-brand-700/40"
              >
                🏟️ Admin Resultados
              </Link>
            )}
            {userEmail ? (
              <button
                onClick={signOut}
                className="px-4 py-3 text-sm text-left hover:bg-brand-700 active:bg-brand-700 border-t border-brand-700/40"
              >
                Sair ({userEmail.split('@')[0]})
              </button>
            ) : (
              <Link
                href="/login"
                onClick={close}
                className="px-4 py-3 text-sm text-left bg-white text-brand-600 m-2 rounded font-medium hover:opacity-90"
              >
                Entrar
              </Link>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}
