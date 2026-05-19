import { createClient, requireAdmin } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import type { Bet, Team, Match, AnnexCOption } from '@/types/database';
import { BetsAdminTable } from '@/components/BetsAdminTable';

export const dynamic = 'force-dynamic';

export default async function AdminBetsPage() {
  const { isAdmin } = await requireAdmin();
  if (!isAdmin) redirect('/');

  const supabase = createClient();
  const [
    { data: bets },
    { data: profiles },
    { data: matches },
    { data: teams },
    { data: annexC },
  ] = await Promise.all([
    supabase.from('bets').select('*').limit(10000),
    supabase.from('profiles').select('id, display_name, email'),
    supabase.from('matches').select('*').order('id'),
    supabase.from('teams').select('*'),
    supabase.from('fifa_annex_c').select('*'),
  ]);

  return (
    <div className="space-y-4">
      <div className="bg-accent-red text-white rounded-xl p-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">📋 Todas as Apostas</h1>
          <p className="text-sm mt-1 opacity-90">
            Filtros disponíveis abaixo. Para jogos de mata-mata, os times exibidos
            são os do bracket simulado de cada usuário.
          </p>
        </div>
      </div>

      <BetsAdminTable
        bets={(bets ?? []) as Bet[]}
        profiles={(profiles ?? []) as { id: string; display_name: string | null; email: string }[]}
        matches={(matches ?? []) as Match[]}
        teams={(teams ?? []) as Team[]}
        annexCOptions={(annexC ?? []) as AnnexCOption[]}
      />
    </div>
  );
}
