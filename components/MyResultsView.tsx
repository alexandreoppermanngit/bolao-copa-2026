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
  Team, UserQualificationScore, QualificationPhase, Settings, Match, GroupCode,
} from '@/types/database';
import type { BetAudit } from '@/lib/bolao/audit';
import { AUDIT_REASON_LABEL } from '@/lib/bolao/audit';
import {
  // v77 — `isPhaseCompleted` deixou de ser usado aqui; toda a lógica
  // de "fase concluída / time eliminado" agora está em
  // `evaluateTeamPhaseStatus`. Removido do import para evitar
  // warning de no-unused-vars sem usar eslint-disable.
  PHASE_DISPLAY_ORDER,
  getCompletedGroups, isGroupStageFullyComplete,
  phasePointsBase, evaluateTeamPhaseStatus,
  type TeamPhaseStatus,
  // v77e — extractAdvancingTeams para pré-computar `real` uma vez e
  // passar para evaluateTeamPhaseStatus em todas as N chamadas internas.
  extractAdvancingTeams,
} from '@/lib/bolao/qualification';
import { outcomeOf, zebraMultiplier } from '@/lib/bolao/scoring';
import { getBrtTodayISO, pickInitialDayFromDates } from '@/lib/bolao/matchSchedule';
import { TeamNameWithFlag } from './TeamNameWithFlag';

interface MatchBetDist {
  pct_home: number;
  pct_draw: number;
  pct_away: number;
  total: number;
}

// v74 — `getBrtTodayISO` e `pickInitialDayFromDates` agora vivem em
// `lib/bolao/matchSchedule.ts` (reutilizados também por /admin/resultados).

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
  /** v71 — settings para `zebraMultiplier` no cálculo do fator potencial. */
  settings: Settings;
  /** v71 — distribuição de palpites por match (match_bet_distribution view). */
  distByMatch: Record<number, MatchBetDist>;
  /** v72 — todos os matches (necessário para gates de classificação). */
  allMatches: Match[];
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
  settings, distByMatch, allMatches,
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

  // v71 — Inicialização inteligente do filtro de dia:
  //   1) Hoje (BRT) se houver jogos hoje;
  //   2) Próximo dia futuro com jogos;
  //   3) Último dia da lista;
  //   4) 'all' se sem audits.
  // A função `useState(() => init)` roda só uma vez (na primeira render),
  // então não interfere com a escolha manual subsequente do usuário.
  // Quando admin troca o jogador, há router.push() → componente remonta
  // → essa init roda de novo com os audits do novo jogador.
  const [dayFilter, setDayFilter] = useState<string>(() => {
    const sortedDates = datesInfo.map(d => d.date);
    return pickInitialDayFromDates(sortedDates, getBrtTodayISO());
  });

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

  // ----- classificados (UQS) — ordenados por DISPLAY_ORDER -----
  // v77 — o antigo `completedByPhase` foi removido; toda a lógica de
  // "fase concluída / time eliminado / pendente" agora vive dentro de
  // `evaluateTeamPhaseStatus` (lib/bolao/qualification.ts), que já consome
  // `allMatches` via `extractAdvancingTeams`. Mantido aqui só o cálculo
  // de grupos completos que ainda é usado abaixo.

  // v72 — gates de classificação por grupo + grupo do team apostado.
  // Para um team apostado em `group_stage`:
  //   - Se time é 1º/2º do grupo: pendente até esse grupo ter 6 jogos.
  //   - Se time é 3º: pendente até TODOS os grupos terem 6 jogos.
  // Sem saber o rank antes do fim do grupo, usamos a regra mais segura:
  //   - Pendente se o grupo do time ainda não terminou.
  //   - Pendente se o grupo terminou mas a primeira fase inteira não (cobre
  //     o caso do time poder vir como 3º melhor).
  const completedGroups = useMemo(() => getCompletedGroups(allMatches), [allMatches]);
  const groupStageFullyDone = useMemo(() => isGroupStageFullyComplete(allMatches), [allMatches]);
  const teamGroup = useMemo(() => {
    const map = new Map<number, GroupCode>();
    for (const t of teams) map.set(t.id, t.group_code);
    return map;
  }, [teams]);

  // v77e — Pré-computa `real` (fonte da verdade gateada v72 + h2h v75)
  // UMA VEZ por render e passa para todas as chamadas de
  // `evaluateTeamPhaseStatus` (tabela + consolidado). Sem isso, cada chamada
  // recomputava extractAdvancingTeams (com computeGroupStandings),
  // multiplicando o custo por N rows × M renders.
  const realAdvancing = useMemo(
    () => extractAdvancingTeams(allMatches, undefined, { gateGroupStage: true, teams }),
    [allMatches, teams],
  );

  /**
   * v77 — Status granular para uma classificação apostada.
   * Usa `evaluateTeamPhaseStatus` (que conhece grupos completos, 4º colocado,
   * 3ºs aguardando, derrotas em KO etc.). Reflete na UI:
   *   - 'reached'    → ✅ Acertou
   *   - 'pending'    → ⏳ Aguardando (com label específico para group_stage)
   *   - 'eliminated' → ❌ Eliminada (não vai pontuar)
   */
  function classificationStatus(
    phase: QualificationPhase,
    teamId: number,
    isCorrect: boolean,
  ): { icon: string; label: string; status: TeamPhaseStatus } {
    // Fast path: se UQS marcou correto, é reached.
    if (isCorrect) return { icon: '✅', label: 'Acertou', status: 'reached' };

    // v77e — passa `realAdvancing` pré-computado para evitar recomputar
    // standings/extractAdvancingTeams em cada chamada.
    const s = evaluateTeamPhaseStatus(teamId, phase, allMatches, teams, realAdvancing);
    if (s === 'reached') return { icon: '✅', label: 'Acertou', status: 'reached' };
    if (s === 'eliminated') {
      // Label varia por contexto pra ficar mais informativo
      if (phase === 'group_stage') {
        // 4º colocado vs 3º não-classificado
        const groupOfTeam = teamGroup.get(teamId);
        const groupIsDone = groupOfTeam ? completedGroups.has(groupOfTeam) : false;
        if (groupIsDone && groupStageFullyDone) {
          return { icon: '❌', label: 'Eliminada (3º fora dos melhores)', status: 'eliminated' };
        }
        return { icon: '❌', label: 'Eliminada no grupo', status: 'eliminated' };
      }
      return { icon: '❌', label: 'Eliminada — não vai pontuar', status: 'eliminated' };
    }
    // pending
    if (phase === 'group_stage') {
      const groupOfTeam = teamGroup.get(teamId);
      const groupIsDone = groupOfTeam ? completedGroups.has(groupOfTeam) : false;
      if (!groupIsDone) return { icon: '⏳', label: 'Aguardando definição do grupo', status: 'pending' };
      if (!groupStageFullyDone) return { icon: '⏳', label: 'Aguardando fim da 1ª fase', status: 'pending' };
      return { icon: '⏳', label: 'Aguardando', status: 'pending' };
    }
    return { icon: '⏳', label: 'Aguardando', status: 'pending' };
  }

  const sortedQuals = useMemo(() => {
    return [...userQuals].sort((a, b) =>
      PHASE_DISPLAY_ORDER.indexOf(a.phase as QualificationPhase) -
      PHASE_DISPLAY_ORDER.indexOf(b.phase as QualificationPhase)
    );
  }, [userQuals]);

  // v73 + v77 — Agregação por seleção apostada, com status por fase.
  //
  // Para cada team_id em UQS, calcula:
  //   - sumMultiplier: Σ(1 + factor)  — raridade acumulada
  //   - sumEarned:     Σ q.points_final  — pontos já conquistados (do banco)
  //   - sumPotentialAlive:  Σ potential das fases REACHED/PENDING (futuras possíveis)
  //   - sumPotentialLost:   Σ potential das fases ELIMINATED (não vão pontuar)
  //   - sumPotentialTotal:  sumEarned + sumPotentialAlive
  //                         (= o teto realista do que essa seleção ainda pode somar)
  //   - phases: lista com phase + multiplier + potential + earned + status
  //
  // Tudo só para exibição. Não toca em UQS/ranking/recálculo.
  const potentialBySelection = useMemo(() => {
    const byTeam = new Map<number, {
      teamId: number;
      sumMultiplier: number;
      sumEarned: number;
      sumPotentialAlive: number;
      sumPotentialLost: number;
      phases: {
        phase: QualificationPhase;
        multiplier: number;
        potential: number;
        earned: number;
        isCorrect: boolean;
        status: TeamPhaseStatus;
      }[];
    }>();

    for (const q of userQuals) {
      const phase = q.phase as QualificationPhase;
      const factor = Number(q.factor);
      const multiplier = 1 + factor;
      const basePts = phasePointsBase(phase, settings);
      const potential = basePts * multiplier;
      const earned = Number(q.points_final);
      // v77 + v77e — status real da seleção naquela fase
      // (`realAdvancing` pré-computado para evitar N+1).
      const status = q.is_correct
        ? 'reached'
        : evaluateTeamPhaseStatus(q.team_id, phase, allMatches, teams, realAdvancing);

      const entry = byTeam.get(q.team_id) ?? {
        teamId: q.team_id,
        sumMultiplier: 0,
        sumEarned: 0,
        sumPotentialAlive: 0,
        sumPotentialLost: 0,
        phases: [],
      };
      entry.sumMultiplier += multiplier;
      entry.sumEarned += earned;
      if (status === 'eliminated') {
        entry.sumPotentialLost += potential;
      } else if (status === 'pending') {
        entry.sumPotentialAlive += potential;
      }
      // status === 'reached' → o `earned` já cobre.
      entry.phases.push({ phase, multiplier, potential, earned, isCorrect: q.is_correct, status });
      byTeam.set(q.team_id, entry);
    }

    const rows = [...byTeam.values()]
      .map(r => ({
        ...r,
        team: teamById.get(r.teamId) ?? null,
        phases: [...r.phases].sort((a, b) =>
          PHASE_DISPLAY_ORDER.indexOf(a.phase) - PHASE_DISPLAY_ORDER.indexOf(b.phase)
        ),
      }))
      // v77e — Ordenação por spec exato:
      //   1) sortScore = alreadyWon + alivePotential  (desc)
      //   2) alivePotential                            (desc)
      //   3) alreadyWon                                (desc)
      //   4) lostPotential                             (asc — menor perdido sobe)
      //   5) nome da seleção                           (asc)
      .sort((a, b) => {
        const aScore = a.sumEarned + a.sumPotentialAlive;
        const bScore = b.sumEarned + b.sumPotentialAlive;
        if (bScore !== aScore) return bScore - aScore;
        if (b.sumPotentialAlive !== a.sumPotentialAlive)
          return b.sumPotentialAlive - a.sumPotentialAlive;
        if (b.sumEarned !== a.sumEarned)
          return b.sumEarned - a.sumEarned;
        if (a.sumPotentialLost !== b.sumPotentialLost)
          return a.sumPotentialLost - b.sumPotentialLost;
        const na = a.team?.name ?? '';
        const nb = b.team?.name ?? '';
        return na.localeCompare(nb, 'pt-BR');
      });

    return rows;
  }, [userQuals, teamById, settings, allMatches, teams, realAdvancing]);

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
          <BetCard
            key={a.bet.id}
            audit={a}
            settings={settings}
            dist={distByMatch[a.match.id]}
          />
        ))}
      </section>

      {/* Classificados apostados */}
      <section className="bg-white rounded-xl shadow-sm p-4">
        <h2 className="text-lg font-bold mb-3">🏅 Classificados apostados</h2>
        <p className="text-xs text-gray-600 mb-3">
          Seleções apostadas em cada fase. ✅ = acertou · ❌ = eliminada
          (não vai pontuar) · ⏳ = aguardando definição. Para a fase de
          grupos: 1º/2º só pontuam quando os 6 jogos do grupo estão completos;
          melhores 3ºs só pontuam quando toda a primeira fase termina.
          Linhas em vermelho mostram o potencial que foi perdido.
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
                  // v77 — status granular: respeita gate por grupo + eliminação
                  const st = classificationStatus(phase, q.team_id, q.is_correct);
                  // v77 — destaque vermelho discreto para eliminadas
                  const rowCls = st.status === 'eliminated' ? 'bg-red-50/60' : '';
                  // v77 — potencial PERDIDO (só faz sentido se eliminated)
                  const lostPotential = st.status === 'eliminated'
                    ? phasePointsBase(phase, settings) * (1 + Number(q.factor))
                    : 0;
                  return (
                    <tr key={q.id} className={rowCls}>
                      <td className="py-1">{PHASE_LABEL[phase]}</td>
                      <td>{t ? <TeamNameWithFlag team={t} size="sm" /> : `#${q.team_id}`}</td>
                      <td className="text-center" title={st.label}>{st.icon}</td>
                      <td className="text-right">{q.points_base}</td>
                      {/* v71 — fator amigável em formato 1.27x (era .toFixed(3)) */}
                      <td className="text-right font-medium">{(1 + Number(q.factor)).toFixed(2)}×</td>
                      {/* v77c — NUNCA exibir número negativo.
                          Eliminada: "Pts Finais = 0" (vermelho) + sub-texto
                          positivo "pot. perdido: X.X pts" (também vermelho,
                          menor). Tooltip mantém a info completa. */}
                      <td className={
                        'text-right ' +
                        (st.status === 'eliminated' ? 'text-red-700' : 'font-bold')
                      } title={
                        st.status === 'eliminated'
                          ? `Potencial perdido: ${lostPotential.toFixed(1)} pts (não vai pontuar)`
                          : undefined
                      }>
                        {st.status === 'eliminated' ? (
                          <>
                            <div className="font-bold">0</div>
                            <div className="text-[10px] font-normal opacity-90">
                              pot. perdido: {lostPotential.toFixed(1)} pts
                            </div>
                          </>
                        ) : (
                          Number(q.points_final).toFixed(2)
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* v73 — Seleções com maior potencial de pontos */}
      {potentialBySelection.length > 0 && (
        <section className="bg-white rounded-xl shadow-sm p-4">
          <h2 className="text-lg font-bold mb-1">
            🎯 Seleções com maior potencial de pontos
          </h2>
          <p className="text-xs text-gray-600 mb-3">
            Para cada seleção apostada: <strong>potencial vivo</strong> (fases
            que ainda podem render pontos) + <strong>já conquistado</strong>
            (pontos efetivos) + <strong>potencial perdido</strong> (fases em
            que a seleção já foi eliminada — não vão pontuar). Ordenado pela
            soma &quot;vivo + já conquistado&quot; desc.
          </p>
          <div className="space-y-3">
            {potentialBySelection.map((row, i) => (
              <PotentialCard
                key={row.teamId}
                rank={i + 1}
                team={row.team}
                sumMultiplier={row.sumMultiplier}
                sumPotentialAlive={row.sumPotentialAlive}
                sumPotentialLost={row.sumPotentialLost}
                sumEarned={row.sumEarned}
                phases={row.phases}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ===== sub-components =====

// v73 — Labels curtos por fase (usados nos chips de fases apostadas dentro
// do PotentialCard). Diferente do PHASE_LABEL longo no header da tabela.
const PHASE_SHORT: Record<QualificationPhase, string> = {
  group_stage: 'Grupos',
  r32: '16-avos',
  r16: 'Oitavas',
  quarters: 'Quartas',
  semis: 'Semis',
  third_place: '3º lugar',
  runner_up: 'Vice',
  champion: 'Campeão',
};

function PotentialCard({
  rank, team, sumMultiplier, sumPotentialAlive, sumPotentialLost, sumEarned, phases,
}: {
  rank: number;
  team: Team | null;
  sumMultiplier: number;
  sumPotentialAlive: number;
  sumPotentialLost: number;
  sumEarned: number;
  phases: {
    phase: QualificationPhase;
    multiplier: number;
    potential: number;
    earned: number;
    isCorrect: boolean;
    status: TeamPhaseStatus;
  }[];
}) {
  // v77 — Cor do header reflete o "estado dominante" do time: se já tem
  // muito conquistado, dourado; se está todo eliminado, vermelho discreto;
  // senão âmbar (padrão).
  const allEliminated = phases.length > 0 && phases.every(p => p.status === 'eliminated');
  const isTop = rank === 1 && !allEliminated;
  const wrapperCls = allEliminated
    ? 'border border-red-200 bg-red-50/40 rounded-lg p-3 sm:p-4'
    : (isTop
        ? 'border-2 border-accent-gold/60 bg-amber-50/40 rounded-lg p-3 sm:p-4'
        : 'border border-gray-200 rounded-lg p-3 sm:p-4');

  // Headline number: potencial vivo (o que ainda pode somar)
  return (
    <div className={wrapperCls}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="font-mono text-xs text-gray-500 w-6 text-right">#{rank}</span>
          <div className="min-w-0">
            {team
              ? <TeamNameWithFlag team={team} size="md" maxChars={24} responsive />
              : <span className="italic text-gray-400">Time ?</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={
            'text-xs uppercase tracking-wide ' +
            (allEliminated ? 'text-red-700' : 'text-amber-700')
          }>
            {allEliminated ? 'Eliminada' : 'Potencial vivo'}
          </div>
          <div className={
            'text-2xl font-bold leading-none ' +
            (allEliminated ? 'text-red-700' : 'text-amber-700')
          }>
            {allEliminated ? '—' : sumPotentialAlive.toFixed(1)}
            {!allEliminated && <span className="text-sm ml-1 opacity-80">pts</span>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-xs">
        <div className="bg-white border border-gray-100 rounded p-2">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Mult. acum.</div>
          <div className="text-base font-bold text-gray-800">{sumMultiplier.toFixed(2)}×</div>
        </div>
        <div className="bg-white border border-gray-100 rounded p-2">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Já conquistado</div>
          <div className={
            'text-base font-bold ' +
            (sumEarned > 0 ? 'text-emerald-700' : 'text-gray-400')
          }>
            {sumEarned.toFixed(1)}<span className="text-xs opacity-80 ml-1">pts</span>
          </div>
        </div>
        <div className="bg-white border border-gray-100 rounded p-2">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Potencial vivo</div>
          <div className={
            'text-base font-bold ' +
            (sumPotentialAlive > 0 ? 'text-amber-700' : 'text-gray-400')
          }>
            {sumPotentialAlive.toFixed(1)}<span className="text-xs opacity-80 ml-1">pts</span>
          </div>
        </div>
        <div className="bg-white border border-gray-100 rounded p-2">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Pot. perdido</div>
          {/* v77c — NUNCA negativo. Mesmo perdido, o número é positivo;
              só a cor (vermelha) e o label "perdido" comunicam o sentido. */}
          <div
            className={
              'text-base font-bold ' +
              (sumPotentialLost > 0 ? 'text-red-700' : 'text-gray-400')
            }
            title={
              sumPotentialLost > 0
                ? `Potencial perdido nesta seleção: ${sumPotentialLost.toFixed(1)} pts (fases já impossíveis de pontuar)`
                : undefined
            }
          >
            {sumPotentialLost.toFixed(1)}
            <span className="text-xs opacity-80 ml-1">pts</span>
          </div>
        </div>
      </div>

      {/* v77e — Chips por fase apostada: ícone + nome curto + pts (positivo).
          - reached    → ✅ Grupos · 12.0 pts        (verde)
          - pending    → ⏳ Quartas · pot. 8.5 pts   (cinza)
          - eliminated → ❌ Campeão · perdido 5.0 pts (vermelho, tachado)
          Tooltip mantém o multiplicador para quem quiser detalhes. */}
      <div className="mt-3 flex flex-wrap gap-1">
        {phases.map(p => {
          let chipCls: string;
          let icon: string;
          let label: string;
          let title: string;
          if (p.status === 'reached') {
            chipCls = 'bg-emerald-100 text-emerald-800 border border-emerald-200';
            icon = '✅';
            label = `${p.earned.toFixed(1)} pts`;
            title = `Acertou: ${p.earned.toFixed(2)} pts · multiplicador ${p.multiplier.toFixed(2)}×`;
          } else if (p.status === 'eliminated') {
            chipCls = 'bg-red-100 text-red-800 border border-red-200 line-through opacity-90';
            icon = '❌';
            label = `perdido ${p.potential.toFixed(1)} pts`;
            title = `Eliminada — potencial perdido: ${p.potential.toFixed(2)} pts · multiplicador ${p.multiplier.toFixed(2)}×`;
          } else {
            chipCls = 'bg-gray-100 text-gray-700 border border-gray-200';
            icon = '⏳';
            label = `pot. ${p.potential.toFixed(1)} pts`;
            title = `Pendente — potencial: ${p.potential.toFixed(2)} pts · multiplicador ${p.multiplier.toFixed(2)}×`;
          }
          return (
            <span
              key={p.phase}
              className={`text-[11px] px-2 py-0.5 rounded ${chipCls}`}
              title={title}
            >
              {icon} {PHASE_SHORT[p.phase]} · {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

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

/**
 * v71 — Decide se o palpite foi placar EXATO, considerando mando invertido.
 *
 * Requer que `audit.scoring_match` exista (ou seja, jogo pontuou contra algum
 * confronto real — mesmo em outra fase). Compara `bet.home/away_score` com
 * `scoring_match.home/away_score`, invertendo lados se `audit.inverted = true`.
 *
 * NÃO confundir com "vencedor certo" ou "saldo certo" — só vira true se os
 * dois placares baterem exatamente (na orientação correta).
 */
function isExactScore(a: BetAudit): boolean {
  const sm = a.scoring_match;
  if (!sm) return false;
  if (sm.home_score == null || sm.away_score == null) return false;
  const bh = a.bet.home_score;
  const ba = a.bet.away_score;
  if (a.inverted) {
    return bh === sm.away_score && ba === sm.home_score;
  }
  return bh === sm.home_score && ba === sm.away_score;
}

/**
 * v71 — Multiplicador efetivo para um palpite em fase de grupos. Reflete
 * o fator zebra que o recalc aplicou ao gravar `points_with_zebra`.
 *
 * Para KO o recalc grava `points_with_zebra = points` (sem zebra), então
 * `multiplierForPointedBet` retorna 1.0 — caller ignora.
 */
function multiplierForPointedBet(a: BetAudit): number | null {
  if (a.points <= 0) return null;
  const m = Number(a.points_with_zebra) / Number(a.points);
  if (!Number.isFinite(m) || m <= 0) return null;
  return m;
}

/**
 * v71 — Fator potencial para jogo SEM resultado real (fase de grupos).
 * Calcula como se o outcome apostado pelo usuário fosse o vencedor:
 *
 *   pctHit = % das bets que apostaram nesse mesmo outcome
 *   mult   = zebraMultiplier(pctHit, settings)
 *
 * Usa exatamente `zebraMultiplier` de `lib/bolao/scoring.ts` — mesma
 * função que o recalc usa quando o resultado real chega. Sem regra nova.
 *
 * Retorna null para KO ou se distribuição vazia.
 */
function potentialMultiplier(
  a: BetAudit,
  settings: Settings,
  dist: MatchBetDist | undefined,
): number | null {
  const isGroup =
    a.match.phase === 'group_stage_1' ||
    a.match.phase === 'group_stage_2' ||
    a.match.phase === 'group_stage_3';
  if (!isGroup) return null;
  if (!dist || dist.total === 0) return null;
  const out = outcomeOf(a.bet.home_score, a.bet.away_score);
  const pct = out === 'home' ? dist.pct_home
            : out === 'draw' ? dist.pct_draw
            : dist.pct_away;
  return zebraMultiplier(pct, settings);
}

function BetCard({
  audit: a, settings, dist,
}: {
  audit: BetAudit;
  settings: Settings;
  dist: MatchBetDist | undefined;
}) {
  const hasReal = a.match.home_score != null && a.match.away_score != null;
  const pointsZ = Number(a.points_with_zebra);
  const pointsBase = a.points;
  const hasPoints = pointsZ > 0;

  const isGroup =
    a.match.phase === 'group_stage_1' ||
    a.match.phase === 'group_stage_2' ||
    a.match.phase === 'group_stage_3';

  // v71 — placar exato é o caso especial de destaque verde escuro.
  const exact = isExactScore(a);

  // v71 — fator/multiplicador exibido.
  //   - Jogo pontuado (group): efetivo via points_with_zebra/points.
  //   - Jogo futuro (group):   potencial via distribuição + zebraMultiplier.
  //   - KO:                     null (sem fator de placar).
  const multEffective = isGroup ? multiplierForPointedBet(a) : null;
  const multPotential = !hasReal ? potentialMultiplier(a, settings, dist) : null;

  // Status visual
  const statusBadge = (() => {
    if (exact) return { text: '🎯 Placar cheio', cls: 'bg-emerald-700 text-white' };
    if (!hasReal) return { text: 'Aguardando resultado', cls: 'bg-gray-100 text-gray-700' };
    if (hasPoints) return { text: 'Pontuou', cls: 'bg-green-100 text-green-800' };
    return { text: 'Não pontuou', cls: 'bg-red-50 text-red-700' };
  })();

  // Linha de motivo
  const reasonText = a.reason ? AUDIT_REASON_LABEL[a.reason] : null;

  // Formato data/hora
  const dStr = `${a.match.match_date.slice(8, 10)}/${a.match.match_date.slice(5, 7)}`;
  const hStr = a.match.kickoff_brt.slice(0, 5);

  // v71 — wrapper do card: verde escuro elegante quando placar exato.
  const cardCls = exact
    ? 'bg-emerald-50 border-2 border-emerald-700 rounded-xl shadow-sm overflow-hidden'
    : 'bg-white rounded-xl shadow-sm overflow-hidden';

  return (
    <div className={cardCls}>
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
          <div className={
            'text-center font-mono font-bold text-lg ' +
            (exact ? 'text-emerald-800' : '')
          }>
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

        {/* Pontos + motivo + fator (v71) */}
        <div className="mt-3 pt-2 border-t border-gray-100 flex items-center justify-between gap-3 text-xs flex-wrap">
          <div className={reasonText ? 'text-gray-600' : 'text-gray-400'}>
            {reasonText ?? ''}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-gray-500">
              Base: <strong className={pointsBase > 0 ? 'text-gray-800' : 'text-gray-400'}>{pointsBase}</strong>
            </span>
            {/* Multiplicador efetivo (jogos pontuados de grupo) */}
            {multEffective != null && (
              <span className="text-gray-500" title="Fator zebra aplicado pelo recálculo">
                Fator: <strong className="text-gray-800">{multEffective.toFixed(2)}×</strong>
              </span>
            )}
            {/* Multiplicador potencial (jogos futuros de grupo) */}
            {multPotential != null && multEffective == null && (
              <span className="text-amber-700"
                    title="Multiplicador se o resultado for o seu palpite (baseado na distribuição atual)">
                Potencial: <strong>{multPotential.toFixed(2)}×</strong>
              </span>
            )}
            {/* KO: sem fator de placar */}
            {!isGroup && hasReal && (
              <span className="text-gray-400 text-[11px]" title="Mata-mata: pontuação direta, sem multiplicador de jogo.">
                Sem fator no mata-mata
              </span>
            )}
            <span className={
              `px-2 py-0.5 rounded font-bold ` +
              (exact
                ? 'bg-emerald-700 text-white'
                : (hasPoints ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'))
            }>
              {pointsZ.toFixed(1)} pts
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
