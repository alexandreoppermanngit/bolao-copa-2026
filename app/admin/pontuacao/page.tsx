import { createClient, requireAdmin } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import type { Match, Team, Bet, AnnexCOption } from '@/types/database';
import { buildBetAudit, simulateBracketForUser, AUDIT_REASON_LABEL } from '@/lib/bolao/audit';
import { TeamNameWithFlag } from '@/components/TeamNameWithFlag';

export const dynamic = 'force-dynamic';

interface RankRow {
  user_id: string; email: string; display_name: string | null;
  game_points: number; game_points_base: number;
  qualification_points: number; qualification_points_base: number;
  total_points: number; position: number;
}

interface QualRow {
  id: number; user_id: string; phase: string; team_id: number;
  is_correct: boolean; points_base: number; factor: number; points_final: number;
}

export default async function AdminPontuacaoPage({ searchParams }: { searchParams: { user?: string } }) {
  const { isAdmin } = await requireAdmin();
  if (!isAdmin) redirect('/');

  const supabase = createClient();
  const [{ data: rank }, { data: teamsRaw }] = await Promise.all([
    supabase.from('user_rankings_full').select('*').order('position'),
    supabase.from('teams').select('*'),
  ]);
  const teams = (teamsRaw ?? []) as Team[];
  const teamById = new Map(teams.map(t => [t.id, t]));

  type PickedProfile = { display_name: string | null; email: string } | null;
  const filterUserId = searchParams.user;
  let pickedProfile: PickedProfile = null;
  let userQuals: QualRow[] = [];
  let auditRows: ReturnType<typeof buildBetAudit>[] = [];

  if (filterUserId) {
    const [qRes, bRes, pRes, mRes, , annexRes] = await Promise.all([
      supabase.from('user_qualification_scores').select('*').eq('user_id', filterUserId).order('phase'),
      supabase.from('bets').select('*').eq('user_id', filterUserId).order('match_id'),
      supabase.from('profiles').select('display_name, email').eq('id', filterUserId).maybeSingle(),
      supabase.from('matches').select('*').order('id'),
      supabase.from('bets').select('*').eq('user_id', filterUserId),
      supabase.from('fifa_annex_c').select('*'),
    ]);
    userQuals = (qRes.data ?? []) as QualRow[];
    pickedProfile = (pRes.data ?? null) as PickedProfile;
    const userBets = (bRes.data ?? []) as Bet[];
    const allMatches = (mRes.data ?? []) as Match[];
    const annexC = (annexRes.data ?? []) as AnnexCOption[];

    // Simula bracket do usuário e gera audit para cada bet
    const userSim = simulateBracketForUser({ userBets, allMatches, teams, annexCOptions: annexC });
    const matchById = new Map(allMatches.map(m => [m.id, m]));
    auditRows = userBets
      .map(b => {
        const m = matchById.get(b.match_id);
        if (!m) return null;
        return buildBetAudit({ bet: b, match: m, simulatedMatchesByUser: userSim, allMatches, teamById });
      })
      .filter(Boolean) as ReturnType<typeof buildBetAudit>[];
  }

  return (
    <div className="space-y-4">
      <div className="bg-accent-red text-white rounded-xl p-4">
        <h1 className="text-2xl font-bold">📊 Auditoria de Pontuação</h1>
        <p className="text-sm mt-1 opacity-90">
          Clique num usuário para detalhar. A pontuação exibida usa a MESMA fonte do ranking
          (bets.points / points_with_zebra) e o motivo é determinado pelo confronto previsto
          vs. confronto real (incluindo mando invertido e confronto em outra fase).
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="spreadsheet-table text-xs">
          <thead>
            <tr>
              <th>Pos</th><th>Usuário</th><th>Email</th>
              <th className="text-right">Pts Jogos</th>
              <th className="text-right">Pts Classif.</th>
              <th className="text-right">Total</th>
              <th>Detalhar</th>
            </tr>
          </thead>
          <tbody>
            {((rank ?? []) as RankRow[]).map(r => (
              <tr key={r.user_id} className={filterUserId === r.user_id ? 'bg-yellow-50' : ''}>
                <td className="text-center font-bold">{r.position}</td>
                <td>{r.display_name ?? r.email.split('@')[0]}</td>
                <td className="font-mono">{r.email}</td>
                <td className="text-right font-mono">{Number(r.game_points).toFixed(1)}</td>
                <td className="text-right font-mono">{Number(r.qualification_points).toFixed(1)}</td>
                <td className="text-right font-mono font-bold">{Number(r.total_points).toFixed(1)}</td>
                <td><a className="text-brand-500 underline" href={`/admin/pontuacao?user=${r.user_id}`}>Ver →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filterUserId && (
        <div className="space-y-3">
          <div className="bg-brand-50 border border-brand-100 rounded-xl p-4">
            <h2 className="text-lg font-bold">📋 Detalhamento — {pickedProfile?.display_name ?? pickedProfile?.email}</h2>
            <p className="text-xs text-gray-600 mt-1">Email: {pickedProfile?.email ?? '—'}</p>
          </div>

          <div className="bg-white rounded-xl shadow-sm p-4 overflow-x-auto">
            <h3 className="font-semibold mb-2">Pontuação por Classificação de Seleções</h3>
            <table className="spreadsheet-table text-xs w-full">
              <thead>
                <tr><th>Fase</th><th>Seleção</th><th>Acertou?</th><th>Base</th><th>Fator</th><th>Pts Finais</th></tr>
              </thead>
              <tbody>
                {userQuals.length === 0 && (
                  <tr><td colSpan={6} className="text-center py-3 text-gray-500">Sem pontuação de classificação ainda.</td></tr>
                )}
                {userQuals.map(q => {
                  const t = teamById.get(q.team_id);
                  return (
                    <tr key={q.id}>
                      <td>{q.phase}</td>
                      <td>{t ? <TeamNameWithFlag team={t} size="sm" /> : `#${q.team_id}`}</td>
                      <td className="text-center">{q.is_correct ? '✅' : '❌'}</td>
                      <td className="text-right">{q.points_base}</td>
                      <td className="text-right">{(1 + Number(q.factor)).toFixed(3)}×</td>
                      <td className="text-right font-bold">{Number(q.points_final).toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-xl shadow-sm p-4 overflow-x-auto">
            <h3 className="font-semibold mb-2">Pontuação por Jogo — auditoria completa</h3>
            <table className="spreadsheet-table text-xs w-full">
              <thead>
                <tr>
                  <th>#</th><th>Fase</th>
                  <th>Time A (palpite)</th><th>Time B (palpite)</th>
                  <th>Placar</th><th>Pen</th>
                  <th>Confronto real</th>
                  <th>Mando invert.?</th>
                  <th>Motivo</th>
                  <th>Pts</th><th>Pts c/ Zebra</th>
                </tr>
              </thead>
              <tbody>
                {auditRows.map(a => {
                  const isTie = a.bet.home_score === a.bet.away_score;
                  const adv = isTie && a.bet.knockout_advancer
                    ? (a.bet.knockout_advancer === 'home'
                       ? a.bet_home_team?.name ?? 'home'
                       : a.bet_away_team?.name ?? 'away')
                    : '—';
                  return (
                    <tr key={a.bet.id}>
                      <td>#{a.bet.match_id}</td>
                      <td>{a.match.phase}</td>
                      <td>{a.bet_home_team ? <TeamNameWithFlag team={a.bet_home_team} size="sm" /> : <em className="text-gray-400">—</em>}</td>
                      <td>{a.bet_away_team ? <TeamNameWithFlag team={a.bet_away_team} size="sm" /> : <em className="text-gray-400">—</em>}</td>
                      <td className="font-mono text-center">{a.bet.home_score} × {a.bet.away_score}</td>
                      <td className="text-xs">{adv}</td>
                      <td className="text-xs">
                        {a.scoring_match ? (
                          <>
                            #{a.scoring_match.id} <span className="text-gray-500">({a.scoring_match.phase})</span>{' '}
                            {a.scoring_home_team?.name ?? '?'} {a.scoring_match.home_score}×{a.scoring_match.away_score} {a.scoring_away_team?.name ?? '?'}
                          </>
                        ) : <em className="text-gray-400">—</em>}
                      </td>
                      <td className="text-center">{a.inverted ? '⇄' : '—'}</td>
                      <td className="text-xs">{AUDIT_REASON_LABEL[a.reason]}</td>
                      <td className="text-right">{a.points}</td>
                      <td className="text-right font-bold">{Number(a.points_with_zebra).toFixed(1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
