/**
 * Pontuação por SELEÇÕES CLASSIFICADAS em cada fase.
 *
 * Fases consideradas (adaptadas para Copa 2026, com R32):
 *   - group_stage:  avança da fase de grupos para R32         (32 times)
 *   - r32:          vence R32 e avança para R16               (16 times)
 *   - r16:          vence R16 e avança para QF                (8 times)
 *   - quarters:     vence QF e avança para SF                 (4 times)
 *   - semis:        vence SF e avança para final              (2 times)
 *   - third_place:  ganha disputa de 3º                       (1 time)
 *   - runner_up:    PERDE a final (vice-campeão)              (1 time) — migration 006
 *   - champion:     ganha a final                             (1 time)
 *
 * Pontos base configurados em `settings.pts_qual_*`.
 *
 * FATOR MULTIPLICADOR DE CLASSIFICAÇÃO (diferente do fator zebra de PLACAR):
 *   fator = (total_apostadores - apostadores_que_chutaram_essa_selecao_nessa_fase) / total
 *   pontos_finais = pontos_base × (1 + fator)
 *
 * - Se muita gente apostou na seleção que avançou, fator ≈ 0 → pts_finais ≈ base
 * - Se pouca gente apostou e ela passou, fator ≈ 1 → pts_finais ≈ 2× base
 */

import type {
  Match, Team, Bet, AnnexCOption, Settings,
  QualificationPhase, GroupCode,
} from '@/types/database';
import {
  computeGroupStandings, computeThirdPlaceRanking,
  sortedKeyOfQualifyingThirds, areAllGroupsMature,
  countPlayedGamesPerGroup,
} from './standings';
import {
  findAnnexCOption, simulateBracket,
  determineMatchWinnerId, determineMatchLoserId,
  type KoTiebreakHint,
} from './bracket';

export const PHASE_ORDER: QualificationPhase[] = [
  'group_stage', 'r32', 'r16', 'quarters', 'semis',
  'third_place', 'runner_up', 'champion',
];

/**
 * Ordem de EXIBIÇÃO de fases para o usuário final no detalhamento de pontuação.
 * Coincide com PHASE_ORDER hoje, mas é exportado separadamente para que a UI
 * NÃO dependa do `.order('phase')` do Supabase (que segue a ordem física do
 * enum no Postgres — e o enum tem 'runner_up' depois de 'champion' por causa
 * da migration 006, gerando uma ordem visualmente incorreta).
 *
 * Use sempre esta constante para ordenar `quals` no client:
 *   quals.sort((a, b) => PHASE_DISPLAY_ORDER.indexOf(a.phase) - PHASE_DISPLAY_ORDER.indexOf(b.phase));
 */
export const PHASE_DISPLAY_ORDER: QualificationPhase[] = [
  'group_stage', 'r32', 'r16', 'quarters', 'semis',
  'third_place', 'runner_up', 'champion',
];

/**
 * Decide se uma fase de classificação já foi CONCLUÍDA com base nos jogos
 * REAIS. "Concluída" = os jogos necessários para determinar quem chegou
 * àquela fase já têm vencedor decidido.
 *
 * Usado pela UI para diferenciar entre "errou" (❌) e "ainda pendente" (⏳)
 * quando `is_correct = false`. Não interfere no cálculo de pontuação.
 *
 * Convenções:
 *   - Empate em KO sem pens preenchidos é considerado NÃO decidido.
 *   - `runner_up` e `champion` dependem do mesmo jogo `final`.
 */
export function isPhaseCompleted(
  phase: QualificationPhase,
  matches: Match[],
): boolean {
  switch (phase) {
    case 'group_stage':
      // Fase de grupos: 72 jogos (group_stage_1/2/3). Concluída quando
      // todos têm placar — aí dá pra determinar 12 1ºs + 12 2ºs + 8 melhores 3ºs.
      return allGroupGamesPlayed(matches);
    case 'r32':         return allKoDecided(matches, 'round_of_32');
    case 'r16':         return allKoDecided(matches, 'round_of_16');
    case 'quarters':    return allKoDecided(matches, 'quarter_finals');
    case 'semis':       return allKoDecided(matches, 'semi_finals');
    case 'third_place': return allKoDecided(matches, 'third_place');
    case 'runner_up':
    case 'champion':    return allKoDecided(matches, 'final');
  }
}

function allGroupGamesPlayed(matches: Match[]): boolean {
  const group = matches.filter(m =>
    m.phase === 'group_stage_1' || m.phase === 'group_stage_2' || m.phase === 'group_stage_3'
  );
  if (group.length === 0) return false;
  return group.every(m => m.home_score != null && m.away_score != null);
}

/**
 * v72 — Cada grupo da Copa 2026 tem 4 times → 6 jogos (round-robin).
 * Constante usada pelos gates de pontuação por classificação.
 */
export const GAMES_PER_GROUP = 6;

/**
 * v72 — Conjunto de grupos com TODOS os 6 jogos preenchidos (placar real).
 * Usado para gatear quem é 1º/2º "oficial" antes de pontuar classificados.
 */
export function getCompletedGroups(matches: Match[]): Set<GroupCode> {
  const counts = countPlayedGamesPerGroup(matches);
  const done = new Set<GroupCode>();
  for (const [g, n] of counts) {
    if (n >= GAMES_PER_GROUP) done.add(g);
  }
  return done;
}

/**
 * v72 — A primeira fase inteira foi concluída? Necessário para liberar
 * pontuação por melhores terceiros (que só são definidos depois do
 * último jogo da fase de grupos).
 */
export function isGroupStageFullyComplete(matches: Match[]): boolean {
  return allGroupGamesPlayed(matches);
}

function allKoDecided(matches: Match[], phase: Match['phase']): boolean {
  const list = matches.filter(m => m.phase === phase);
  if (list.length === 0) return false;
  return list.every(m => {
    if (m.home_score == null || m.away_score == null) return false;
    if (m.home_score !== m.away_score) return true;          // vencedor por placar
    return m.home_pens != null && m.away_pens != null;       // empate → precisa pens
  });
}

export function phasePointsBase(phase: QualificationPhase, settings: Settings): number {
  switch (phase) {
    case 'group_stage': return settings.pts_qual_groups;
    case 'r32':         return settings.pts_qual_r32;
    case 'r16':         return settings.pts_qual_r16;
    case 'quarters':    return settings.pts_qual_quarters;
    case 'semis':       return settings.pts_qual_semis;
    case 'third_place': return settings.pts_qual_third;
    case 'runner_up':   return settings.pts_qual_runner_up;
    case 'champion':    return settings.pts_qual_champion;
  }
}

export function qualificationZebraFactor(
  totalBettors: number,
  bettorsOnThisTeamInThisPhase: number,
): number {
  if (totalBettors <= 0) return 0;
  return (totalBettors - bettorsOnThisTeamInThisPhase) / totalBettors;
}

export function calculateQualificationPoints(
  basePoints: number,
  factor: number,
): { factorAsMult: number; finalPoints: number } {
  const factorAsMult = 1 + factor;
  return { factorAsMult, finalPoints: Number((basePoints * factorAsMult).toFixed(2)) };
}

/**
 * Dado um conjunto de matches (já com home/away_score), extrai os times
 * que CHEGARAM (foram para a fase) em cada fase de qualificação.
 *
 * NÃO confunda "chegar à fase" com "vencer a fase":
 *   - 'group_stage'  → times que avançaram dos grupos (entram no R32)
 *   - 'r32'          → vencedores de R32 (entram em R16)
 *   - 'r16'          → vencedores de R16 (entram em QF)
 *   - 'quarters'     → vencedores de QF (entram em SF)
 *   - 'semis'        → finalistas (vencedores de SF)
 *   - 'third_place'  → vencedor do jogo do 3º
 *   - 'champion'     → vencedor da final
 *
 * @param hintsByMatchId opcional — mapa match_id → KoTiebreakHint. Quando o palpite
 *   do usuário em um KO é empate (e ele marca `knockout_advancer`), os jogos reais
 *   não terão pens preenchidos para esse usuário; o hint indica quem avança.
 *   Sem este parâmetro, jogos KO empatados sem pens são considerados sem vencedor,
 *   o que faz a fase correspondente perder esse time. (bug v55)
 */
export function extractAdvancingTeams(
  matches: Match[],
  hintsByMatchId?: Map<number, KoTiebreakHint>,
  opts?: {
    /**
     * v72 — quando true, aplica o "gate de pontuação":
     *  - 1º e 2º colocados só entram se o GRUPO daquele time tiver 6/6 jogos.
     *  - Melhores 3ºs só entram se TODOS os 12 grupos tiverem 6/6 jogos.
     * Usado para a árvore REAL no `recalcAllQualificationScores`.
     * Para a árvore PREVISTA do usuário, manter false (default).
     * Exige `teams` para calcular standings.
     */
    gateGroupStage?: boolean;
    teams?: Team[];
  },
): Record<QualificationPhase, Set<number>> {
  const result: Record<QualificationPhase, Set<number>> = {
    group_stage: new Set(), r32: new Set(), r16: new Set(),
    quarters: new Set(), semis: new Set(), third_place: new Set(),
    runner_up: new Set(), champion: new Set(),
  };

  if (opts?.gateGroupStage && opts.teams) {
    // ----- v72 gate: reconstruir result.group_stage a partir de standings.
    // 1º e 2º só de grupos completos; 3ºs só se todos os grupos completos.
    const standings = computeGroupStandings(opts.teams, matches);
    const completed = getCompletedGroups(matches);
    for (const g of completed) {
      const std = standings.get(g);
      if (!std) continue;
      if (std[0]) result.group_stage.add(std[0].team_id);    // 1º
      if (std[1]) result.group_stage.add(std[1].team_id);    // 2º
    }
    if (isGroupStageFullyComplete(matches)) {
      // Melhores 3ºs entram só quando TODOS os grupos terminaram.
      const thirds = computeThirdPlaceRanking(standings);
      for (const t of thirds) {
        if (t.rank <= 8) result.group_stage.add(t.team.team_id);
      }
    }
  } else {
    // Comportamento original (usado pela árvore PREVISTA do usuário):
    // pega home/away dos R32 como antes. Pode ter 32 ids quando o bracket
    // está populado (mesmo com grupos parciais — daí o gate para o REAL).
    for (const m of matches) {
      if (m.phase === 'round_of_32') {
        if (m.home_team_id) result.group_stage.add(m.home_team_id);
        if (m.away_team_id) result.group_stage.add(m.away_team_id);
      }
    }
  }

  // Vencedores de cada fase — agora usa determineMatchWinnerId do bracket.ts,
  // que respeita knockout_advancer quando os scores empatam e não há pens.
  // ALÉM disso, para a fase 'final', registramos o PERDEDOR em `runner_up`
  // (vice-campeão) — migration 006 adicionou essa fase ao enum + scoring.
  for (const m of matches) {
    const w = determineMatchWinnerId(m, hintsByMatchId?.get(m.id));
    if (m.phase === 'final') {
      if (w) result.champion.add(w);
      const l = determineMatchLoserId(m, hintsByMatchId?.get(m.id));
      if (l) result.runner_up.add(l);
      continue;
    }
    if (!w) continue;
    if (m.phase === 'round_of_32')   result.r32.add(w);
    if (m.phase === 'round_of_16')   result.r16.add(w);
    if (m.phase === 'quarter_finals') result.quarters.add(w);
    if (m.phase === 'semi_finals')    result.semis.add(w);
    if (m.phase === 'third_place')    result.third_place.add(w);
  }
  return result;
}

/**
 * Extrai o VICE (perdedor da final). Não faz parte do PHASE_ORDER nem do
 * scoring — usado apenas em /estatisticas para exibir um card adicional.
 */
export function extractRunnerUp(
  matches: Match[],
  hintsByMatchId?: Map<number, KoTiebreakHint>,
): number | null {
  const finalMatch = matches.find(m => m.phase === 'final');
  if (!finalMatch) return null;
  return determineMatchLoserId(finalMatch, hintsByMatchId?.get(finalMatch.id));
}

/**
 * Resultado expandido da simulação por usuário: classificados por fase.
 *
 * NOTA: até a v55, este resultado tinha um campo extra `runnerUp` separado
 * porque o vice não era uma fase do enum. A partir da migration 006, o vice
 * vira fase oficial 'runner_up' e fica dentro de `byPhase.runner_up` (Set
 * com 0 ou 1 elemento por usuário). Mantemos o tipo enxuto.
 */
export interface UserPrediction {
  byPhase: Record<QualificationPhase, Set<number>>;
}

/**
 * Para um usuário e seus palpites, simula a árvore e extrai os times
 * que ELE acredita que vão a cada fase. Usada por `buildPredictionCensus`.
 * `extractUserPredictedTeams` (abaixo) é o wrapper legado.
 *
 * Migration 008: quando as bets já têm `bet_home_team_id`/`bet_away_team_id`
 * preenchidos, usamos esses snapshots como override do bracket — assim a
 * extração não depende mais de `areAllGroupsMature` quando os snapshots
 * suprem os slots necessários. Bets sem snapshot caem na simulação
 * tradicional (compat com bets antigas pré-backfill).
 *
 * v69 — IMPORTANTE: `simulateBracket` re-resolve placeholders KO via
 * standings (ignora `home_team_id` pré-populado quando o match tem
 * `home_placeholder`). Isso fazia `byPhase.champion`/`runner_up`/`third_place`
 * divergirem do que o usuário realmente apostou (visível no snapshot da bet)
 * sempre que a simulação por palpites parciais resolvia diferente.
 *
 * Solução: APÓS o `extractAdvancingTeams`, sobrescrevemos esses 3 sets
 * derivando-os DIRETO da bet do match correspondente (champion/runner_up
 * = bet da final; third_place = bet da disputa de 3º). Snapshot da bet
 * é a fonte de verdade dessas 3 fases — não a simulação.
 */
export function extractUserPrediction(
  userBets: Bet[],
  allMatches: Match[],
  teams: Team[],
  annexCOptions: AnnexCOption[],
): UserPrediction {
  const userBetsByMatch = new Map(userBets.map(b => [b.match_id, b]));

  // Para cada match: aplicar scores E (quando disponível) os snapshots
  // dos times do palpite. Para os matches KO em que o snapshot existe,
  // os `home_team_id`/`away_team_id` ficam definidos antes da simulação
  // — então `extractAdvancingTeams` vê o time apostado correto mesmo se
  // o bracket oficial estava zerado.
  const simMatches: Match[] = allMatches.map(m => {
    const b = userBetsByMatch.get(m.id);
    if (!b) return m;
    const next: Match = {
      ...m,
      home_score: b.home_score,
      away_score: b.away_score,
    };
    if (b.bet_home_team_id != null) next.home_team_id = b.bet_home_team_id;
    if (b.bet_away_team_id != null) next.away_team_id = b.bet_away_team_id;
    return next;
  });

  const hints = new Map<number, KoTiebreakHint>();
  for (const b of userBets) {
    if (b.knockout_advancer) hints.set(b.match_id, { knockout_advancer: b.knockout_advancer });
  }

  // Se os grupos do usuário não estão maduros, ainda assim TENTAMOS extrair
  // o que dá a partir dos snapshots. Para isso, pulamos `simulateBracket`
  // (que precisa de standings dos grupos) e chamamos `extractAdvancingTeams`
  // direto sobre `simMatches` — os slots que têm snapshot vão render times,
  // os que não têm vão render null e simplesmente não entram nas fases.
  let byPhase: Record<QualificationPhase, Set<number>>;
  if (!areAllGroupsMature(simMatches)) {
    byPhase = extractAdvancingTeams(simMatches, hints);
  } else {
    // Caminho completo: simula a árvore para preencher os slots que NÃO têm
    // snapshot, usando standings + Anexo C + hints.
    const standings = computeGroupStandings(teams, simMatches);
    const thirds = computeThirdPlaceRanking(standings);
    const key = sortedKeyOfQualifyingThirds(thirds);
    const opt = key.length === 8 ? findAnnexCOption(key, annexCOptions) : null;
    const resolved = simulateBracket(simMatches, teams, standings, thirds, opt, hints);
    byPhase = extractAdvancingTeams(resolved, hints);
  }

  // v69 — Sobrescrita por SNAPSHOT da bet para 3 fases derivadas de UM
  // jogo específico (sem cascata): champion, runner_up, third_place.
  // Snapshot da bet é fonte de verdade — `simulateBracket` re-resolve
  // placeholders e pode divergir.
  overrideFromBet({
    matchPhase: 'final',
    targets: { winner: 'champion', loser: 'runner_up' },
    allMatches, userBetsByMatch, byPhase,
  });
  overrideFromBet({
    matchPhase: 'third_place',
    targets: { winner: 'third_place' /* sem loser — vice de 3º não pontua */ },
    allMatches, userBetsByMatch, byPhase,
  });

  return { byPhase };
}

/**
 * v69 — Helper que sobrescreve um (ou dois) sets de `byPhase` derivando
 * o vencedor (e opcionalmente o perdedor) DIRETAMENTE da bet do match
 * indicado. A regra para decidir vencedor/perdedor:
 *
 *   1. Se `knockout_advancer === 'home'` → vencedor = home, perdedor = away.
 *   2. Se `knockout_advancer === 'away'` → vencedor = away, perdedor = home.
 *   3. Se `home_score > away_score`     → vencedor = home, perdedor = away.
 *   4. Se `away_score > home_score`     → vencedor = away, perdedor = home.
 *   5. Caso contrário (empate sem advancer): NÃO popula, NÃO inventa.
 *
 * Requer que `bet_home_team_id`/`bet_away_team_id` da bet estejam preenchidos.
 * Se não estiverem, mantém o que veio do `extractAdvancingTeams`.
 */
function overrideFromBet(params: {
  matchPhase: 'final' | 'third_place';
  targets: { winner: QualificationPhase; loser?: QualificationPhase };
  allMatches: Match[];
  userBetsByMatch: Map<number, Bet>;
  byPhase: Record<QualificationPhase, Set<number>>;
}): void {
  const m = params.allMatches.find(x => x.phase === params.matchPhase);
  if (!m) return;
  const bet = params.userBetsByMatch.get(m.id);
  if (!bet) return;
  const h = bet.bet_home_team_id ?? null;
  const a = bet.bet_away_team_id ?? null;
  if (h == null || a == null) return;  // sem snapshot completo, mantém

  let winner: number | null = null;
  let loser: number | null = null;
  if (bet.knockout_advancer === 'home') { winner = h; loser = a; }
  else if (bet.knockout_advancer === 'away') { winner = a; loser = h; }
  else if (bet.home_score > bet.away_score) { winner = h; loser = a; }
  else if (bet.away_score > bet.home_score) { winner = a; loser = h; }
  // empate sem advancer: não há como decidir — mantém o que estava em byPhase.

  if (winner != null) {
    params.byPhase[params.targets.winner].clear();
    params.byPhase[params.targets.winner].add(winner);
  }
  if (params.targets.loser && loser != null) {
    params.byPhase[params.targets.loser].clear();
    params.byPhase[params.targets.loser].add(loser);
  }
}

/**
 * Wrapper de compatibilidade — assinatura inalterada para callers externos.
 */
export function extractUserPredictedTeams(
  userBets: Bet[],
  allMatches: Match[],
  teams: Team[],
  annexCOptions: AnnexCOption[],
): Record<QualificationPhase, Set<number>> {
  return extractUserPrediction(userBets, allMatches, teams, annexCOptions).byPhase;
}

/**
 * Conta, por (phase, team_id), quantos usuários previram aquele time.
 * Usado para calcular o fator zebra de classificação.
 *
 * A fase 'runner_up' (migration 006) já entra em `counts` via PHASE_ORDER;
 * `runnerUpCounts` permanece como alias (Map<team_id, count>) para callers
 * que ainda querem ler o vice sem montar a chave `runner_up:<teamId>`.
 */
export function buildPredictionCensus(
  allUserBets: { userId: string; bets: Bet[] }[],
  allMatches: Match[],
  teams: Team[],
  annexCOptions: AnnexCOption[],
): {
  totalUsers: number;
  counts: Map<string, number>;
  /** alias do counts filtrado por `runner_up:` — preservado por compat. */
  runnerUpCounts: Map<number, number>;
} {
  const counts = new Map<string, number>();
  const runnerUpCounts = new Map<number, number>();
  let totalUsers = 0;
  for (const { bets } of allUserBets) {
    if (bets.length === 0) continue;
    totalUsers++;
    const prediction = extractUserPrediction(bets, allMatches, teams, annexCOptions);
    for (const phase of PHASE_ORDER) {
      for (const teamId of prediction.byPhase[phase]) {
        const key = `${phase}:${teamId}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (phase === 'runner_up') {
          runnerUpCounts.set(teamId, (runnerUpCounts.get(teamId) ?? 0) + 1);
        }
      }
    }
  }
  return { totalUsers, counts, runnerUpCounts };
}

/** Score row de saída para persistência em `user_qualification_scores`. */
export interface QualificationScoreRow {
  user_id: string;
  phase: QualificationPhase;
  team_id: number;
  predicted: boolean;
  is_correct: boolean;
  points_base: number;
  factor: number;
  points_final: number;
}

/**
 * Para um usuário, calcula todas as linhas de pontuação de classificação,
 * baseado nas seleções que ELE previu e nas que REALMENTE avançaram.
 *
 * @param censusCounts contagem global (phase:team_id -> qtde apostadores)
 * @param totalUsers   total de apostadores (denominador do fator)
 */
export function calculateUserQualificationScores(params: {
  userId: string;
  userBets: Bet[];
  allMatches: Match[];
  realAdvancingTeams: Record<QualificationPhase, Set<number>>;
  censusCounts: Map<string, number>;
  totalUsers: number;
  teams: Team[];
  annexCOptions: AnnexCOption[];
  settings: Settings;
}): QualificationScoreRow[] {
  const {
    userId, userBets, allMatches, realAdvancingTeams,
    censusCounts, totalUsers, teams, annexCOptions, settings,
  } = params;

  const predicted = extractUserPredictedTeams(userBets, allMatches, teams, annexCOptions);
  const rows: QualificationScoreRow[] = [];

  for (const phase of PHASE_ORDER) {
    const real = realAdvancingTeams[phase];
    const userPred = predicted[phase];
    const basePts = phasePointsBase(phase, settings);

    // Apenas times que o usuário previu (interesse: só salvamos os preditos)
    for (const teamId of userPred) {
      const isCorrect = real.has(teamId);
      const censusKey = `${phase}:${teamId}`;
      const bettorsOnIt = censusCounts.get(censusKey) ?? 0;
      const factor = qualificationZebraFactor(totalUsers, bettorsOnIt);
      const { finalPoints } = calculateQualificationPoints(
        isCorrect ? basePts : 0,
        factor,
      );
      rows.push({
        user_id: userId,
        phase,
        team_id: teamId,
        predicted: true,
        is_correct: isCorrect,
        points_base: isCorrect ? basePts : 0,
        factor: Number(factor.toFixed(4)),
        points_final: finalPoints,
      });
    }
  }
  return rows;
}
