/**
 * MONTAGEM DA CHAVE ELIMINATÓRIA
 *
 * Conforme regulamento FIFA Copa 2026:
 * - 16-avos (Round of 32, 16 jogos)
 * - 8 jogos têm 1º vs 3º; 3ºs distribuídos via Anexo C (495 opções)
 *
 * Placeholders simbólicos:
 *   "1A", "2B", ...           — direto da classificação dos grupos
 *   "3rd_pos_1A"...           — 3º colocado a ser definido pelo Anexo C
 *   "winner_M73", "loser_M101" — vencedor/perdedor de outro jogo
 *
 * Regras importantes:
 * - O bracket SÓ é populado quando TODOS os grupos têm ≥2 jogos preenchidos
 *   (`areAllGroupsMature()`). Antes disso, todos os jogos KO ficam vazios.
 * - Para vencedor de KO empatado: usa home_pens/away_pens. Se também null,
 *   usa o knockout_advancer da APOSTA do usuário (no caso de simulação local).
 */

import type { Match, AnnexCOption, Team } from '@/types/database';
import {
  type ComputedStanding,
  type ThirdRanking,
  teamByPositionCode,
  areAllGroupsMature,
} from './standings';
import type { GroupCode } from '@/types/database';

/** Como o vencedor de um jogo eliminatório é decidido em caso de empate */
export interface KoTiebreakHint {
  /** "home" se o time da casa avança, "away" caso contrário */
  knockout_advancer?: 'home' | 'away' | null;
}

/**
 * Determina o vencedor de um match (somente makes sense p/ KO).
 * Em fase de grupos, empate é empate (retorna null em empate).
 */
export function determineMatchWinnerId(
  m: Match,
  hint?: KoTiebreakHint,
): number | null {
  if (m.home_score == null || m.away_score == null) return null;
  if (m.home_score > m.away_score) return m.home_team_id;
  if (m.away_score > m.home_score) return m.away_team_id;
  // Empate — só vale para KO
  if (m.home_pens != null && m.away_pens != null) {
    return m.home_pens > m.away_pens ? m.home_team_id : m.away_team_id;
  }
  if (hint?.knockout_advancer === 'home') return m.home_team_id;
  if (hint?.knockout_advancer === 'away') return m.away_team_id;
  return null;
}

export function determineMatchLoserId(
  m: Match,
  hint?: KoTiebreakHint,
): number | null {
  const winner = determineMatchWinnerId(m, hint);
  if (winner == null) return null;
  if (winner === m.home_team_id) return m.away_team_id;
  if (winner === m.away_team_id) return m.home_team_id;
  return null;
}

/**
 * Resolve um placeholder para um time concreto.
 *
 * @param hintsByMatchId opcional: mapa match_id → KoTiebreakHint (palpite do usuário em empate)
 */
export function resolvePlaceholder(
  placeholder: string,
  standings: Map<GroupCode, ComputedStanding[]>,
  thirdsRanking: ThirdRanking[],
  annexCOption: AnnexCOption | null,
  matches: Match[],
  teamById: Map<number, Team>,
  hintsByMatchId?: Map<number, KoTiebreakHint>,
): { team: Team | null } {
  // 1) Posição direta: "1A", "2C"
  if (/^[1-4][A-L]$/.test(placeholder)) {
    const std = teamByPositionCode(standings, placeholder);
    if (!std) return { team: null };
    return { team: teamById.get(std.team_id) ?? null };
  }

  // 2) 3º via Anexo C
  if (placeholder.startsWith('3rd_pos_')) {
    const pos = placeholder.slice('3rd_pos_'.length);
    if (!annexCOption) return { team: null };
    const map: Record<string, keyof AnnexCOption> = {
      '1A':'pos_1a','1B':'pos_1b','1D':'pos_1d','1E':'pos_1e',
      '1G':'pos_1g','1I':'pos_1i','1K':'pos_1k','1L':'pos_1l',
    };
    const key = map[pos];
    if (!key) return { team: null };
    const groupLetter = annexCOption[key] as GroupCode;
    const std = teamByPositionCode(standings, `3${groupLetter}`);
    if (!std) return { team: null };
    return { team: teamById.get(std.team_id) ?? null };
  }

  // 3) Winner/Loser de jogo anterior
  if (placeholder.startsWith('winner_M') || placeholder.startsWith('loser_M')) {
    const isWinner = placeholder.startsWith('winner_M');
    const matchId = Number(placeholder.slice(isWinner ? 8 : 7));
    const m = matches.find(x => x.id === matchId);
    if (!m) return { team: null };
    const hint = hintsByMatchId?.get(matchId);
    const teamId = isWinner ? determineMatchWinnerId(m, hint) : determineMatchLoserId(m, hint);
    return { team: teamId ? teamById.get(teamId) ?? null : null };
  }

  return { team: null };
}

export function findAnnexCOption(
  sortedKey: string,
  annexCOptions: AnnexCOption[],
): AnnexCOption | null {
  return annexCOptions.find(o => o.sorted_key === sortedKey) ?? null;
}

export interface MatchUpdate {
  match_id: number;
  home_team_id: number | null;
  away_team_id: number | null;
}

/**
 * Popula em cascata os times de TODOS os jogos de mata-mata.
 *
 * Comportamento:
 * - Se NÃO todos os grupos estão maduros (≥2 jogos cada), retorna [] (nada populado).
 * - Caso contrário, percorre os jogos KO em ordem (id crescente) e resolve home/away
 *   usando os placeholders. Como processamos em ordem, jogos posteriores conseguem
 *   resolver `winner_M*` apontando para resultados já materializados.
 * - O array retornado pode ser persistido no banco (via update) ou apenas usado
 *   localmente para simulação no cliente.
 */
export function populateKnockoutMatches(
  matches: Match[],
  teams: Team[],
  standings: Map<GroupCode, ComputedStanding[]>,
  thirdsRanking: ThirdRanking[],
  annexCOption: AnnexCOption | null,
  hintsByMatchId?: Map<number, KoTiebreakHint>,
): MatchUpdate[] {
  if (!areAllGroupsMature(matches)) {
    // Limpa os jogos KO (caso tenham sido populados antes e algum jogo regrediu)
    const ko = matches.filter(m =>
      m.phase !== 'group_stage_1' &&
      m.phase !== 'group_stage_2' &&
      m.phase !== 'group_stage_3'
    );
    return ko.map(m => ({ match_id: m.id, home_team_id: null, away_team_id: null }));
  }

  const teamById = new Map(teams.map(t => [t.id, t]));
  const updates: MatchUpdate[] = [];

  const order = matches
    .filter(m => m.phase !== 'group_stage_1' && m.phase !== 'group_stage_2' && m.phase !== 'group_stage_3')
    .sort((a, b) => a.id - b.id);

  // Cópia local mutável dos matches — vamos materializando os IDs para que
  // resolveções posteriores de `winner_M*` enxerguem os IDs corretos.
  const localMatches: Match[] = matches.map(m => ({ ...m }));
  const setLocalIds = (id: number, h: number | null, a: number | null) => {
    const lm = localMatches.find(x => x.id === id)!;
    lm.home_team_id = h;
    lm.away_team_id = a;
  };

  for (const m of order) {
    const homeRes = m.home_placeholder
      ? resolvePlaceholder(m.home_placeholder, standings, thirdsRanking, annexCOption, localMatches, teamById, hintsByMatchId)
      : { team: m.home_team_id ? teamById.get(m.home_team_id) ?? null : null };
    const awayRes = m.away_placeholder
      ? resolvePlaceholder(m.away_placeholder, standings, thirdsRanking, annexCOption, localMatches, teamById, hintsByMatchId)
      : { team: m.away_team_id ? teamById.get(m.away_team_id) ?? null : null };

    const hId = homeRes.team?.id ?? null;
    const aId = awayRes.team?.id ?? null;
    updates.push({ match_id: m.id, home_team_id: hId, away_team_id: aId });
    setLocalIds(m.id, hId, aId);
  }
  return updates;
}

/**
 * Helper para simulação local (cliente):
 * dado matches + standings + Anexo C + hints (palpites de pênaltis do usuário),
 * retorna uma cópia dos matches com home_team_id/away_team_id já preenchidos
 * para TODOS os jogos KO.
 */
export function simulateBracket(
  matches: Match[],
  teams: Team[],
  standings: Map<GroupCode, ComputedStanding[]>,
  thirdsRanking: ThirdRanking[],
  annexCOption: AnnexCOption | null,
  hintsByMatchId?: Map<number, KoTiebreakHint>,
): Match[] {
  const updates = populateKnockoutMatches(matches, teams, standings, thirdsRanking, annexCOption, hintsByMatchId);
  const byId = new Map(updates.map(u => [u.match_id, u]));
  return matches.map(m => {
    const u = byId.get(m.id);
    if (!u) return m;
    return { ...m, home_team_id: u.home_team_id, away_team_id: u.away_team_id };
  });
}
