'use client';

/**
 * Tabela admin de apostas com filtros + simulação por usuário no mata-mata.
 *
 * IMPORTANTE: para jogos KO, os times exibidos são os que CHEGARAM ao jogo
 * **na simulação daquele usuário** (porque cada apostador tem uma árvore
 * diferente). Usa `simulateBracket` da lib bolao para calcular em memória.
 *
 * Filtros: usuário, e-mail, jogo, fase, seleção, com/sem resultado.
 * Export: CSV via data URI (não quebra a página se falhar).
 */

import { useMemo, useState } from 'react';
import type {
  Bet, Match, Team, AnnexCOption, MatchPhase,
} from '@/types/database';
import {
  computeGroupStandings, computeThirdPlaceRanking, sortedKeyOfQualifyingThirds,
  areAllGroupsMature,
} from '@/lib/bolao/standings';
import {
  findAnnexCOption, simulateBracket,
  type KoTiebreakHint,
} from '@/lib/bolao/bracket';
import { TeamNameWithFlag } from './TeamNameWithFlag';

interface Profile { id: string; display_name: string | null; email: string }

interface Props {
  bets: Bet[];
  profiles: Profile[];
  matches: Match[];
  teams: Team[];
  annexCOptions: AnnexCOption[];
}

const PHASES: { value: 'all' | MatchPhase; label: string }[] = [
  { value: 'all', label: 'Todas as fases' },
  { value: 'group_stage_1', label: '1ª rodada (grupos)' },
  { value: 'group_stage_2', label: '2ª rodada (grupos)' },
  { value: 'group_stage_3', label: '3ª rodada (grupos)' },
  { value: 'round_of_32', label: '16-avos' },
  { value: 'round_of_16', label: 'Oitavas' },
  { value: 'quarter_finals', label: 'Quartas' },
  { value: 'semi_finals', label: 'Semifinais' },
  { value: 'third_place', label: '3º lugar' },
  { value: 'final', label: 'Final' },
];

export function BetsAdminTable({ bets, profiles, matches, teams, annexCOptions }: Props) {
  // Filtros
  const [filterUser, setFilterUser] = useState('');
  const [filterEmail, setFilterEmail] = useState('');
  const [filterMatchId, setFilterMatchId] = useState<string>('');
  const [filterPhase, setFilterPhase] = useState<'all' | MatchPhase>('all');
  const [filterTeam, setFilterTeam] = useState('');
  const [filterResult, setFilterResult] = useState<'all' | 'with' | 'without'>('all');

  // Indexes
  const matchById = useMemo(() => new Map(matches.map(m => [m.id, m])), [matches]);
  const teamById = useMemo(() => new Map(teams.map(t => [t.id, t])), [teams]);
  const profileById = useMemo(() => new Map(profiles.map(p => [p.id, p])), [profiles]);

  // Bets agrupadas por usuário
  const betsByUser = useMemo(() => {
    const m = new Map<string, Map<number, Bet>>();
    for (const b of bets) {
      if (!m.has(b.user_id)) m.set(b.user_id, new Map());
      m.get(b.user_id)!.set(b.match_id, b);
    }
    return m;
  }, [bets]);

  /**
   * Para cada usuário, simulamos o bracket UMA VEZ e cachamos.
   * Retorna Map<user_id, Map<match_id, {home, away}>> com times simulados.
   */
  const simByUser = useMemo(() => {
    const result = new Map<string, Map<number, { home: Team | null; away: Team | null }>>();
    for (const [userId, userBets] of betsByUser) {
      const teamsForMatch = new Map<number, { home: Team | null; away: Team | null }>();
      // Para grupos, times são os oficiais
      for (const m of matches) {
        if (m.group_code) {
          teamsForMatch.set(m.id, {
            home: m.home_team_id ? teamById.get(m.home_team_id) ?? null : null,
            away: m.away_team_id ? teamById.get(m.away_team_id) ?? null : null,
          });
        }
      }
      // Aplica palpites do usuário
      const localMatches = matches.map(m => {
        const ub = userBets.get(m.id);
        if (ub) return { ...m, home_score: ub.home_score, away_score: ub.away_score };
        return m;
      });
      if (areAllGroupsMature(localMatches)) {
        const standings = computeGroupStandings(teams, localMatches);
        const thirds = computeThirdPlaceRanking(standings);
        const key = sortedKeyOfQualifyingThirds(thirds);
        const opt = key.length === 8 ? findAnnexCOption(key, annexCOptions) : null;
        const hints = new Map<number, KoTiebreakHint>();
        for (const b of userBets.values()) {
          if (b.knockout_advancer) hints.set(b.match_id, { knockout_advancer: b.knockout_advancer });
        }
        const resolved = simulateBracket(localMatches, teams, standings, thirds, opt, hints);
        for (const m of resolved) {
          if (m.group_code) continue;
          teamsForMatch.set(m.id, {
            home: m.home_team_id ? teamById.get(m.home_team_id) ?? null : null,
            away: m.away_team_id ? teamById.get(m.away_team_id) ?? null : null,
          });
        }
      } else {
        // KO sem maturidade → times vazios
        for (const m of matches) {
          if (!m.group_code) teamsForMatch.set(m.id, { home: null, away: null });
        }
      }
      result.set(userId, teamsForMatch);
    }
    return result;
  }, [betsByUser, matches, teamById, teams, annexCOptions]);

  // Aplicar filtros
  const filtered = useMemo(() => {
    return bets.filter(b => {
      const profile = profileById.get(b.user_id);
      const m = matchById.get(b.match_id);
      if (!m || !profile) return false;
      if (filterUser && !(profile.display_name ?? '').toLowerCase().includes(filterUser.toLowerCase())) return false;
      if (filterEmail && !profile.email.toLowerCase().includes(filterEmail.toLowerCase())) return false;
      if (filterMatchId && b.match_id !== Number(filterMatchId)) return false;
      if (filterPhase !== 'all' && m.phase !== filterPhase) return false;
      if (filterResult === 'with' && m.home_score == null) return false;
      if (filterResult === 'without' && m.home_score != null) return false;
      if (filterTeam) {
        const sim = simByUser.get(b.user_id)?.get(b.match_id);
        const h = sim?.home?.name ?? '';
        const a = sim?.away?.name ?? '';
        if (!h.toLowerCase().includes(filterTeam.toLowerCase())
            && !a.toLowerCase().includes(filterTeam.toLowerCase())) return false;
      }
      return true;
    });
  }, [bets, profileById, matchById, simByUser, filterUser, filterEmail, filterMatchId, filterPhase, filterTeam, filterResult]);

  // CSV
  function downloadCSV() {
    const lines = [
      'user_name,user_email,match_id,phase,team_a,team_b,home_score,away_score,knockout_advancer,real_home,real_away,points,points_with_zebra,updated_at',
    ];
    for (const b of filtered) {
      const p = profileById.get(b.user_id);
      const m = matchById.get(b.match_id);
      const sim = simByUser.get(b.user_id)?.get(b.match_id);
      const ta = sim?.home?.name ?? m?.home_placeholder ?? '';
      const tb = sim?.away?.name ?? m?.away_placeholder ?? '';
      lines.push([
        (p?.display_name ?? '').replace(/,/g, ' '),
        p?.email ?? '',
        b.match_id,
        m?.phase ?? '',
        ta.replace(/,/g, ' '),
        tb.replace(/,/g, ' '),
        b.home_score,
        b.away_score,
        b.knockout_advancer ?? '',
        m?.home_score ?? '',
        m?.away_score ?? '',
        b.points,
        b.points_with_zebra,
        b.updated_at ?? '',
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apostas-bolao-2026-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {/* FILTROS */}
      <div className="bg-white rounded-xl shadow-sm p-4 grid sm:grid-cols-3 md:grid-cols-6 gap-3 text-sm">
        <input className="border rounded px-2 py-1" placeholder="Filtrar por nome..." value={filterUser} onChange={e => setFilterUser(e.target.value)} />
        <input className="border rounded px-2 py-1" placeholder="Filtrar por e-mail..." value={filterEmail} onChange={e => setFilterEmail(e.target.value)} />
        <input type="number" min="1" max="104" className="border rounded px-2 py-1" placeholder="Jogo #" value={filterMatchId} onChange={e => setFilterMatchId(e.target.value)} />
        <select className="border rounded px-2 py-1" value={filterPhase} onChange={e => setFilterPhase(e.target.value as 'all' | MatchPhase)}>
          {PHASES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <input className="border rounded px-2 py-1" placeholder="Filtrar por seleção..." value={filterTeam} onChange={e => setFilterTeam(e.target.value)} />
        <select className="border rounded px-2 py-1" value={filterResult} onChange={e => setFilterResult(e.target.value as 'all'|'with'|'without')}>
          <option value="all">Todos jogos</option>
          <option value="with">Com resultado oficial</option>
          <option value="without">Sem resultado oficial</option>
        </select>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-700">
          <strong>{filtered.length}</strong> aposta(s) após filtros · de {bets.length} total
        </div>
        <button onClick={downloadCSV} className="btn-ghost text-sm">⬇️ Exportar CSV</button>
      </div>

      {/* TABELA */}
      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="spreadsheet-table text-xs">
          <thead>
            <tr>
              <th>Usuário</th>
              <th>Email</th>
              <th>#</th>
              <th>Fase</th>
              <th>Time A</th>
              <th>Time B</th>
              <th>Palpite</th>
              <th>Pen</th>
              <th>Resultado</th>
              <th>Pts</th>
              <th>Pts Zebra</th>
              <th>Atualizado</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={12} className="text-center py-6 text-gray-500">Nenhuma aposta encontrada com esses filtros.</td></tr>
            )}
            {filtered.slice(0, 2000).map(b => {
              const p = profileById.get(b.user_id);
              const m = matchById.get(b.match_id);
              const sim = simByUser.get(b.user_id)?.get(b.match_id);
              const home = sim?.home ?? null;
              const away = sim?.away ?? null;
              const isTie = b.home_score === b.away_score;
              const advLabel = isTie && b.knockout_advancer
                ? (b.knockout_advancer === 'home' ? (home?.name ?? 'home') : (away?.name ?? 'away'))
                : '—';
              const realScore = m?.home_score != null && m?.away_score != null
                ? `${m.home_score} × ${m.away_score}` : '—';
              return (
                <tr key={b.id}>
                  <td>{p?.display_name ?? p?.email?.split('@')[0]}</td>
                  <td className="font-mono">{p?.email}</td>
                  <td>{b.match_id}</td>
                  <td>{m?.phase}</td>
                  <td>
                    {home ? <TeamNameWithFlag team={home} size="sm" />
                          : <span className="text-gray-400 italic">{m?.home_placeholder ?? '—'}</span>}
                  </td>
                  <td>
                    {away ? <TeamNameWithFlag team={away} size="sm" />
                          : <span className="text-gray-400 italic">{m?.away_placeholder ?? '—'}</span>}
                  </td>
                  <td className="font-mono text-center">{b.home_score} × {b.away_score}</td>
                  <td>{advLabel}</td>
                  <td className="font-mono text-center">{realScore}</td>
                  <td className="text-center">{b.points}</td>
                  <td className="text-center font-semibold">{Number(b.points_with_zebra).toFixed(1)}</td>
                  <td className="text-xs">{b.updated_at ? new Date(b.updated_at).toLocaleString('pt-BR') : '—'}</td>
                </tr>
              );
            })}
            {filtered.length > 2000 && (
              <tr><td colSpan={12} className="text-center py-3 text-gray-500 italic">… exibindo as primeiras 2000 de {filtered.length}. Use filtros para refinar.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
