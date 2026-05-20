import { createClient, requireAdmin } from '@/lib/supabase/server';
import type { Match, Team, Bet, AnnexCOption } from '@/types/database';
import { MatchComparison } from '@/components/MatchComparison';

// Página dinâmica: sempre buscar bets/profiles frescos do Supabase ao montar.
// Combinado com staleTimes.dynamic = 0 no next.config.js, garante que
// apostas recém-salvas aparecem assim que o usuário entra na página.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

interface Profile { id: string; display_name: string | null; email: string }

export default async function ComparativoPage({ searchParams }: { searchParams: { jogo?: string } }) {
  const supabase = createClient();
  const { isAdmin } = await requireAdmin();

  const [{ data: matches }, { data: teams }, { data: bets }, { data: profiles }, { data: annexC }] = await Promise.all([
    supabase.from('matches').select('*').order('id'),
    supabase.from('teams').select('*'),
    supabase.from('bets').select('*'),
    supabase.from('profiles').select('id, display_name, email'),
    supabase.from('fifa_annex_c').select('*'),
  ]);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl p-4 shadow-sm">
        <h1 className="text-2xl font-bold">📊 Comparativo de Apostas por Jogo</h1>
        <p className="text-sm text-gray-600 mt-1">
          Escolha um jogo para ver a distribuição de palpites, placares e quem apostou em quê.
          Para jogos de mata-mata, os times exibidos para cada apostador correspondem à simulação dele.
        </p>
      </div>

      <MatchComparison
        initialMatchId={searchParams.jogo ? Number(searchParams.jogo) : 1}
        matches={(matches ?? []) as Match[]}
        teams={(teams ?? []) as Team[]}
        bets={(bets ?? []) as Bet[]}
        profiles={(profiles ?? []) as Profile[]}
        annexCOptions={(annexC ?? []) as AnnexCOption[]}
        isAdmin={isAdmin}
      />
    </div>
  );
}
