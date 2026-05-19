'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Settings } from '@/types/database';

/**
 * Converte ISO timestamp (UTC) em string aceita pelo input type="datetime-local"
 * (YYYY-MM-DDTHH:MM no fuso LOCAL do usuário).
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const QUAL_DEFAULTS: Record<string, number> = {
  pts_qual_groups: 10,
  pts_qual_r32: 12,
  pts_qual_r16: 15,
  pts_qual_quarters: 25,
  pts_qual_semis: 30,
  pts_qual_third: 30,
  pts_qual_champion: 40,
};

const QUAL_LABELS: Record<string, string> = {
  pts_qual_groups: 'Classificados da fase de grupos',
  pts_qual_r32: 'Vencedores das 16-avos',
  pts_qual_r16: 'Vencedores das oitavas',
  pts_qual_quarters: 'Vencedores das quartas',
  pts_qual_semis: 'Finalistas (vencedores das semis)',
  pts_qual_third: 'Terceiro lugar',
  pts_qual_champion: 'Campeão',
};

export function SettingsForm({ settings }: { settings: Settings | null }) {
  const router = useRouter();
  const [s, setS] = useState<Partial<Settings>>(settings ?? {});
  const [status, setStatus] = useState<{ kind: 'idle'|'ok'|'err'; msg: string }>({ kind: 'idle', msg: '' });
  const [recalcing, setRecalcing] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setStatus({ kind: 'idle', msg: 'Salvando…' });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) {
        setStatus({ kind: 'err', msg: `Erro: ${j?.error ?? 'falha'}` });
      } else {
        setStatus({ kind: 'ok', msg: '✓ Salvo. Clique em "Recalcular tudo" para aplicar nos rankings.' });
        router.refresh();
      }
    } catch (e) {
      setStatus({ kind: 'err', msg: `Erro: ${(e as Error).message}` });
    } finally {
      setSaving(false);
    }
  }

  async function recalcAll() {
    setRecalcing(true);
    setStatus({ kind: 'idle', msg: 'Recalculando tudo…' });
    try {
      const res = await fetch('/api/recalc', { method: 'POST' });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.success) {
        setStatus({ kind: 'ok', msg: `✓ ${j.message ?? 'recálculo completo'}` });
        router.refresh();
      } else {
        setStatus({ kind: 'err', msg: `Erro: ${j?.error ?? 'falha'}` });
      }
    } catch (e) {
      setStatus({ kind: 'err', msg: `Erro: ${(e as Error).message}` });
    }
    setRecalcing(false);
  }

  function restoreQualDefaults() {
    setS(p => ({ ...p, ...QUAL_DEFAULTS }));
  }

  const statusCls =
    status.kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800' :
    status.kind === 'err' ? 'bg-red-50 border-red-200 text-red-800' :
    'bg-yellow-50 border-yellow-200 text-yellow-900';

  return (
    <div className="bg-white rounded-xl shadow-sm p-4 space-y-5">
      <h2 className="text-lg font-bold">Prazos e bloqueios</h2>
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm">Prazo global de apostas (horário local)</span>
          <input type="datetime-local" className="border rounded px-2 py-1 w-full mt-1"
            value={toLocalInput(s.global_bets_deadline ?? null)}
            onChange={e => setS(p => ({
              ...p,
              global_bets_deadline: e.target.value ? new Date(e.target.value).toISOString() : null
            }))} />
          {s.global_bets_deadline && (
            <span className="text-xs text-gray-500 block mt-1">
              Será comparado contra o horário UTC. Atual: {new Date(s.global_bets_deadline).toLocaleString('pt-BR')}
            </span>
          )}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="w-5 h-5"
            checked={!!s.bets_locked}
            onChange={e => setS(p => ({ ...p, bets_locked: e.target.checked }))} />
          <span className="text-sm">Apostas bloqueadas manualmente</span>
        </label>
      </div>

      <h2 className="text-lg font-bold pt-2">Pontuação por placar (fase de grupos)</h2>
      <div className="grid sm:grid-cols-4 gap-3">
        {(['pts_correct_result','pts_correct_home','pts_correct_away','pts_correct_diff'] as const).map(k => (
          <label key={k} className="block">
            <span className="text-xs">{k}</span>
            <input type="number" min="0"
              className="border rounded px-2 py-1 w-full"
              value={(s as Record<string, number>)[k] ?? 0}
              onChange={e => setS(p => ({ ...p, [k]: Math.max(0, Number(e.target.value)) }))} />
          </label>
        ))}
      </div>

      <h2 className="text-lg font-bold pt-2">Fator zebra do placar (grupos)</h2>
      <div className="grid sm:grid-cols-3 gap-3">
        {(['zebra_threshold_easy','zebra_threshold_mid'] as const).map(k => (
          <label key={k} className="block">
            <span className="text-xs">{k}</span>
            <input type="number" step="0.01" min="0"
              className="border rounded px-2 py-1 w-full"
              value={(s as Record<string, number>)[k] ?? 0}
              onChange={e => setS(p => ({ ...p, [k]: Math.max(0, Number(e.target.value)) }))} />
          </label>
        ))}
        {(['zebra_mult_easy','zebra_mult_mid','zebra_mult_hard'] as const).map(k => (
          <label key={k} className="block">
            <span className="text-xs">{k}</span>
            <input type="number" step="0.1" min="0"
              className="border rounded px-2 py-1 w-full"
              value={(s as Record<string, number>)[k] ?? 0}
              onChange={e => setS(p => ({ ...p, [k]: Math.max(0, Number(e.target.value)) }))} />
          </label>
        ))}
      </div>

      <div className="pt-2">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-bold">Pontos por classificação de seleções</h2>
          <button type="button" onClick={restoreQualDefaults} className="btn-ghost text-xs">↻ Restaurar padrões</button>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {(Object.keys(QUAL_DEFAULTS) as (keyof Settings)[]).map(k => (
            <label key={k} className="block">
              <span className="text-xs">{QUAL_LABELS[k]}</span>
              <input type="number" min="0"
                className="border rounded px-2 py-1 w-full font-mono"
                value={(s as Record<string, number>)[k as string] ?? 0}
                onChange={e => setS(p => ({ ...p, [k]: Math.max(0, Number(e.target.value)) }))} />
            </label>
          ))}
        </div>
        <p className="text-xs text-gray-600 mt-2">
          Após alterar, clique em <strong>&ldquo;💾 Salvar&rdquo;</strong> e depois <strong>&ldquo;🔄 Recalcular tudo&rdquo;</strong>
          para aplicar nos pontos já existentes.
        </p>
      </div>

      <div className="flex gap-3 items-center pt-4 border-t">
        <button onClick={save} disabled={saving} className="btn-primary">
          {saving ? '⏳ Salvando…' : '💾 Salvar'}
        </button>
        <button onClick={recalcAll} disabled={recalcing} className="btn-ghost">
          {recalcing ? '⏳ Recalculando…' : '🔄 Recalcular tudo'}
        </button>
        {status.msg && (
          <div className={`text-sm border rounded px-3 py-1 ${statusCls}`}>{status.msg}</div>
        )}
      </div>
    </div>
  );
}
