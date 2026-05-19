/**
 * Overrides manuais do bracket: admin pode forçar times em slots de jogos
 * de mata-mata quando o cálculo automático não pode resolver
 * (ex: empate triplo de 3ºs, critério FIFA que nossa app não suporta).
 *
 * Uso: aplicado APÓS populateKnockoutMatches no recalcBracket — ou seja,
 * os overrides têm precedência sobre o cálculo automático.
 */

import type { Match, BracketOverride } from '@/types/database';

/**
 * Aplica overrides numa lista de matches.
 * Retorna nova lista com home_team_id/away_team_id substituídos onde houver override.
 */
export function applyBracketOverrides(
  matches: Match[],
  overrides: BracketOverride[],
): Match[] {
  if (overrides.length === 0) return matches;
  const byMatch = new Map<number, { home?: number | null; away?: number | null }>();
  for (const o of overrides) {
    if (!byMatch.has(o.match_id)) byMatch.set(o.match_id, {});
    const e = byMatch.get(o.match_id)!;
    if (o.side === 'home') e.home = o.team_id;
    else e.away = o.team_id;
  }
  return matches.map(m => {
    const ov = byMatch.get(m.id);
    if (!ov) return m;
    return {
      ...m,
      home_team_id: ov.home !== undefined ? ov.home : m.home_team_id,
      away_team_id: ov.away !== undefined ? ov.away : m.away_team_id,
    };
  });
}

export function isMatchSlotOverridden(
  matchId: number,
  side: 'home' | 'away',
  overrides: BracketOverride[],
): boolean {
  return overrides.some(o => o.match_id === matchId && o.side === side);
}
