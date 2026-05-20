'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Match, Team } from '@/types/database';
import { TeamNameWithFlag } from './TeamNameWithFlag';

interface Props {
  matches: Match[];
  teams: Team[];
  /**
   * Se true, exibe o botão "Resetar todos os placares" (admin completo).
   * Se false/omit, oculta o botão — editor de resultados não pode resetar.
   * (Backend também valida via requireAdmin em /api/results/reset.)
   */
  canResetAll?: boolean;
}

type Editing = { h: string; a: string; hp: string; ap: string };

async function safeJsonFetch<T = unknown>(
  url: string, init?: RequestInit
): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  let res: Response;
  try { res = await fetch(url, init); }
  catch (e) { return { ok: false, status: 0, data: null, error: `Rede: ${(e as Error).message}` }; }
  const text = await res.text();
  let data: unknown = null;
  if (text) { try { data = JSON.parse(text); } catch {} }
  if (!res.ok) {
    const errMsg = (data as { error?: string } | null)?.error ?? text?.slice(0, 200) ?? `HTTP ${res.status}`;
    return { ok: false, status: res.status, data: data as T | null, error: errMsg };
  }
  return { ok: true, status: res.status, data: data as T | null, error: null };
}

export function ResultsEditor({ matches, teams, canResetAll = false }: Props) {
  const router = useRouter();
  const teamById = useMemo(() => new Map(teams.map(t => [t.id, t])), [teams]);
  const initial: Map<number, Editing> = useMemo(() => {
    const m = new Map<number, Editing>();
    for (const x of matches) {
      m.set(x.id, {
        h: x.home_score?.toString() ?? '',
        a: x.away_score?.toString() ?? '',
        hp: x.home_pens?.toString() ?? '',
        ap: x.away_pens?.toString() ?? '',
      });
    }
    return m;
  }, [matches]);
  const [editing, setEditing] = useState<Map<number, Editing>>(initial);
  const [dirty, setDirty] = useState<Set<number>>(new Set());

  const [status, setStatus] = useState<{ kind: 'idle'|'ok'|'err'; msg: string }>({ kind: 'idle', msg: '' });
  const [saving, setSaving] = useState<number | null>(null);
  const [bulkSaving, setBulkSaving] = useState<'idle'|'batch'|'recalc'|'reset'>('idle');

  function markDirty(id: number) {
    setDirty(prev => { const n = new Set(prev); n.add(id); return n; });
  }

  async function saveOne(matchId: number) {
    const v = editing.get(matchId);
    if (!v) return;
    setSaving(matchId); setStatus({ kind: 'idle', msg: '' });
    const result = await safeJsonFetch<{ success: boolean; updated?: number; error?: string }>(
      '/api/results',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          match_id: matchId,
          home_score: v.h === '' ? null : Number(v.h),
          away_score: v.a === '' ? null : Number(v.a),
          home_pens:  v.hp === '' ? null : Number(v.hp),
          away_pens:  v.ap === '' ? null : Number(v.ap),
        }),
      }
    );
    setSaving(null);
    if (result.ok && result.data?.success) {
      setStatus({ kind: 'ok', msg: `✓ Jogo #${matchId} salvo. ${result.data.updated ?? 0} aposta(s) recalculada(s).` });
      setDirty(p => { const n = new Set(p); n.delete(matchId); return n; });
      router.refresh();
    } else {
      setStatus({ kind: 'err', msg: `Erro ao salvar #${matchId}: ${result.error ?? 'desconhecido'}` });
    }
  }

  async function saveBatch() {
    if (dirty.size === 0) {
      setStatus({ kind: 'err', msg: 'Nenhuma alteração para salvar' });
      return;
    }
    setBulkSaving('batch'); setStatus({ kind: 'idle', msg: `Salvando ${dirty.size} jogo(s) em lote…` });
    const payload = Array.from(dirty).map(id => {
      const v = editing.get(id)!;
      return {
        match_id: id,
        home_score: v.h === '' ? null : Number(v.h),
        away_score: v.a === '' ? null : Number(v.a),
        home_pens:  v.hp === '' ? null : Number(v.hp),
        away_pens:  v.ap === '' ? null : Number(v.ap),
      };
    });
    const result = await safeJsonFetch<{ success: boolean; message?: string; saved?: number; failures?: { match_id: number; error: string }[]; error?: string }>(
      '/api/results/batch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results: payload }),
      }
    );
    setBulkSaving('idle');
    if (result.ok && result.data?.success) {
      const failures = result.data.failures ?? [];
      if (failures.length > 0) {
        setStatus({
          kind: 'err',
          msg: `Salvou ${result.data.saved}, mas falharam ${failures.length}: ` +
               failures.slice(0, 3).map(f => `#${f.match_id}(${f.error})`).join(', '),
        });
      } else {
        setStatus({ kind: 'ok', msg: `✓ ${result.data.message}` });
        setDirty(new Set());
      }
      router.refresh();
    } else {
      setStatus({ kind: 'err', msg: `Erro: ${result.error ?? 'falha'}` });
    }
  }

  async function recalcAll() {
    setBulkSaving('recalc'); setStatus({ kind: 'idle', msg: 'Recalculando tudo…' });
    const result = await safeJsonFetch<{ success: boolean; message?: string; error?: string }>(
      '/api/recalc', { method: 'POST' }
    );
    setBulkSaving('idle');
    if (result.ok && result.data?.success) {
      setStatus({ kind: 'ok', msg: `✓ ${result.data.message ?? 'recálculo completo'}` });
      router.refresh();
    } else {
      setStatus({ kind: 'err', msg: `Erro: ${result.error ?? 'falha'}` });
    }
  }

  async function resetAll() {
    const ok = window.confirm(
      'TEM CERTEZA?\n\nIsto apagará TODOS os placares reais e zerará a pontuação calculada.\n\n' +
      'As apostas dos usuários NÃO serão apagadas.\n\nContinuar?'
    );
    if (!ok) return;
    const ok2 = window.confirm('Última confirmação: digite OK no próximo passo apenas se tiver certeza.');
    if (!ok2) return;
    setBulkSaving('reset'); setStatus({ kind: 'idle', msg: 'Resetando placares e pontos…' });
    const result = await safeJsonFetch<{ success: boolean; message?: string; error?: string }>(
      '/api/results/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET_ALL_RESULTS' }),
      }
    );
    setBulkSaving('idle');
    if (result.ok && result.data?.success) {
      setStatus({ kind: 'ok', msg: `✓ ${result.data.message}` });
      setDirty(new Set());
      // Limpar editing local
      const cleared: Map<number, Editing> = new Map();
      for (const id of editing.keys()) cleared.set(id, { h: '', a: '', hp: '', ap: '' });
      setEditing(cleared);
      router.refresh();
    } else {
      setStatus({ kind: 'err', msg: `Erro: ${result.error ?? 'falha'}` });
    }
  }

  const statusCls =
    status.kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800' :
    status.kind === 'err' ? 'bg-red-50 border-red-200 text-red-800' :
    'bg-yellow-50 border-yellow-200 text-yellow-900';

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={saveBatch} disabled={bulkSaving !== 'idle' || dirty.size === 0} className="btn-primary">
          {bulkSaving === 'batch' ? '⏳ Salvando…' : `💾 Salvar todos (${dirty.size})`}
        </button>
        <button onClick={recalcAll} disabled={bulkSaving !== 'idle'} className="btn-ghost">
          {bulkSaving === 'recalc' ? '⏳ Recalculando…' : '🔄 Recalcular tudo'}
        </button>
        {canResetAll && (
          <button onClick={resetAll} disabled={bulkSaving !== 'idle'} className="btn-danger">
            {bulkSaving === 'reset' ? '⏳ Resetando…' : '🗑️ Resetar todos os placares'}
          </button>
        )}
        {status.msg && (
          <div className={`text-sm border rounded px-3 py-2 ${statusCls}`}>{status.msg}</div>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="spreadsheet-table text-xs">
          <thead>
            <tr>
              <th>#</th><th>Fase</th><th>Data</th><th>Home</th><th>Placar</th>
              <th>Away</th><th>Pen H</th><th>Pen A</th><th>Salvar</th>
            </tr>
          </thead>
          <tbody>
            {matches.map(m => {
              const homeTeam = m.home_team_id ? teamById.get(m.home_team_id) ?? null : null;
              const awayTeam = m.away_team_id ? teamById.get(m.away_team_id) ?? null : null;
              const v = editing.get(m.id)!;
              const isKO = m.group_code == null;
              const isDirty = dirty.has(m.id);
              return (
                <tr key={m.id} className={isDirty ? 'bg-yellow-50' : ''}>
                  <td>{m.id}</td>
                  <td>{m.phase}</td>
                  <td>{m.match_date.slice(5, 10)} {m.kickoff_brt.slice(0, 5)}</td>
                  <td className="text-right">
                    {homeTeam ? <TeamNameWithFlag team={homeTeam} reverse size="sm" /> : <span className="text-gray-400 italic">{m.home_placeholder ?? '?'}</span>}
                  </td>
                  <td>
                    <input className="score-input" type="number" min="0" value={v.h}
                      onChange={e => { setEditing(p => new Map(p).set(m.id, { ...v, h: e.target.value })); markDirty(m.id); }} />
                    {' × '}
                    <input className="score-input" type="number" min="0" value={v.a}
                      onChange={e => { setEditing(p => new Map(p).set(m.id, { ...v, a: e.target.value })); markDirty(m.id); }} />
                  </td>
                  <td>
                    {awayTeam ? <TeamNameWithFlag team={awayTeam} size="sm" /> : <span className="text-gray-400 italic">{m.away_placeholder ?? '?'}</span>}
                  </td>
                  <td>{isKO && (
                    <input className="score-input" type="number" min="0" value={v.hp}
                      onChange={e => { setEditing(p => new Map(p).set(m.id, { ...v, hp: e.target.value })); markDirty(m.id); }} />
                  )}</td>
                  <td>{isKO && (
                    <input className="score-input" type="number" min="0" value={v.ap}
                      onChange={e => { setEditing(p => new Map(p).set(m.id, { ...v, ap: e.target.value })); markDirty(m.id); }} />
                  )}</td>
                  <td>
                    <button className="btn-ghost text-xs" disabled={saving === m.id} onClick={() => saveOne(m.id)}>
                      {saving === m.id ? '⏳' : (isDirty ? '💾*' : '💾')}
                    </button>
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
