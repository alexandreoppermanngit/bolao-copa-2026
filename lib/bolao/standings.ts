/**
 * CLASSIFICAÇÃO DE GRUPOS + MELHORES 3ºs COLOCADOS
 *
 * Critérios de desempate:
 *
 *   Modo 'simple' (default — usado em simulações dos usuários):
 *     1) Pontos
 *     2) Saldo de gols
 *     3) Gols pró
 *     4) Ordem alfabética (estabilidade técnica)
 *
 *   Modo 'head_to_head' (v75 — usado nos caminhos REAIS/oficiais):
 *     1) Pontos
 *     2) CONFRONTO DIRETO entre os empatados (mini-tabela)
 *     3) Saldo de gols (geral)
 *     4) Gols pró (geral)
 *     5) Ordem alfabética (estabilidade)
 *
 * Por que separar:
 *   A interpretação dos PALPITES de cada usuário foi feita com a regra
 *   antiga ('simple'). Mudar globalmente afetaria os classificados que o
 *   usuário "viu" quando apostou — e os snapshots já gravados em
 *   `bets.bet_home_team_id`/`bet_away_team_id`. A regra nova ('head_to_head')
 *   vale APENAS para o cálculo OFICIAL (recalcBracket, classificados reais,
 *   pontuação por classificados) — onde o que importa é refletir como o
 *   ranking real da Copa funciona.
 *
 * REGRA DE MATURIDADE:
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

/** v75 — modo de desempate. */
export type TieBreakerMode = 'simple' | 'head_to_head';

/** Computa classificação de cada grupo a partir dos jogos. */
export function computeGroupStandings(
  teams: Team[],
  matches: Match[],
  opts?: { tieBreakerMode?: TieBreakerMode },
): Map<GroupCode, ComputedStanding[]> {
  const mode: TieBreakerMode = opts?.tieBreakerMode ?? 'simple';
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

    if (mode === 'head_to_head') {
      sortStandingsWithHeadToHead(standings, groupMatches);
    } else {
      standings.sort((a, b) => (
        b.points - a.points ||
        b.goal_diff - a.goal_diff ||
        b.goals_for - a.goals_for ||
        a.team_name.localeCompare(b.team_name, 'pt-BR')
      ));
    }

    result.set(gc, standings.map((s, i) => ({ ...s, rank: i + 1 })));
  }
  return result;
}

// ---------------------------------------------------------------------
// v75 — Confronto direto (head-to-head) entre seleções empatadas em pontos
// ---------------------------------------------------------------------

type SimpleStanding = Omit<ComputedStanding, 'rank'>;

/**
 * Ordena standings respeitando confronto direto entre empatados em pontos.
 *
 * Pipeline:
 *   1. Particiona em grupos de empatados por pontos.
 *   2. Para cada grupo com >= 2 times, monta mini-tabela usando APENAS os
 *      jogos entre os empatados (pontos H2H + saldo H2H + gols pró H2H).
 *   3. Ordena cada partição pela mini-tabela. Empate persistente cai para
 *      saldo geral → gols pró geral → nome (estável).
 *   4. Concatena partições em ordem decrescente de pontos.
 *
 * Muta o array `standings` (mesma semântica do antigo `.sort()`).
 */
function sortStandingsWithHeadToHead(
  standings: SimpleStanding[],
  groupMatches: Match[],
): void {
  // Particiona por pontos
  const byPoints = new Map<number, SimpleStanding[]>();
  for (const s of standings) {
    const arr = byPoints.get(s.points) ?? [];
    arr.push(s);
    byPoints.set(s.points, arr);
  }
  const pointGroups = [...byPoints.entries()].sort((a, b) => b[0] - a[0]);

  // Para cada partição, ordena com fallback em cadeia
  const ordered: SimpleStanding[] = [];
  for (const [, part] of pointGroups) {
    if (part.length === 1) {
      ordered.push(part[0]);
      continue;
    }
    // Mini-tabela de confronto direto: só jogos onde AMBOS os times são empatados
    const ids = new Set(part.map(p => p.team_id));
    const h2h = new Map<number, { pts: number; gd: number; gf: number }>();
    for (const p of part) h2h.set(p.team_id, { pts: 0, gd: 0, gf: 0 });
    for (const m of groupMatches) {
      if (!ids.has(m.home_team_id!) || !ids.has(m.away_team_id!)) continue;
      const h = h2h.get(m.home_team_id!)!;
      const a = h2h.get(m.away_team_id!)!;
      const hs = m.home_score!, as = m.away_score!;
      h.gf += hs; h.gd += hs - as;
      a.gf += as; a.gd += as - hs;
      if (hs > as) h.pts += 3;
      else if (hs < as) a.pts += 3;
      else { h.pts += 1; a.pts += 1; }
    }
    part.sort((a, b) => {
      const ha = h2h.get(a.team_id)!;
      const hb = h2h.get(b.team_id)!;
      // 1) pontos no H2H
      if (hb.pts !== ha.pts) return hb.pts - ha.pts;
      // 2) saldo no H2H
      if (hb.gd !== ha.gd) return hb.gd - ha.gd;
      // 3) gols pró no H2H
      if (hb.gf !== ha.gf) return hb.gf - ha.gf;
      // 4) Fallback geral: saldo, gols, nome (estabilidade)
      if (b.goal_diff !== a.goal_diff) return b.goal_diff - a.goal_diff;
      if (b.goals_for !== a.goals_for) return b.goals_for - a.goals_for;
      return a.team_name.localeCompare(b.team_name, 'pt-BR');
    });
    ordered.push(...part);
  }

  // Substitui o conteúdo de `standings` mantendo a referência
  for (let i = 0; i < standings.length; i++) standings[i] = ordered[i];
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
