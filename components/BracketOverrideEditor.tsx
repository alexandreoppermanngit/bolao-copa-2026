'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Match, Team, BracketOverride } from '@/types/database';
import { TeamNameWithFlag } from './TeamNameWithFlag';

interface Props {
  matches: Match[];
  teams: Team[];
  overrides: BracketOverride[];
}

export function BracketOverrideEditor({ matches, teams, overrides }: Props) {
  const router = useRouter();
  const teamById = useMemo(() => new Map(teams.map(t => [t.id, t])), [teams]);
  const overrideMap = useMemo(() => {
    const m = new Map<string, BracketOverride>();
    for (const o of overrides) m.set(`${o.match_id}:${o.side}`, o);
    return m;
  }, [overrides]);

  const koMatches = useMemo(
    () => matches.filter(m => !m.group_code).sort((a, b) => a.id - b.id),
    [matches]
  );

  const [status, setStatus] = useState<{ kind: 'idle'|'ok'|'err'; msg: string }>({ kind: 'idle', msg: '' });
  const [saving, setSaving] = useState<string | null>(null);

  async function saveOverride(matchId: number, side: 'home'|'away', teamId: number | null, reason: string) {
    setSaving(`${matchId}:${side}`);
    setStatus({ kind: 'idle', msg: 'Salvando…' });
    try {
      const res = await fetch('/api/bracket-overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_id: matchId, side, team_id: teamId, reason }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) {
        setStatus({ kind: 'err', msg: `Erro: ${j?.error ?? 'falha'}` });
      } else {
        setStatus({ kind: 'ok', msg: '✓ Override aplicado + recálculo completo' });
        router.refresh();
      }
    } catch (e) {
      setStatus({ kind: 'err', msg: `Erro: ${(e as Error).message}` });
    } finally {
      setSaving(null);
    }
  }

  async function clearOverride(id: number) {
    setSaving(`del:${id}`);
    try {
      const res = await fetch(`/api/bracket-overrides?id=${id}`, { method: 'DELETE' });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) setStatus({ kind: 'err', msg: `Erro: ${j?.error ?? 'falha'}` });
      else { setStatus({ kind: 'ok', msg: '✓ Override removido' }); router.refresh(); }
    } finally { setSaving(null); }
  }

  const statusCls =
    status.kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800' :
    status.kind === 'err' ? 'bg-red-50 border-red-200 text-red-800' :
    'bg-yellow-50 border-yellow-200 text-yellow-900';

  return (
    <div className="space-y-4">
      {status.msg && (
        <div className={`text-sm border rounded px-3 py-2 ${statusCls}`}>{status.msg}</div>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="spreadsheet-table text-xs">
          <thead>
            <tr>
              <th>#</th><th>Fase</th><th>Home (calculado)</th><th>Home (override)</th>
              <th>Away (calculado)</th><th>Away (override)</th>
            </tr>
          </thead>
          <tbody>
            {koMatches.map(m => {
              const homeOv = overrideMap.get(`${m.id}:home`);
              const awayOv = overrideMap.get(`${m.id}:away`);
              const homeTeam = m.home_team_id ? teamById.get(m.home_team_id) : null;
              const awayTeam = m.away_team_id ? teamById.get(m.away_team_id) : null;
              return (
                <tr key={m.id}>
                  <td>{m.id}</td>
                  <td>{m.phase}</td>
                  <td>{homeTeam ? <TeamNameWithFlag team={homeTeam} size="sm" /> : <em className="text-gray-400">—</em>}</td>
                  <td>
                    <OverrideSelect
                      currentTeamId={homeOv?.team_id ?? null}
                      teams={teams}
                      isOverridden={!!homeOv}
                      onApply={(teamId, reason) => saveOverride(m.id, 'home', teamId, reason)}
                      onClear={homeOv ? () => clearOverride(homeOv.id) : undefined}
                      busy={saving === `${m.id}:home` || (homeOv ? saving === `del:${homeOv.id}` : false)}
                    />
                  </td>
                  <td>{awayTeam ? <TeamNameWithFlag team={awayTeam} size="sm" /> : <em className="text-gray-400">—</em>}</td>
                  <td>
                    <OverrideSelect
                      currentTeamId={awayOv?.team_id ?? null}
                      teams={teams}
                      isOverridden={!!awayOv}
                      onApply={(teamId, reason) => saveOverride(m.id, 'away', teamId, reason)}
                      onClear={awayOv ? () => clearOverride(awayOv.id) : undefined}
                      busy={saving === `${m.id}:away` || (awayOv ? saving === `del:${awayOv.id}` : false)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OverrideSelect({
  currentTeamId, teams, isOverridden, onApply, onClear, busy,
}: {
  currentTeamId: number | null;
  teams: Team[];
  isOverridden: boolean;
  onApply: (teamId: number | null, reason: string) => void;
  onClear?: () => void;
  busy?: boolean;
}) {
  const [picked, setPicked] = useState<string>(currentTeamId?.toString() ?? '');
  const [reason, setReason] = useState<string>('');
  return (
    <div className="flex items-center gap-1">
      <select className="border rounded px-1 text-xs"
        value={picked}
        onChange={e => setPicked(e.target.value)}
        disabled={busy}
      >
        <option value="">— manter cálculo —</option>
        {teams.map(t => (
          <option key={t.id} value={t.id}>{t.name} ({t.group_code})</option>
        ))}
      </select>
      <input className="border rounded px-1 text-xs w-24" placeholder="motivo"
        value={reason}
        onChange={e => setReason(e.target.value)}
        disabled={busy}
      />
      <button className="btn-ghost text-xs"
        disabled={busy}
        onClick={() => onApply(picked ? Number(picked) : null, reason)}>
        {busy ? '…' : (isOverridden ? '↻' : '💾')}
      </button>
      {isOverridden && onClear && (
        <button className="btn-danger text-xs" disabled={busy} onClick={onClear}>✕</button>
      )}
      {isOverridden && <span className="text-amber-600 text-xs">●</span>}
    </div>
  );
}
