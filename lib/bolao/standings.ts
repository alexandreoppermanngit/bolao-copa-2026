/**
 * CLASSIFICAÇÃO DE GRUPOS + MELHORES 3ºs COLOCADOS
 *
 * Critérios de desempate (regulamento FIFA — replicado da planilha):
 *   1) Pontos
 *   2) Saldo de gols
 *   3) Gols pró
 *   4) Conduta (não automatizado)
 *   5) Ranking FIFA (não automatizado)
 *   → desempate final por ordem alfabética da seleção
 *
 * REGRA DE MATURIDADE (nova):
 *   Um grupo só é considerado "maduro" para alimentar o mata-mata quando
 *   tem pelo menos 2 jogos com placar preenchido. Enquanto isso, a chave
 *   eliminatória mostra placeholders ("aguardando definição").
 */

import type { Match, GroupCode, Team, GroupStanding } from '@/types/database';

export interface ComputedStanding extends GroupStanding {
  rank: number;     // 1..4 dentro do grupo
}

/** Mínimo de jogos preenchidos POR GRUPO para o grupo ser considerado "maduro". */
export const MIN_GAMES_PER_GROUP_FOR_BRACKET = 2;

/** Computa classificação de cada grupo a partir dos jogos. */
export function computeGroupStandings(
  teams: Team[],
  matches: Match[],
): Map<GroupCode, ComputedStanding[]> {
  const result = new Map<GroupCode, ComputedStanding[]>();
  const groupCodes: GroupCode[] = ['A','B','C','D','E','F','G','H','I','J','K','L'];

  for (const gc of groupCodes) {
    const teamsInGroup = teams.filter(t => t.group_code === gc);
    const standings: Omit<ComputedStanding, 'rank'>[] = teamsInGroup.map(t => ({
      team_id: t.id,
      team_name: t.name,
      group_code: gc,
      played: 0, wins: 0, draws: 0, losses: 0,
      goals_for: 0, goals_against: 0, goal_diff: 0, points: 0,
    }));
    const idx = new Map(standings.map((s, i) => [s.team_id, i]));

    const groupMatches = matches.filter(m =>
      m.group_code === gc &&
      m.home_team_id != null && m.away_team_id != null &&
      m.home_score != null && m.away_score != null,
    );

    for (const m of groupMatches) {
      const h = idx.get(m.home_team_id!)!;
      const a = idx.get(m.away_team_id!)!;
      const sh = standings[h], sa = standings[a];
      sh.played++; sa.played++;
      sh.goals_for += m.home_score!; sh.goals_against += m.away_score!;
      sa.goals_for += m.away_score!; sa.goals_against += m.home_score!;
      if (m.home_score! > m.away_score!) {
        sh.wins++; sh.points += 3; sa.losses++;
      } else if (m.home_score! < m.away_score!) {
        sa.wins++; sa.points += 3; sh.losses++;
      } else {
        sh.draws++; sh.points++; sa.draws++; sa.points++;
      }
    }
    for (const s of standings) s.goal_diff = s.goals_for - s.goals_against;

    standings.sort((a, b) => (
      b.points - a.points ||
      b.goal_diff - a.goal_diff ||
      b.goals_for - a.goals_for ||
      a.team_name.localeCompare(b.team_name, 'pt-BR')
    ));

    result.set(gc, standings.map((s, i) => ({ ...s, rank: i + 1 })));
  }
  return result;
}

/**
 * Conta jogos de cada grupo que já têm placar preenchido (home_score e away_score não-null).
 */
export function countPlayedGamesPerGroup(matches: Match[]): Map<GroupCode, number> {
  const m = new Map<GroupCode, number>();
  for (const g of ['A','B','C','D','E','F','G','H','I','J','K','L'] as GroupCode[]) {
    m.set(g, 0);
  }
  for (const match of matches) {
    if (!match.group_code) continue;
    if (match.home_score != null && match.away_score != null) {
      m.set(match.group_code, (m.get(match.group_code) ?? 0) + 1);
    }
  }
  return m;
}

/**
 * Retorna true se TODOS os 12 grupos têm pelo menos `MIN_GAMES_PER_GROUP_FOR_BRACKET`
 * jogos preenchidos. Quando true, é seguro popular o mata-mata.
 */
export function areAllGroupsMature(matches: Match[]): boolean {
  const counts = countPlayedGamesPerGroup(matches);
  return Array.from(counts.values()).every(c => c >= MIN_GAMES_PER_GROUP_FOR_BRACKET);
}

/** Time pela posição "1A", "2C", "3F" etc. */
export function teamByPositionCode(
  standings: Map<GroupCode, ComputedStanding[]>,
  code: string,
): ComputedStanding | null {
  if (!/^[1-4][A-L]$/.test(code)) return null;
  const pos = Number(code[0]) - 1;
  const grp = code[1] as GroupCode;
  return standings.get(grp)?.[pos] ?? null;
}

export interface ThirdRanking {
  group: GroupCode;
  team: ComputedStanding;
  rank: number;
}

export function computeThirdPlaceRanking(
  standings: Map<GroupCode, ComputedStanding[]>,
): ThirdRanking[] {
  const thirds: { group: GroupCode; team: ComputedStanding }[] = [];
  for (const [grp, list] of standings) {
    const third = list[2];
    if (third) thirds.push({ group: grp, team: third });
  }
  thirds.sort((a, b) => (
    b.team.points - a.team.points ||
    b.team.goal_diff - a.team.goal_diff ||
    b.team.goals_for - a.team.goals_for ||
    a.team.team_name.localeCompare(b.team.team_name, 'pt-BR')
  ));
  return thirds.map((x, i) => ({ ...x, rank: i + 1 }));
}

export function sortedKeyOfQualifyingThirds(thirds: ThirdRanking[]): string {
  return thirds
    .filter(t => t.rank <= 8)
    .map(t => t.group)
    .sort()
    .join('');
}
