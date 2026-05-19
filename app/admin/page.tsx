import Link from 'next/link';
import { createClient, requireAdmin } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function AdminHomePage() {
  const { isAdmin } = await requireAdmin();
  if (!isAdmin) redirect('/');

  const supabase = createClient();
  const [{ count: usersCount }, { count: betsCount }, { count: matchesWithResult }, { data: settings }] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('bets').select('*', { count: 'exact', head: true }),
    supabase.from('matches').select('*', { count: 'exact', head: true }).not('home_score', 'is', null),
    supabase.from('settings').select('*').single(),
  ]);

  return (
    <div className="space-y-6">
      <div className="bg-accent-red text-white rounded-xl p-4">
        <h1 className="text-2xl font-bold">⚙️ Painel do Administrador</h1>
        <p className="text-sm mt-1 opacity-90">Acesso restrito. Mudanças refletem na produção.</p>
      </div>

      <div className="grid sm:grid-cols-4 gap-3">
        <StatCard title="Usuários" value={usersCount ?? 0} />
        <StatCard title="Apostas" value={betsCount ?? 0} />
        <StatCard title="Jogos c/ resultado" value={`${matchesWithResult ?? 0}/104`} />
        <StatCard title="Apostas bloqueadas" value={settings?.bets_locked ? 'SIM' : 'NÃO'} />
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <AdminLink href="/admin/resultados" title="🏟️ Resultados dos Jogos" desc="Cadastrar / corrigir placares. Recálculo automático ao salvar." />
        <AdminLink href="/admin/usuarios" title="👥 Usuários" desc="Lista de todos os usuários cadastrados (admin pode promover via SQL)." />
        <AdminLink href="/admin/apostas" title="📋 Todas as Apostas" desc="Consulta apostas por usuário ou por jogo. Exporta CSV." />
        <AdminLink href="/admin/configuracao" title="⚙️ Configurações" desc="Prazos de apostas, lock global, pesos de pontuação, recálculo manual." />
        <AdminLink href="/admin/bracket-overrides" title="🛠️ Overrides do Bracket" desc="Força manualmente seleções classificadas (3ºs, critérios FIFA)." />
        <AdminLink href="/admin/pontuacao" title="📊 Auditoria de Pontos" desc="Vista detalhada: jogos + classificação, por usuário." />
      </div>
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="bg-white rounded-xl p-4 shadow-sm">
      <div className="text-xs text-gray-600">{title}</div>
      <div className="text-2xl font-bold text-brand-500">{value}</div>
    </div>
  );
}

function AdminLink({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link href={href} className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md hover:bg-brand-50 transition-all block">
      <h2 className="font-bold text-brand-500">{title}</h2>
      <p className="text-sm text-gray-600 mt-1">{desc}</p>
    </Link>
  );
}
