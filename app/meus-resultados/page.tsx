/**
 * /meus-resultados — Lista todos os jogos apostados pelo usuário (ou
 * pelo jogador selecionado, no caso de admin), com:
 *   - times apostados (via snapshots em bets);
 *   - placar apostado;
 *   - placar real (quando houver);
 *   - pontos por jogo (já calculados pelo recalc — fonte única);
 *   - status/motivo (via buildBetAudit).
 *
 * Usuário comum: vê apenas os próprios dados (server-side, `auth.uid()`).
 * Admin: pode escolher outro usuário via `?user=<uuid>`.
 *
 * Sem migration. Sem duplicação de regra de pontuação — buildBetAudit é
 * a fonte. Snapshots de bets são a fonte dos times apostados.
 */

import { redirect } from 'next/navigation';
import { createClient, requireAdmin } from '@/lib/supabase/server';
import { fetchAll } from '@/lib/supabase/fetchAll';
import { buildBetAudit, simulateBracketForUser, type BetAudit } from '@/lib/bolao/audit';
import { MyResultsView } from '@/components/MyResultsView';
import type {
  Bet, Match, Team, AnnexCOption, UserQualificationScore, QualificationPhase,
} from '@/types/database';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

interface RankRow {
  user_id: string;
  display_name: string | null;
  game_points: number;
  game_points_base: number;
  qualification_points: number;
  qualification_points_base: number;
  total_points: number;
  games_correct: number;
  qualification_correct: number;
  total_bets: number;
  position: number;
}

interface AdminPickerProfile {
  id: string;
  display_name: string | null;
}

export default async function MeusResultadosPage({
  searchParams,
}: { searchParams: { user?: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?redirectTo=/meus-resultados');

  const { isAdmin } = await requireAdmin();

  // Decide alvo: usuário comum sempre = self. Admin pode passar ?user=<uuid>.
  const targetUserId = isAdmin && searchParams.user ? searchParams.user : user.id;
  const isSelf = targetUserId === user.id;

  // ---------------------------------------------------------------------
  // Carga server-side
  // ---------------------------------------------------------------------
  const [
    matches,
    teams,
    annexC,
    userBets,
    userQuals,
    rankRowsRaw,
    profileRaw,
    adminProfilesRaw,
  ] = await Promise.all([
    fetchAll<Match>((from, to) =>
      supabase.from('matches').select('*').order('id').range(from, to)),
    fetchAll<Team>((from, to) =>
      supabase.from('teams').select('*').range(from, to)),
    fetchAll<AnnexCOption>((from, to) =>
      supabase.from('fifa_annex_c').select('*').range(from, to)),
    // Bets filtradas SEMPRE pelo targetUserId — defesa em profundidade.
    fetchAll<Bet>((from, to) =>
      supabase.from('bets').select('*').eq('user_id', targetUserId).range(from, to)),
    fetchAll<UserQualificationScore>((from, to) =>
      supabase.from('user_qualification_scores').select('*').eq('user_id', targetUserId).range(from, to)),
    fetchAll<RankRow>((from, to) =>
      supabase.from('user_rankings_full').select('*').eq('user_id', targetUserId).range(from, to)),
    supabase.from('profiles').select('id, display_name').eq('id', targetUserId).maybeSingle(),
    // Admin: lista de profiles para o seletor (sem email; email só /admin/usuarios)
    isAdmin
      ? fetchAll<AdminPickerProfile>((from, to) =>
          supabase.from('profiles').select('id, display_name').order('display_name').range(from, to))
      : Promise.resolve([] as AdminPickerProfile[]),
  ]);

  const rank = (rankRowsRaw[0] ?? null) as RankRow | null;
  const profile = (profileRaw.data ?? null) as { id: string; display_name: string | null } | null;
  const adminProfiles = adminProfilesRaw;

  // ---------------------------------------------------------------------
  // Audits por bet — fonte única dos times/status/pontos
  // ---------------------------------------------------------------------
  const teamById = new Map<number, Team>(teams.map(t => [t.id, t]));
  const matchById = new Map<number, Match>(matches.map(m => [m.id, m]));

  // Simulação tolerante apenas para fallback dos times do palpite quando
  // a bet não tem snapshot. Como /meus-resultados é por usuário, é leve.
  const userSim = simulateBracketForUser({
    userBets, allMatches: matches, teams, annexCOptions: annexC,
  });

  const audits: BetAudit[] = userBets
    .map(b => {
      const m = matchById.get(b.match_id);
      if (!m) return null;
      return buildBetAudit({
        bet: b, match: m,
        simulatedMatchesByUser: userSim,
        allMatches: matches, teamById,
      });
    })
    .filter((x): x is BetAudit => x !== null);

  // ---------------------------------------------------------------------
  // Display name & resumo
  // ---------------------------------------------------------------------
  const displayName = profile?.display_name ?? (isSelf ? 'Você' : 'Jogador');

  return (
    <MyResultsView
      isSelf={isSelf}
      isAdmin={isAdmin}
      targetUserId={targetUserId}
      displayName={displayName}
      rank={rank}
      audits={audits}
      userQuals={userQuals as (UserQualificationScore & { phase: QualificationPhase })[]}
      teams={teams}
      adminProfiles={adminProfiles}
    />
  );
}
