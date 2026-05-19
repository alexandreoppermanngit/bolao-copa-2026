/**
 * MATA-MATA: matchup normalizado (par não-ordenado) + busca em qualquer fase
 *
 * Regras (conforme regulamento do bolão para 2026):
 * - Um jogo KO só pontua se o CONFRONTO previsto pelo usuário (par {timeA, timeB})
 *   realmente aconteceu em ALGUMA fase eliminatória (mesmo que não seja a fase
 *   que ele apostou).
 * - Mando invertido conta: Brasil×França == França×Brasil.
 * - Quando o palpite estiver com mando invertido em relação ao jogo real,
 *   normalizamos para comparar placares corretamente (D/E do usuário viram E/D).
 * - Não há fator zebra de PLACAR nos jogos de mata-mata. Só pontuação base.
 * - Cada par é considerado apenas UMA vez (evita pontuação duplicada se o mesmo
 *   confronto acontecer em duas fases — improvável mas blindado).
 */

import type { Match } from '@/types/database';
import { calculateBasePoints, type BetInput } from './scoring';

/** Chave canônica não-ordenada para um confronto. */
export function matchupKey(teamA: number | null, teamB: number | null): string | null {
  if (teamA == null || teamB == null) return null;
  const [a, b] = teamA < teamB ? [teamA, teamB] : [teamB, teamA];
  return `${a}-${b}`;
}

/** Resultado da pesquisa por confronto real. */
export interface RealMatchupHit {
  match: Match;            // jogo real onde o confronto aconteceu
  inverted: boolean;       // true se time1 do palpite == away do jogo real
}

/**
 * Procura, entre os jogos com placar definido, um jogo KO onde
 * o confronto {homeBetId, awayBetId} aconteceu (em qualquer fase eliminatória).
 *
 * Retorna o primeiro match (ordenado por id) ou null.
 */
export function findRealKnockoutMatchup(
  homeBetId: number,
  awayBetId: number,
  allMatches: Match[],
): RealMatchupHit | null {
  const target = matchupKey(homeBetId, awayBetId);
  if (!target) return null;
  const candidates = allMatches
    .filter(m =>
      m.phase !== 'group_stage_1' &&
      m.phase !== 'group_stage_2' &&
      m.phase !== 'group_stage_3' &&
      m.home_team_id != null && m.away_team_id != null &&
      m.home_score != null && m.away_score != null
    )
    .sort((a, b) => a.id - b.id);

  for (const m of candidates) {
    const k = matchupKey(m.home_team_id, m.away_team_id);
    if (k === target) {
      const inverted = m.home_team_id !== homeBetId;
      return { match: m, inverted };
    }
  }
  return null;
}

/**
 * Calcula pontos do palpite KO contra o resultado real (em qualquer fase),
 * **sem fator zebra de placar** (regra do bolão para mata-mata).
 *
 * Se o confronto não foi encontrado, retorna 0.
 * Se inverted, troca home/away do placar do palpite antes de comparar.
 */
export function calculateKnockoutPoints(
  bet: BetInput & { home_team_id: number; away_team_id: number },
  allMatches: Match[],
  settings: Parameters<typeof calculateBasePoints>[2],
): { points: number; matched_match_id: number | null; inverted: boolean } {
  const hit = findRealKnockoutMatchup(bet.home_team_id, bet.away_team_id, allMatches);
  if (!hit) return { points: 0, matched_match_id: null, inverted: false };
  const real = {
    home_score: hit.match.home_score!,
    away_score: hit.match.away_score!,
  };
  const adjustedBet: BetInput = hit.inverted
    ? { home_score: bet.away_score, away_score: bet.home_score }
    : bet;
  const pts = calculateBasePoints(adjustedBet, real, settings);
  return { points: pts, matched_match_id: hit.match.id, inverted: hit.inverted };
}
