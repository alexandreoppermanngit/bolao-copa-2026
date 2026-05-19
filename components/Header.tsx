import Link from 'next/link';
import { createClient, requireAdmin } from '@/lib/supabase/server';
import { LogoutButton } from './LogoutButton';

export async function Header() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { isAdmin } = await requireAdmin();

  const navLink = 'px-3 py-1 hover:text-brand-100 transition-colors';

  return (
    <header className="bg-brand-500 text-white sticky top-0 z-50 shadow-md">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between flex-wrap gap-3">
        <Link href="/" className="text-lg font-bold">🏆 Bolão Copa 2026</Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link href="/" className={navLink}>Início</Link>
          {user && <Link href="/apostas" className={navLink}>Minhas Apostas</Link>}
          <Link href="/ranking" className={navLink}>Ranking</Link>
          <Link href="/ranking-zebra" className={navLink}>Ranking Zebra</Link>
          <Link href="/comparativo" className={navLink}>Comparativo</Link>
          <Link href="/estatisticas" className={navLink}>Estatísticas</Link>
          {isAdmin && <Link href="/admin" className={navLink + ' bg-accent-red rounded'}>Admin</Link>}
        </nav>
        <div>
          {user
            ? <LogoutButton email={user.email ?? ''} />
            : <Link href="/login" className="bg-white text-brand-600 px-3 py-1 rounded font-medium">Entrar</Link>}
        </div>
      </div>
    </header>
  );
}
