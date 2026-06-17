'use client';

/**
 * MyResultsView — Visualização de resultados de um único usuário.
 *
 * Recebe TUDO pronto do server (audits, qualification scores, rank).
 * Não recalcula pontuação — só APRESENTA.
 *
 * Componentes:
 *   1. Header com nome + (admin) seletor de jogador.
 *   2. Cards de resumo (pontos, posição, contagens).
 *   3. Seção "Jogos apostados" com filtro por dia + lista responsiva (cards).
 *   4. Seção "Classificados apostados" agrupada por fase.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  Team, UserQualificationScore, QualificationPhase,
} from '@/types/database';
import type { BetAudit } from '@/lib/bolao/audit';
import { AUDIT_REASON_LABEL } from '@/lib/bolao/audit';
import { PHASE_DISPLAY_ORDER, isPhaseCompleted } from '@/lib/bolao/qualification';
import { TeamNameWithFlag } from './TeamNameWithFlag';

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

interface Props {
  isSelf: boolean;
  isAdmin: boolean;
  targetUserId: string;
  displayName: string;
  rank: RankRow | null;
  audits: BetAudit[];
  userQuals: UserQualificationScore[];
  teams: Team[];
  adminProfiles: AdminPickerProfile[];
}

const PHASE_LABEL: Record<QualificationPhase, string> = {
  group_stage: 'Classificados dos grupos',
  r32: 'Vence 16-avos',
  r16: 'Vence oitavas',
  quarters: 'Vence quartas',
  semis: 'Finalistas',
  third_place: 'Terceiro lugar',
  runner_up: 'Vice-campeão',
  champion: 'Campeão',
};

export function MyResultsView({
  isSelf, isAdmin, targetUserId, displayName, rank, audits, userQuals, teams, adminProfiles,
}: Props) {
  const router = useRouter();
  const teamById = useMemo(() => new Map(teams.map(t => [t.id, t])), [teams]);

  // ----- filtro por dia (client-state) -----
  const datesInfo = useMemo(() => {
    // { date: 'YYYY-MM-DD', count: N }, ordenado asc.
    const counts = new Map<string, number>();
    for (const a of audits) counts.set(a.match.match_date, (counts.get(a.match.match_date) ?? 0) + 1);
    return [...counts.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [audits]);

  const [dayFilter, setDayFilter] = useState<string>('all');

  const filteredAudits: BetAudit[] = useMemo(() => {
    const list: BetAudit[] = dayFilter === 'all'
      ? audits
      : audits.filter(a => a.match.match_date === dayFilter);
    return [...list].sort((a, b) => {
      // Ordena por match_date asc, kickoff_brt asc, id asc.
      const d = a.match.match_date.localeCompare(b.match.match_date);
      if (d !== 0) return d;
      const t = a.match.kickoff_brt.localeCompare(b.match.kickoff_brt);
      if (t !== 0) return t;
      return a.match.id - b.match.id;
    });
  }, [audits, dayFilter]);

  // ----- contagens para o resumo -----
  const totalApostas = audits.length;
  const totalPontuadas = audits.filter(a => Number(a.points_with_zebra) > 0).length;
  const totalAguardando = audits.filter(a => a.match.home_score == null).length;

  // ----- classificados (UQS) — ordenados por DISPLAY_ORDER, com fallback para fases concluídas -----
  // Para o badge ✅/❌/⏳ replicamos a lógica do /admin/pontuacao: precisamos
  // saber se a fase já foi concluída no resultado real. Como recebemos só
  // os audits (que carregam matches), reconstruímos um array de matches
  // únicos pra alimentar isPhaseCompleted.
  const realMatches = useMemo(() => audits.map(a => a.match), [audits]);
  const completedByPhase: Record<QualificationPhase, boolean> = useMemo(() => ({
    group_stage: isPhaseCompleted('group_stage', realMatches),
    r32:         isPhaseCompleted('r32', realMatches),
    r16:         isPhaseCompleted('r16', realMatches),
    quarters:    isPhaseCompleted('quarters', realMatches),
    semis:       isPhaseCompleted('semis', realMatches),
    third_place: isPhaseCompleted('third_place', realMatches),
    runner_up:   isPhaseCompleted('runner_up', realMatches),
    champion:    isPhaseCompleted('champion', realMatches),
  }), [realMatches]);

  const sortedQuals = useMemo(() => {
    return [...userQuals].sort((a, b) =>
      PHASE_DISPLAY_ORDER.indexOf(a.phase as QualificationPhase) -
      PHASE_DISPLAY_ORDER.indexOf(b.phase as QualificationPhase)
    );
  }, [userQuals]);

  // ----- helpers de format -----
  function dayLabel(dateISO: string): string {
    // YYYY-MM-DD → DD/MM/YYYY
    const [y, m, d] = dateISO.split('-');
    return `${d}/${m}/${y}`;
  }

  function handleSwitchUser(newUserId: string) {
    if (newUserId === targetUserId) return;
    router.push(`/meus-resultados?user=${newUserId}`);
  }

  return (
    <div className="space-y-4">
      {/* Header com seletor admin */}
      <div className="bg-white rounded-xl p-4 shadow-sm">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">
              {isSelf ? '📊 Meus Resultados' : `📊 Resultados — ${displayName}`}
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Lista de todos os jogos apostados, com placar, pontos e status. Use o
              filtro por dia para encontrar uma rodada específica.
            </p>
          </div>
          {isAdmin && adminProfiles.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-gray-600">Jogador:</span>
              <select
                className="border rounded px-2 py-1 max-w-[280px]"
                value={targetUserId}
                onChange={e => handleSwitchUser(e.target.value)}
              >
                {adminProfiles.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.display_name ?? '(sem nome)'}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {/* Resumo de pontos */}
      <section className="bg-gradient-to-br from-brand-500 to-brand-700 text-white rounded-xl p-5 shadow-md">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <Stat label="Total + posição"
                value={Number(rank?.total_points ?? 0).toFixed(1)}
                sub={rank?.position ? `#${rank.position} no ranking` : '—'}
                highlight />
          <Stat label="Pontos por jogos"
                value={Number(rank?.game_points ?? 0).toFixed(1)}
                sub={`${rank?.games_correct ?? 0} jogos pontuados`} />
          <Stat label="Pontos por classificados"
                value={Number(rank?.qualification_points ?? 0).toFixed(1)}
                sub={`${rank?.qualification_correct ?? 0} seleções acertadas`} />
          <Stat label="Bônus zebra"
                value={(Number(rank?.game_points ?? 0) - Number(rank?.game_points_base ?? 0) +
                        Number(rank?.qualification_points ?? 0) - Number(rank?.qualification_points_base ?? 0)).toFixed(1)}
                sub="jogos + classificados" />
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mt-3 text-xs">
          <CardMini label="Apostas registradas" value={totalApostas} />
          <CardMini label="Já pontuaram" value={totalPontuadas} />
          <CardMini label="Aguardando resultado" value={totalAguardando} />
        </div>
      </section>

      {/* Filtro por dia */}
      <section className="bg-white rounded-xl shadow-sm p-4">
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="font-medium text-gray-700">📅 Filtrar por dia:</span>
          <select
            className="border rounded px-2 py-1"
            value={dayFilter}
            onChange={e => setDayFilter(e.target.value)}
          >
            <option value="all">Todos os dias ({audits.length} jogos)</option>
            {datesInfo.map(d => (
              <option key={d.date} value={d.date}>
                {dayLabel(d.date)} — {d.count} {d.count === 1 ? 'jogo' : 'jogos'}
              </option>
            ))}
          </select>
          {dayFilter !== 'all' && (
            <button
              type="button"
              onClick={() => setDayFilter('all')}
              className="text-xs text-brand-500 underline ml-auto"
            >
              Limpar filtro
            </button>
          )}
        </div>
      </section>

      {/* Lista de jogos — cards responsivos */}
      <section className="space-y-3">
        {filteredAudits.length === 0 && (
          <div className="bg-white rounded-xl shadow-sm p-6 text-center text-gray-500">
            {audits.length === 0
              ? 'Nenhuma aposta registrada.'
              : 'Nenhuma aposta neste dia.'}
          </div>
        )}
        {filteredAudits.map(a => (
          <BetCard key={a.bet.id} audit={a} />
        ))}
      </section>

      {/* Classificados apostados */}
      <section className="bg-white rounded-xl shadow-sm p-4">
        <h2 className="text-lg font-bold mb-3">🏅 Classificados apostados</h2>
        <p className="text-xs text-gray-600 mb-3">
          Seleções apostadas em cada fase. ✅ = acertou (fase concluída) ·
          ❌ = errou (fase concluída) · ⏳ = aguardando resultado.
        </p>
        {sortedQuals.length === 0 && (
          <p className="text-sm text-gray-500">Nenhum classificado apostado ainda.</p>
        )}
        {sortedQuals.length > 0 && (
          <div className="overflow-x-auto">
            <table className="spreadsheet-table text-xs w-full">
              <thead>
                <tr>
                  <th className="text-left">Fase</th>
                  <th className="text-left">Seleção</th>
                  <th>Status</th>
                  <th className="text-right">Base</th>
                  <th className="text-right">Fator</th>
                  <th className="text-right">Pts Finais</th>
                </tr>
              </thead>
              <tbody>
                {sortedQuals.map(q => {
                  const phase = q.phase as QualificationPhase;
                  const t = teamById.get(q.team_id);
                  const status = q.is_correct
                    ? '✅'
                    : (completedByPhase[phase] ? '❌' : '⏳');
                  return (
                    <tr key={q.id}>
                      <td className="py-1">{PHASE_LABEL[phase]}</td>
                      <td>{t ? <TeamNameWithFlag team={t} size="sm" /> : `#${q.team_id}`}</td>
                      <td className="text-center">{status}</td>
                      <td className="text-right">{q.points_base}</td>
                      <td className="text-right">{(1 + Number(q.factor)).toFixed(3)}×</td>
                      <td className="text-right font-bold">{Number(q.points_final).toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ===== sub-components =====
function Stat({ label, value, sub, highlight }: {
  label: string; value: string; sub?: string; highlight?: boolean;
}) {
  return (
    <div className={`rounded-lg p-3 ${highlight ? 'bg-white text-brand-700' : 'bg-white/10'}`}>
      <div className="text-xs uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs opacity-80 mt-1">{sub}</div>}
    </div>
  );
}

function CardMini({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white/10 rounded-lg p-2">
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-lg font-bold">{value}</div>
    </div>
  );
}

function BetCard({ audit: a }: { audit: BetAudit }) {
  const hasReal = a.match.home_score != null && a.match.away_score != null;
  const pointsZ = Number(a.points_with_zebra);
  const pointsBase = a.points;
  const hasPoints = pointsZ > 0;

  // Status visual
  const statusBadge = (() => {
    if (!hasReal) return { text: 'Aguardando resultado', cls: 'bg-gray-100 text-gray-700' };
    if (hasPoints) return { text: 'Pontuou', cls: 'bg-green-100 text-green-800' };
    return { text: 'Não pontuou', cls: 'bg-red-50 text-red-700' };
  })();

  // Linha de motivo
  const reasonText = a.reason ? AUDIT_REASON_LABEL[a.reason] : null;

  // Formato data/hora
  const dStr = `${a.match.match_date.slice(8, 10)}/${a.match.match_date.slice(5, 7)}`;
  const hStr = a.match.kickoff_brt.slice(0, 5);

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden">
      <div className="p-3 sm:p-4">
        <div className="flex items-center justify-between gap-2 text-xs text-gray-500 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono">#{a.match.id}</span>
            <span>·</span>
            <span>{a.match.phase}</span>
            <span>·</span>
            <span>{dStr} {hStr}</span>
            {a.match.venue && <><span>·</span><span className="hidden sm:inline">{a.match.venue}</span></>}
          </div>
          <span className={`text-[10px] px-2 py-0.5 rounded font-semibold ${statusBadge.cls}`}>
            {statusBadge.text}
          </span>
        </div>

        {/* PALPITE */}
        <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center">
          <div className="text-right truncate">
            {a.bet_home_team
              ? <TeamNameWithFlag team={a.bet_home_team} reverse maxChars={18} responsive />
              : <span className="italic text-gray-400 text-xs">aguardando…</span>}
          </div>
          <div className="text-center font-mono font-bold text-lg">
            {a.bet.home_score} × {a.bet.away_score}
          </div>
          <div className="truncate">
            {a.bet_away_team
              ? <TeamNameWithFlag team={a.bet_away_team} maxChars={18} responsive />
              : <span className="italic text-gray-400 text-xs">aguardando…</span>}
          </div>
        </div>

        {/* Pênaltis (se KO empatado) */}
        {a.bet.home_score === a.bet.away_score && a.bet.knockout_advancer && (
          <div className="text-[11px] text-amber-700 mt-1 text-center">
            Avança nos pênaltis: {a.bet.knockout_advancer === 'home'
              ? (a.bet_home_team?.name ?? 'mandante')
              : (a.bet_away_team?.name ?? 'visitante')}
          </div>
        )}

        {/* PLACAR REAL (se houver) */}
        {hasReal && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Resultado real</div>
            <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center">
              <div className="text-right truncate">
                {a.real_home_team
                  ? <TeamNameWithFlag team={a.real_home_team} reverse size="sm" maxChars={16} responsive />
                  : <span className="italic text-gray-400 text-xs">—</span>}
              </div>
              <div className="text-center font-mono text-sm">
                {a.match.home_score} × {a.match.away_score}
              </div>
              <div className="truncate">
                {a.real_away_team
                  ? <TeamNameWithFlag team={a.real_away_team} size="sm" maxChars={16} responsive />
                  : <span className="italic text-gray-400 text-xs">—</span>}
              </div>
            </div>
            {/* Confronto onde o palpite efetivamente pontuou (pode ser em outra fase) */}
            {a.scoring_match && a.scoring_match.id !== a.match.id && (
              <div className="text-[11px] text-purple-700 mt-2 text-center">
                Confronto correspondente: #{a.scoring_match.id} ({a.scoring_match.phase})
                {a.inverted && <span className="ml-1">⇄ mando invertido</span>}
              </div>
            )}
          </div>
        )}

        {/* Pontos + motivo */}
        <div className="mt-3 pt-2 border-t border-gray-100 flex items-center justify-between gap-3 text-xs flex-wrap">
          <div className={reasonText ? 'text-gray-600' : 'text-gray-400'}>
            {reasonText ?? ''}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-gray-500">
              Base: <strong className={pointsBase > 0 ? 'text-gray-800' : 'text-gray-400'}>{pointsBase}</strong>
            </span>
            <span className={
              `px-2 py-0.5 rounded font-bold ` +
              (hasPoints ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500')
            }>
              {pointsZ.toFixed(1)} pts
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
