import { createClient, requireAdmin } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import type { Bet, Team, Match, AnnexCOption } from '@/types/database';
import { BetsAdminTable } from '@/components/BetsAdminTable';
import { fetchAll } from '@/lib/supabase/fetchAll';

export const dynamic = 'force-dynamic';

export default async function AdminBetsPage() {
  const { isAdmin } = await requireAdmin();
  if (!isAdmin) redirect('/');

  const supabase = createClient();
  // v68 — PAGINAÇÃO. `.limit(10000)` parecia resolver, mas o PostgREST do
  // Supabase tem `max-rows = 1000` por default no plano hosted — qualquer
  // `.limit(N>1000)` é truncado pra 1000. Resultado: o export CSV (que vem
  // dessas bets) saía com no máximo 1000 linhas, não 1.556. Solução: fetchAll
  // com `.range()` explícito por página.
  const [bets, profiles, matches, teams, annexC] = await Promise.all([
    fetchAll<Bet>((from, to) =>
      supabase.from('bets').select('*').range(from, to)),
    fetchAll<{ id: string; display_name: string | null; email: string }>((from, to) =>
      supabase.from('profiles').select('id, display_name, email').range(from, to)),
    fetchAll<Match>((from, to) =>
      supabase.from('matches').select('*').order('id').range(from, to)),
    fetchAll<Team>((from, to) =>
      supabase.from('teams').select('*').range(from, to)),
    fetchAll<AnnexCOption>((from, to) =>
      supabase.from('fifa_annex_c').select('*').range(from, to)),
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
        bets={bets}
        profiles={profiles}
        matches={matches}
        teams={teams}
        annexCOptions={annexC}
      />
    </div>
  );
}
