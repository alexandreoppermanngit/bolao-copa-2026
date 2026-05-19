/**
 * REGRAS DE PONTUAÇÃO — Bolão Copa 2026
 *
 * Conforme aba "Regras" da planilha:
 * - 5 pts por acertar o resultado (vitória/empate/derrota)
 * - +2 pts por acertar o placar do time 1 (home)
 * - +2 pts por acertar o placar do time 2 (away)
 * - +1 pt por acertar a diferença de gols
 * - Multiplicador zebra: 1.0x se > 35% acertaram, 1.5x se 20-35%, 2.0x se <= 20%
 *
 * Total máximo por jogo = 10 pts × multiplicador zebra (até 2.0x = 20 pts)
 */

import type { Settings } from '@/types/database';

export interface BetInput {
  home_score: number;
  away_score: number;
}

export interface ResultInput {
  home_score: number;
  away_score: number;
}

export const DEFAULT_SETTINGS: Settings = {
  global_bets_deadline: null,
  bets_locked: false,
  pts_correct_result: 5,
  pts_correct_home: 2,
  pts_correct_away: 2,
  pts_correct_diff: 1,
  zebra_threshold_easy: 0.35,
  zebra_threshold_mid: 0.20,
  zebra_mult_easy: 1.0,
  zebra_mult_mid: 1.5,
  zebra_mult_hard: 2.0,
  pts_qual_groups: 10,
  pts_qual_r32: 12,
  pts_qual_r16: 15,
  pts_qual_quarters: 25,
  pts_qual_semis: 30,
  pts_qual_third: 30,
  pts_qual_champion: 40,
};

/** 'home' = vitória time 1, 'away' = time 2, 'draw' = empate */
export function outcomeOf(home: number, away: number): 'home' | 'away' | 'draw' {
  if (home > away) return 'home';
  if (home < away) return 'away';
  return 'draw';
}

/** Calcula pontos BRUTOS (sem zebra). */
export function calculateBasePoints(
  bet: BetInput,
  result: ResultInput,
  settings: Settings = DEFAULT_SETTINGS,
): number {
  if (
    !Number.isInteger(bet.home_score) || !Number.isInteger(bet.away_score) ||
    !Number.isInteger(result.home_score) || !Number.isInteger(result.away_score)
  ) {
    return 0;
  }

  const betOutcome = outcomeOf(bet.home_score, bet.away_score);
  const resOutcome = outcomeOf(result.home_score, result.away_score);
  if (betOutcome !== resOutcome) return 0;

  let pts = settings.pts_correct_result;
  if (bet.home_score === result.home_score) pts += settings.pts_correct_home;
  if (bet.away_score === result.away_score) pts += settings.pts_correct_away;
  const betDiff = bet.home_score - bet.away_score;
  const resDiff = result.home_score - result.away_score;
  if (betDiff === resDiff) pts += settings.pts_correct_diff;
  return pts;
}

/**
 * Calcula multiplicador zebra com base no percentual de apostas que acertaram o resultado.
 * pctHit = fração (0..1) de usuários que apostaram no MESMO resultado (home/away/draw) que ocorreu.
 */
export function zebraMultiplier(
  pctHit: number,
  settings: Settings = DEFAULT_SETTINGS,
): number {
  if (pctHit > settings.zebra_threshold_easy) return settings.zebra_mult_easy;
  if (pctHit > settings.zebra_threshold_mid) return settings.zebra_mult_mid;
  return settings.zebra_mult_hard;
}

/** Pontos finais (com zebra aplicado). */
export function calculateFinalPoints(
  bet: BetInput,
  result: ResultInput,
  pctSameOutcomeAsResult: number,
  settings: Settings = DEFAULT_SETTINGS,
): { points: number; pointsWithZebra: number; multiplier: number } {
  const points = calculateBasePoints(bet, result, settings);
  if (points === 0) return { points: 0, pointsWithZebra: 0, multiplier: 1 };
  const multiplier = zebraMultiplier(pctSameOutcomeAsResult, settings);
  return { points, pointsWithZebra: points * multiplier, multiplier };
}
