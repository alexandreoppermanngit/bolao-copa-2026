import { createClient, createServiceRoleClient, requireAdmin } from '@/lib/supabase/server';
import type { Match, Team, Bet, AnnexCOption, Settings } from '@/types/database';
import { MatchComparison } from '@/components/MatchComparison';
import { getGlobalLockStatus } from '@/lib/bolao/lockStatus';

// Página dinâmica: sempre buscar bets/profiles frescos do Supabase ao montar.
// Combinado com staleTimes.dynamic = 0 no next.config.js, garante que
// apostas recém-salvas aparecem assim que o usuário entra na página.
// E depende de `settings` (lock dinâmico baseado em now()), então NUNCA cachear.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

interface Profile { id: string; display_name: string | null; email: string }

export default async function ComparativoPage({ searchParams }: { searchParams: { jogo?: string } }) {
  // Cliente do usuário (RLS aplicada) — usado para dados públicos e fallback
  const supabase = createClient();
  const { isAdmin } = await requireAdmin();

  // 1) Ler settings primeiro para decidir visibilidade de apostas alheias
  const { data: settingsRaw } = await supabase
    .from('settings')
    .select('bets_locked, global_bets_deadline')
    .eq('id', 1)
    .maybeSingle();
  const lock = getGlobalLockStatus(
    (settingsRaw ?? null) as Pick<Settings, 'bets_locked' | 'global_bets_deadline'> | null
  );

  // Regra: vê apostas de TODOS se admin OU apostas bloqueadas (lock global ou deadline expirado).
  // Senão, vê apenas a própria aposta (RLS naturalmente já restringe via cliente autenticado).
  const canSeeAllBets = isAdmin || lock.locked;

  // 2) Dados públicos (matches, teams, annexC) — sempre via cliente autenticado
  const [{ data: matches }, { data: teams }, { data: annexC }] = await Promise.all([
    supabase.from('matches').select('*').order('id'),
    supabase.from('teams').select('*'),
    supabase.from('fifa_annex_c').select('*'),
  ]);

  // 3) bets + profiles — fonte depende de canSeeAllBets
  let bets: Bet[] = [];
  let profiles: Profile[] = [];

  if (canSeeAllBets) {
    // Service role bypassa RLS de bets — garante TODAS as apostas.
    // Defesa em profundidade: a migration 005 também libera a RLS quando lock=true.
    const sb = createServiceRoleClient();
    // Profiles: só inclui email se admin; usuário comum vê apenas display_name.
    const profileCols = isAdmin ? 'id, display_name, email' : 'id, display_name';
    const [{ data: betsRaw }, { data: profilesRaw }] = await Promise.all([
      sb.from('bets').select('*'),
      sb.from('profiles').select(profileCols),
    ]);
    bets = (betsRaw ?? []) as Bet[];
    profiles = (profilesRaw ?? []).map((p) => {
      const row = p as unknown as  { id: string; display_name: string | null; email?: string };
      return {
        id: row.id,
        display_name: row.display_name,
        email: isAdmin ? (row.email ?? '') : '',  // mascarado para não-admin
      };
    });
  } else {
    // Usuário comum e apostas ABERTAS: cliente autenticado, RLS limita à própria aposta.
    const [{ data: betsRaw }, { data: profilesRaw }] = await Promise.all([
      supabase.from('bets').select('*'),
      supabase.from('profiles').select('id, display_name'),
    ]);
    bets = (betsRaw ?? []) as Bet[];
    profiles = (profilesRaw ?? []).map((p) => ({
      id: (p as { id: string }).id,
      display_name: (p as { display_name: string | null }).display_name,
      email: '',  // não expor email
    }));
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl p-4 shadow-sm">
        <h1 className="text-2xl font-bold">📊 Comparativo de Apostas por Jogo</h1>
        <p className="text-sm text-gray-600 mt-1">
          Escolha um jogo para ver a distribuição de palpites, placares e quem apostou em quê.
          Para jogos de mata-mata, os times exibidos para cada apostador correspondem à simulação dele.
        </p>
        {!isAdmin && !lock.locked && (
          <p className="text-xs mt-2 bg-amber-50 border border-amber-200 text-amber-900 rounded px-2 py-1 inline-block">
            ⏳ Enquanto as apostas estão <strong>abertas</strong>, você vê apenas a sua aposta nesta página.
            Quando as apostas forem encerradas, todas as apostas dos demais ficam visíveis.
          </p>
        )}
        {!isAdmin && lock.locked && (
          <p className="text-xs mt-2 bg-green-50 border border-green-200 text-green-900 rounded px-2 py-1 inline-block">
            🔓 Apostas encerradas — você agora vê as apostas de todos os jogadores.
          </p>
        )}
      </div>

      <MatchComparison
        initialMatchId={searchParams.jogo ? Number(searchParams.jogo) : 1}
        matches={(matches ?? []) as Match[]}
        teams={(teams ?? []) as Team[]}
        bets={bets}
        profiles={profiles}
        annexCOptions={(annexC ?? []) as AnnexCOption[]}
        isAdmin={isAdmin}
      />
    </div>
  );
}
