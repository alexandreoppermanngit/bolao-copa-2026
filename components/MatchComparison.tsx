'use client';

/**
 * Comparativo por jogo — usa a MESMA FONTE DE VERDADE do ranking:
 *   - bets.points / bets.points_with_zebra (já calculados pelo backend)
 *   - lib/bolao/audit.ts para explicar O PORQUÊ dos pontos
 *
 * Não recalcula pontos no client. Apenas mostra explicação.
 */

import { useMemo, useState } from 'react';
import type { Match, Team, Bet, AnnexCOption } from '@/types/database';
import {
  buildBetAudit, simulateBracketForUser,
  AUDIT_REASON_LABEL, type BetAudit,
} from '@/lib/bolao/audit';
import { TeamNameWithFlag } from './TeamNameWithFlag';

interface Profile { id: string; display_name: string | null; email: string }

interface Props {
  initialMatchId: number;
  matches: Match[];
  teams: Team[];
  bets: Bet[];
  profiles: Profile[];
  annexCOptions: AnnexCOption[];
  isAdmin: boolean;
}

export function MatchComparison({
  initialMatchId, matches, teams, bets, profiles, annexCOptions, isAdmin,
}: Props) {
  const [selectedId, setSelectedId] = useState<number>(initialMatchId);

  const teamById = useMemo(() => new Map(teams.map(t => [t.id, t])), [teams]);
  const profileById = useMemo(() => new Map(profiles.map(p => [p.id, p])), [profiles]);
  const selectedMatch = useMemo(() => matches.find(m => m.id === selectedId), [matches, selectedId]);
  const isKO = selectedMatch && selectedMatch.group_code == null;

  const betsForMatch = useMemo(
    () => bets.filter(b => b.match_id === selectedId),
    [bets, selectedId]
  );

  // Distribuição agregada — só usada na fase de grupos (no KO os times variam)
  const distribution = useMemo(() => {
    const total = betsForMatch.length;
    const home = betsForMatch.filter(b => b.home_score > b.away_score).length;
    const draw = betsForMatch.filter(b => b.home_score === b.away_score).length;
    const away = betsForMatch.filter(b => b.away_score > b.home_score).length;
    return {
      total,
      pctHome: total ? home / total : 0,
      pctDraw: total ? draw / total : 0,
      pctAway: total ? away / total : 0,
    };
  }, [betsForMatch]);

  // Simulações por usuário (necessário para o audit no KO)
  const simByUser = useMemo(() => {
    if (!selectedMatch) return new Map<string, Match[]>();
    if (!isKO) return new Map();  // grupos não precisam de simulação
    const betsByUser = new Map<string, Bet[]>();
    for (const b of bets) {
      if (!betsByUser.has(b.user_id)) betsByUser.set(b.user_id, []);
      betsByUser.get(b.user_id)!.push(b);
    }
    const result = new Map<string, Match[]>();
    for (const [userId, userBets] of betsByUser) {
      result.set(userId, simulateBracketForUser({ userBets, allMatches: matches, teams, annexCOptions }));
    }
    return result;
  }, [selectedMatch, isKO, bets, matches, teams, annexCOptions]);

  // Constrói o audit de cada bet
  const audits = useMemo<BetAudit[]>(() => {
    if (!selectedMatch) return [];
    return betsForMatch.map(b => {
      const userSim = simByUser.get(b.user_id) ?? matches;
      return buildBetAudit({
        bet: b, match: selectedMatch,
        simulatedMatchesByUser: userSim,
        allMatches: matches, teamById,
      });
    });
  }, [betsForMatch, selectedMatch, simByUser, matches, teamById]);

  function teamForOfficialSide(m: Match | undefined, side: 'home'|'away'): Team | null {
    if (!m) return null;
    const id = side === 'home' ? m.home_team_id : m.away_team_id;
    return id ? teamById.get(id) ?? null : null;
  }

  const matchOptions = useMemo(() => matches.map(m => {
    const h = teamById.get(m.home_team_id ?? -1)?.name ?? m.home_placeholder ?? '?';
    const a = teamById.get(m.away_team_id ?? -1)?.name ?? m.away_placeholder ?? '?';
    return { id: m.id, label: `#${m.id} · ${m.phase} · ${h} × ${a}` };
  }), [matches, teamById]);

  return (
    <div className="space-y-4">
      {/* SELETOR */}
      <div className="bg-white rounded-xl p-4 shadow-sm flex items-center gap-3 flex-wrap">
        <label className="font-medium">Selecione o jogo:</label>
        <input type="number" min="1" max="104"
          className="border rounded px-2 py-1 w-24"
          value={selectedId}
          onChange={e => setSelectedId(Math.max(1, Math.min(104, Number(e.target.value) || 1)))}
        />
        <select className="border rounded px-2 py-1 flex-1 min-w-[200px]"
          value={selectedId}
          onChange={e => setSelectedId(Number(e.target.value))}
        >
          {matchOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>

      {!selectedMatch && (
        <div className="bg-white rounded-xl p-6 text-center text-gray-500">Jogo não encontrado.</div>
      )}

      {selectedMatch && (
        <>
          <MatchHeader match={selectedMatch}
            home={teamForOfficialSide(selectedMatch, 'home')}
            away={teamForOfficialSide(selectedMatch, 'away')}
            distribution={distribution}
            isKO={!!isKO}
          />
          <BetsAuditTable audits={audits} profileById={profileById} isAdmin={isAdmin} isKO={!!isKO} />
        </>
      )}
    </div>
  );
}

function MatchHeader({
  match, home, away, distribution, isKO,
}: {
  match: Match; home: Team | null; away: Team | null;
  distribution: { total: number; pctHome: number; pctDraw: number; pctAway: number };
  isKO: boolean;
}) {
  const result = match.home_score != null && match.away_score != null
    ? `${match.home_score} × ${match.away_score}` : 'Aguardando';
  const status = match.home_score != null ? '✅ Concluído' : '⏳ Pendente';

  return (
    <div className="bg-white rounded-xl shadow-sm p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xl font-bold">Jogo #{match.id} · <span className="text-brand-500">{match.phase}</span></h2>
        <span className="text-sm text-gray-600">{status}</span>
      </div>
      <div className="grid sm:grid-cols-3 gap-4 items-center">
        <div className="text-right">
          {home ? <TeamNameWithFlag team={home} size="lg" reverse /> : <span className="text-gray-400">{match.home_placeholder ?? '?'}</span>}
        </div>
        <div className="text-center">
          <div className="text-3xl font-bold font-mono">{result}</div>
          <div className="text-xs text-gray-500 mt-1">
            {match.match_date.slice(8,10)}/{match.match_date.slice(5,7)} · {match.kickoff_brt.slice(0,5)} · {match.venue ?? ''}
          </div>
        </div>
        <div>
          {away ? <TeamNameWithFlag team={away} size="lg" /> : <span className="text-gray-400">{match.away_placeholder ?? '?'}</span>}
        </div>
      </div>

      {/* % de apostas: apenas FASE DE GRUPOS (no KO os times variam por usuário) */}
      {!isKO ? (
        <>
          <div className="grid sm:grid-cols-3 gap-2 mt-5 text-sm">
            <StatBar label="Vitória time 1" pct={distribution.pctHome} color="bg-blue-500" />
            <StatBar label="Empate" pct={distribution.pctDraw} color="bg-gray-500" />
            <StatBar label="Vitória time 2" pct={distribution.pctAway} color="bg-red-500" />
          </div>
          <div className="text-xs text-gray-600 mt-2">{distribution.total} aposta(s) registrada(s)</div>
        </>
      ) : (
        <div className="mt-4 text-xs text-gray-600 italic">
          ℹ️ Em jogos de mata-mata os times variam por simulação. O percentual de vitória por time
          não é exibido — veja a tabela abaixo com o confronto que cada apostador previu.
        </div>
      )}
    </div>
  );
}

function StatBar({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span>{label}</span>
        <span className="font-mono">{(pct * 100).toFixed(0)}%</span>
      </div>
      <div className="bg-gray-200 rounded h-3 overflow-hidden">
        <div className={color} style={{ width: `${pct * 100}%`, height: '100%' }} />
      </div>
    </div>
  );
}

function BetsAuditTable({
  audits, profileById, isAdmin, isKO,
}: {
  audits: BetAudit[];
  profileById: Map<string, Profile>;
  isAdmin: boolean;
  isKO: boolean;
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
      <table className="spreadsheet-table text-xs">
        <thead>
          <tr>
            <th>Usuário</th>
            {isAdmin && <th>Email</th>}
            <th>Time A (palpite)</th>
            <th>Time B (palpite)</th>
            <th>Placar</th>
            <th>Pen</th>
            {isKO && <th>Confronto real</th>}
            <th>Status</th>
            <th>Pts</th>
            <th>Pts Zebra</th>
          </tr>
        </thead>
        <tbody>
          {audits.length === 0 && (
            <tr><td colSpan={isAdmin ? (isKO ? 10 : 9) : (isKO ? 9 : 8)} className="text-center py-6 text-gray-500">
              Nenhuma aposta registrada para este jogo.
            </td></tr>
          )}
          {audits.map(a => {
            const profile = profileById.get(a.bet.user_id);
            const isTie = a.bet.home_score === a.bet.away_score;
            const advLabel = isTie && a.bet.knockout_advancer
              ? (a.bet.knockout_advancer === 'home' ? a.bet_home_team?.name ?? 'home' : a.bet_away_team?.name ?? 'away')
              : '—';
            const reasonLabel = AUDIT_REASON_LABEL[a.reason];
            // Cor de status
            const statusCls =
              a.reason === 'group_stage_direct' ? 'text-gray-700' :
              a.reason === 'ko_match_correct_same_phase' ? 'text-green-700' :
              a.reason === 'ko_match_correct_inverted' ? 'text-blue-700' :
              a.reason === 'ko_match_correct_other_phase' ? 'text-purple-700' :
              a.reason === 'ko_match_not_played' ? 'text-red-700' :
              'text-amber-700';
            return (
              <tr key={a.bet.id}>
                <td>{profile?.display_name ?? profile?.email?.split('@')[0] ?? '?'}</td>
                {isAdmin && <td className="text-xs font-mono">{profile?.email}</td>}
                <td>{a.bet_home_team ? <TeamNameWithFlag team={a.bet_home_team} size="sm" /> : <em className="text-gray-400">—</em>}</td>
                <td>{a.bet_away_team ? <TeamNameWithFlag team={a.bet_away_team} size="sm" /> : <em className="text-gray-400">—</em>}</td>
                <td className="font-mono text-center">{a.bet.home_score} × {a.bet.away_score}</td>
                <td className="text-xs">{advLabel}</td>
                {isKO && (
                  <td className="text-xs">
                    {a.scoring_match ? (
                      <span>
                        #{a.scoring_match.id} ({a.scoring_match.phase})
                        {' '}{a.scoring_home_team?.name ?? '?'} {a.scoring_match.home_score}×{a.scoring_match.away_score} {a.scoring_away_team?.name ?? '?'}
                        {a.inverted && <span className="ml-1 text-blue-600">⇄</span>}
                      </span>
                    ) : <em className="text-gray-400">—</em>}
                  </td>
                )}
                <td className={`text-xs ${statusCls}`}>{reasonLabel}</td>
                <td className="text-center">{a.points}</td>
                <td className="text-center font-semibold">{Number(a.points_with_zebra).toFixed(1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
