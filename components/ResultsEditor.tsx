'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Match, Team } from '@/types/database';
import { TeamNameWithFlag } from './TeamNameWithFlag';
import { getBrtTodayISO, pickInitialDayFromDates } from '@/lib/bolao/matchSchedule';

/** v74 — id estável para a row de cabeçalho de data, usado pelo scroll. */
const dateRowId = (date: string) => `results-date-${date}`;

/** v74 — formata YYYY-MM-DD para "DD/MM/YYYY" sem depender de timezone do client. */
function formatBR(dateISO: string): string {
  const [y, m, d] = dateISO.split('-');
  return `${d}/${m}/${y}`;
}

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

  // v74 — agrupa jogos por data e calcula a data-alvo (hoje BRT / próximo / último).
  const matchesByDate = useMemo(() => {
    const m = new Map<string, Match[]>();
    for (const x of matches) {
      const d = x.match_date;
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(x);
    }
    // Dentro de cada dia: ordena por kickoff_brt, depois por id (estável).
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const k = a.kickoff_brt.localeCompare(b.kickoff_brt);
        if (k !== 0) return k;
        return a.id - b.id;
      });
    }
    return m;
  }, [matches]);

  const sortedDates = useMemo(
    () => [...matchesByDate.keys()].sort(),
    [matchesByDate]
  );

  // Data-alvo do scroll: hoje BRT → próximo → último. Calculada SOMENTE no
  // client (useState com initializer roda lazy) para evitar mismatch SSR.
  const [targetDate] = useState<string>(() =>
    pickInitialDayFromDates(sortedDates, getBrtTodayISO())
  );
  const todayISO = useMemo(() => getBrtTodayISO(), []);
  const isToday = targetDate === todayISO;

  const goToToday = useCallback(() => {
    if (!targetDate || targetDate === 'all') return;
    const el = document.getElementById(dateRowId(targetDate));
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [targetDate]);

  // Scroll automático no mount inicial. Pequeno timeout para garantir que
  // o navegador já tenha layout (algumas vezes scrollIntoView falha sem isso).
  // Roda apenas UMA vez por mount.
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (!targetDate || targetDate === 'all') return;
    didInitialScrollRef.current = true;
    const t = setTimeout(() => {
      const el = document.getElementById(dateRowId(targetDate));
      // Bloco 'start' tende a ficar atrás do header sticky — usamos
      // o scrollIntoView e depois ajustamos margem visual via CSS na row.
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
    return () => clearTimeout(t);
  }, [targetDate]);

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
        {/* v74 — atalho para hoje / próximos jogos */}
        {targetDate && targetDate !== 'all' && (
          <button onClick={goToToday} className="btn-ghost" title={`Ir para ${formatBR(targetDate)}`}>
            📅 Ir para {isToday ? 'hoje' : 'próximos jogos'}
          </button>
        )}
        {status.msg && (
          <div className={`text-sm border rounded px-3 py-2 ${statusCls}`}>{status.msg}</div>
        )}
      </div>

      {/* v74 — dica discreta de uso da nova navegação */}
      {targetDate && targetDate !== 'all' && (
        <p className="text-xs text-gray-600">
          Mostrando lista completa, agrupada por data. Use o botão acima para
          ir direto aos jogos de {isToday ? 'hoje' : `${formatBR(targetDate)} (próximos)`}.
          Você pode rolar livremente para editar jogos anteriores.
        </p>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="spreadsheet-table text-xs">
          <thead>
            <tr>
              <th>#</th><th>Fase</th><th>Data</th><th>Home</th><th>Placar</th>
              <th>Away</th><th>Pen H</th><th>Pen A</th><th>Salvar</th>
            </tr>
          </thead>
          <tbody>
            {sortedDates.map(date => {
              const isTarget = date === targetDate;
              const isPast = date < todayISO;
              const dayMatches = matchesByDate.get(date) ?? [];
              // v74 — destaque sutil na row de data alvo (hoje ou próximos).
              const headerCls = isTarget
                ? 'bg-amber-50 border-y-2 border-amber-400'
                : (isPast ? 'bg-gray-50' : 'bg-blue-50/40');
              return (
                <Fragment key={date}>
                  <tr id={dateRowId(date)} className={headerCls}>
                    <td colSpan={9} className="px-2 py-2">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-bold text-gray-800">📅 {formatBR(date)}</span>
                        <span className="text-xs text-gray-500">·</span>
                        <span className="text-xs text-gray-600">
                          {dayMatches.length} {dayMatches.length === 1 ? 'jogo' : 'jogos'}
                        </span>
                        {isTarget && (
                          <span className="ml-2 text-[10px] font-semibold bg-accent-red text-white px-2 py-0.5 rounded">
                            {isToday ? 'HOJE' : 'PRÓXIMOS JOGOS'}
                          </span>
                        )}
                        {!isTarget && isPast && (
                          <span className="ml-2 text-[10px] text-gray-500">passado</span>
                        )}
                      </div>
                    </td>
                  </tr>
                  {dayMatches.map(m => {
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
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
