/**
 * Auditoria/explicação de pontos do bolão — FONTE ÚNICA DE VERDADE.
 *
 * Esta lib NÃO recalcula pontos (isso é responsabilidade de `recalc.ts`,
 * que persiste em `bets.points` e `bets.points_with_zebra`).
 *
 * O que ela faz: dado um bet + dados do contexto, retorna a EXPLICAÇÃO:
 *   - times do confronto APOSTADO pelo usuário (na simulação dele)
 *   - times do confronto REAL usado para pontuar (pode ser em outra fase)
 *   - se houve mando invertido
 *   - motivo da pontuação
 *   - pontos finais (lidos de bets.points / points_with_zebra)
 *
 * Usado por: /comparativo, /admin/pontuacao
 */

import type {
  Bet, Match, Team, AnnexCOption, MatchPhase,
} from '@/types/database';
import {
  computeGroupStandings, computeThirdPlaceRanking,
  sortedKeyOfQualifyingThirds, areAllGroupsMature,
} from './standings';
import { findAnnexCOption, simulateBracket, type KoTiebreakHint } from './bracket';
import { findRealKnockoutMatchup } from './matchup';

export type AuditReason =
  | 'group_stage_direct'         // Fase de grupos: pontuação direta do jogo
  | 'ko_match_correct_same_phase' // Mata-mata: confronto correto na mesma fase
  | 'ko_match_correct_inverted'   // Mata-mata: confronto correto com mando invertido
  | 'ko_match_correct_other_phase' // Mata-mata: confronto ocorreu em outra fase
  | 'ko_match_not_played'         // Mata-mata: confronto não ocorreu
  | 'pending_real_result';        // Aguardando resultado real

export const AUDIT_REASON_LABEL: Record<AuditReason, string> = {
  group_stage_direct: 'Fase de grupos: pontuação direta do jogo',
  ko_match_correct_same_phase: 'Mata-mata: confronto correto na mesma fase',
  ko_match_correct_inverted: 'Mata-mata: confronto correto com mando invertido',
  ko_match_correct_other_phase: 'Mata-mata: confronto ocorreu em outra fase',
  ko_match_not_played: 'Mata-mata: confronto não ocorreu (0 pts de placar)',
  pending_real_result: 'Aguardando resultado real',
};

export interface BetAudit {
  bet: Bet;
  match: Match;                         // o jogo OFICIAL ao qual a aposta se refere
  phase_label: MatchPhase;
  // Times do confronto que o usuário ENXERGAVA naquele match (simulação dele)
  bet_home_team: Team | null;
  bet_away_team: Team | null;
  // Times reais do jogo (oficial, pode ser diferente do que ele simulou)
  real_home_team: Team | null;
  real_away_team: Team | null;
  // Jogo real usado para pontuar (pode ser DIFERENTE do match oficial se for confronto-em-outra-fase)
  scoring_match: Match | null;
  scoring_home_team: Team | null;
  scoring_away_team: Team | null;
  inverted: boolean;
  reason: AuditReason;
  // Pontos vêm da bet (já calculados pelo recalc)
  points: number;
  points_with_zebra: number;
}

/**
 * Constrói o audit para uma única aposta no contexto do usuário.
 *
 * @param simulatedMatchesByUser Matches resolvidos para ESTE usuário (via simulateBracket)
 * @param allMatches             Matches OFICIAIS (com home_team_id resolvido pela árvore real)
 */
export function buildBetAudit(params: {
  bet: Bet;
  match: Match;
  simulatedMatchesByUser: Match[];
  allMatches: Match[];
  teamById: Map<number, Team>;
}): BetAudit {
  const { bet, match, simulatedMatchesByUser, allMatches, teamById } = params;

  const isGroupPhase =
    match.phase === 'group_stage_1' ||
    match.phase === 'group_stage_2' ||
    match.phase === 'group_stage_3';

  // Times reais (oficiais) do jogo
  const realHome = match.home_team_id ? teamById.get(match.home_team_id) ?? null : null;
  const realAway = match.away_team_id ? teamById.get(match.away_team_id) ?? null : null;

  // Times que o usuário ENXERGAVA nesse match.
  //
  // Migration 008: prioridade absoluta para o SNAPSHOT salvo na bet
  // (bet_home_team_id / bet_away_team_id). Esses campos foram preenchidos
  // pelo /api/bets/save (front envia o que está vendo) ou pelo backfill
  // — e são imunes a recalc/reset do bracket oficial.
  //
  // Fallback (bets antigas pré-008 ou backfill não rodado): para fase de
  // grupos, usar `realHome`/`realAway` (que são fixos no DB); para KO,
  // cair na simulação como antes.
  const userMatch = simulatedMatchesByUser.find(m => m.id === match.id);

  const snapHomeId = bet.bet_home_team_id ?? null;
  const snapAwayId = bet.bet_away_team_id ?? null;

  const betHome = snapHomeId
    ? (teamById.get(snapHomeId) ?? null)
    : (isGroupPhase
        ? realHome
        : (userMatch?.home_team_id ? teamById.get(userMatch.home_team_id) ?? null : null));
  const betAway = snapAwayId
    ? (teamById.get(snapAwayId) ?? null)
    : (isGroupPhase
        ? realAway
        : (userMatch?.away_team_id ? teamById.get(userMatch.away_team_id) ?? null : null));

  const hasRealResult = match.home_score != null && match.away_score != null;

  // === FASE DE GRUPOS ===
  if (isGroupPhase) {
    return {
      bet, match, phase_label: match.phase,
      bet_home_team: betHome, bet_away_team: betAway,
      real_home_team: realHome, real_away_team: realAway,
      scoring_match: hasRealResult ? match : null,
      scoring_home_team: realHome, scoring_away_team: realAway,
      inverted: false,
      reason: hasRealResult ? 'group_stage_direct' : 'pending_real_result',
      points: bet.points, points_with_zebra: bet.points_with_zebra,
    };
  }

  // === MATA-MATA ===
  // 1) Sem confronto montado na simulação do usuário ainda
  if (!betHome || !betAway) {
    return {
      bet, match, phase_label: match.phase,
      bet_home_team: null, bet_away_team: null,
      real_home_team: realHome, real_away_team: realAway,
      scoring_match: null, scoring_home_team: null, scoring_away_team: null,
      inverted: false,
      reason: 'pending_real_result',
      points: bet.points, points_with_zebra: bet.points_with_zebra,
    };
  }

  // 2) Buscar o confronto previsto em qualquer fase eliminatória com placar
  const hit = findRealKnockoutMatchup(betHome.id, betAway.id, allMatches);
  if (!hit) {
    return {
      bet, match, phase_label: match.phase,
      bet_home_team: betHome, bet_away_team: betAway,
      real_home_team: realHome, real_away_team: realAway,
      scoring_match: null, scoring_home_team: null, scoring_away_team: null,
      inverted: false,
      reason: hasRealResult ? 'ko_match_not_played' : 'pending_real_result',
      points: bet.points, points_with_zebra: bet.points_with_zebra,
    };
  }

  // 3) Confronto encontrado: pode ser na mesma fase ou em outra
  const sameMatch = hit.match.id === match.id;
  const reason: AuditReason = sameMatch
    ? (hit.inverted ? 'ko_match_correct_inverted' : 'ko_match_correct_same_phase')
    : 'ko_match_correct_other_phase';

  return {
    bet, match, phase_label: match.phase,
    bet_home_team: betHome, bet_away_team: betAway,
    real_home_team: realHome, real_away_team: realAway,
    scoring_match: hit.match,
    scoring_home_team: hit.match.home_team_id ? teamById.get(hit.match.home_team_id) ?? null : null,
    scoring_away_team: hit.match.away_team_id ? teamById.get(hit.match.away_team_id) ?? null : null,
    inverted: hit.inverted,
    reason,
    points: bet.points, points_with_zebra: bet.points_with_zebra,
  };
}

/**
 * Helper: simula o bracket para um usuário (usado pelas páginas servidoras).
 * Memoiza por user_id em quem chama (já que é caro).
 */
export function simulateBracketForUser(params: {
  userBets: Bet[];
  allMatches: Match[];
  teams: Team[];
  annexCOptions: AnnexCOption[];
}): Match[] {
  const { userBets, allMatches, teams, annexCOptions } = params;
  const byMatch = new Map(userBets.map(b => [b.match_id, b]));
  const simMatches: Match[] = allMatches.map(m => {
    const b = byMatch.get(m.id);
    if (b) return { ...m, home_score: b.home_score, away_score: b.away_score };
    return m;
  });
  if (!areAllGroupsMature(simMatches)) return simMatches;
  const standings = computeGroupStandings(teams, simMatches);
  const thirds = computeThirdPlaceRanking(standings);
  const key = sortedKeyOfQualifyingThirds(thirds);
  const opt = key.length === 8 ? findAnnexCOption(key, annexCOptions) : null;
  const hints = new Map<number, KoTiebreakHint>();
  for (const b of userBets) {
    if (b.knockout_advancer) hints.set(b.match_id, { knockout_advancer: b.knockout_advancer });
  }
  return simulateBracket(simMatches, teams, standings, thirds, opt, hints);
}
