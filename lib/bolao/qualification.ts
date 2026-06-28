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

// v77 — Status de uma seleção em relação a uma fase de classificação.
export type TeamPhaseStatus = 'reached' | 'pending' | 'eliminated';

/**
 * v77 — Avalia o status visual de um team em uma fase de classificação,
 * a partir do estado REAL dos matches/standings. Devolve:
 *   - 'reached'    — team já alcançou essa fase (acerto se o usuário apostou).
 *   - 'pending'    — ainda dá pra acontecer (fase real não decidiu o time).
 *   - 'eliminated' — team já não pode mais alcançar essa fase.
 *
 * Usado APENAS para exibição em /meus-resultados (visualização granular
 * de "✅ acertou" / "⏳ aguardando" / "❌ eliminada"). NÃO afeta cálculo,
 * UQS ou ranking — todo o backend continua usando `extractAdvancingTeams`
 * + `calculateUserQualificationScores` como antes.
 *
 * Regras (v77c — alinhadas ao spec):
 *
 *   group_stage:
 *     - grupo do team incompleto                   → pending
 *     - grupo completo + pos 1/2                   → reached (já está em real)
 *     - grupo completo + pos 4                     → eliminated
 *     - grupo completo + pos 3 + fase ainda parcial → pending (aguardando 3ºs)
 *     - grupo completo + pos 3 + fase toda completa:
 *         - top-8 melhores 3ºs                     → reached
 *         - fora do top-8                          → eliminated
 *
 *   Exclusões mútuas via final/3º (v77c):
 *     - 'runner_up' + team é campeão (venceu a final) → eliminated
 *     - 'champion'  + team é vice (perdeu a final)    → eliminated
 *     - 'third_place' + team é finalista (real.semis) → eliminated
 *
 *   Propagação de eliminação de grupos (v77e):
 *     - Se groupStatus = 'eliminated' (4º colocado OU 3º fora dos melhores
 *       após 1ª fase completa), QUALQUER phase KO retorna 'eliminated'.
 *       O time não tem caminho para nenhum KO.
 *
 *   KO (r32, r16, quarters, semis, third_place, runner_up, champion):
 *     - team em real[phase]                       → reached
 *     - walk-forward (v77c+v77d): só dispara quando a fase PRÉ-REQUISITO
 *       está TOTALMENTE decidida (= o bracket atual é definitivo, não
 *       provisório). Se todas as partidas da fase decidida têm home/away
 *       preenchidos e o team não é participante de nenhuma → eliminated.
 *       Exemplo do que isso EVITA: BEL em 3º com grupo aberto sendo
 *       cravada como ❌ em r32 porque o bracket provisório não a inclui
 *       (ela ainda pode subir como melhor 3º quando a fase fechar).
 *     - team perdeu em KO match cuja fase elimina  → eliminated
 *     - caso contrário                             → pending
 *
 *   Casos especiais por phase:
 *     - 'champion'   : qualquer derrota em KO elimina.
 *     - 'runner_up'  : derrota antes da final elimina; perder a final é
 *                       reached (capturado pelo fast path); vencer a final
 *                       é eliminated (exclusão mútua acima).
 *     - 'third_place': derrota em R32/R16/QF/3º place elimina; derrota em
 *                       SF é OK (é como o time chega ao jogo de 3º).
 *     - r32/r16/quarters/semis: derrota numa fase ≤ a apostada elimina.
 */
export function evaluateTeamPhaseStatus(
  teamId: number,
  phase: QualificationPhase,
  matches: Match[],
  teams: Team[],
  /**
   * v77e — opcional: pré-computado para perf quando o caller invoca a fn
   * em loop (ex.: /estatisticas itera ~N times × 8 fases). Se não passado,
   * é calculado internamente (comportamento dos callers existentes não muda).
   */
  precomputedReal?: Record<QualificationPhase, Set<number>>,
): TeamPhaseStatus {
  // 1) Já alcançou? (usa REAL com gate v72 + h2h v75 — fonte única).
  const real = precomputedReal ?? extractAdvancingTeams(matches, undefined, {
    gateGroupStage: true, teams,
  });
  if (real[phase].has(teamId)) return 'reached';

  // 2) v77c — Exclusões mútuas decididas pela final / pela semi:
  //    - Quem ganhou a final NÃO é vice; quem perdeu a final NÃO é campeão.
  //    - Quem é finalista (venceu a SF) NÃO disputa o 3º lugar.
  if (phase === 'runner_up' && real.champion.has(teamId)) return 'eliminated';
  if (phase === 'champion'  && real.runner_up.has(teamId)) return 'eliminated';
  if (phase === 'third_place' && real.semis.has(teamId)) return 'eliminated';

  // 3) Fase de grupos (helper isolado — também é PRÉ-REQUISITO de KO).
  // v77f — Passa `real` para o helper conseguir reconhecer top-8 melhores
  // 3ºs como 'reached' (eles entram em `real.group_stage` pelo gate v72,
  // mas o fast path do caller só checa `real[phase]` da fase QUERIDA,
  // então pra phase !== 'group_stage' o helper precisa do `real` direto).
  const groupStatus = evaluateGroupStageStatusInternal(teamId, matches, teams, real);
  if (phase === 'group_stage') return groupStatus;

  // 4) v77e — Propagação de eliminação de grupos para KO:
  //    Se o time foi eliminado na fase de grupos (4º com grupo fechado, ou 3º
  //    fora dos melhores com 1ª fase fechada), ele NÃO pode mais alcançar
  //    NENHUMA fase KO. Sem essa propagação, `evaluateKOPhaseStatus` itera
  //    apenas `teamMatches` decididos e pula group_stage_* por design —
  //    retornaria `pending` indevidamente para r32/r16/.../champion.
  if (groupStatus === 'eliminated') return 'eliminated';

  // 5) Fases KO: walk-forward defensivo (gateado por pré-requisito da v77d)
  //    + derrotas reais decididas em matches do time.
  return evaluateKOPhaseStatus(teamId, phase, matches);
}

/**
 * v77e + v77f — Helper interno: status de uma seleção em group_stage,
 * isolado para ser reaproveitado pela propagação de eliminação para KO.
 *
 * v77f — CRÍTICO: precisa receber `real` para conseguir reconhecer top-8
 * melhores 3ºs como 'reached'. Sem isso, o helper devolvia 'eliminated'
 * para QUALQUER 3º colocado com 1ª fase fechada (inclusive os top-8),
 * porque o "fast path captura top-8" mencionado na v77e só funcionava
 * quando o caller queria phase==='group_stage'. Pra qualquer outra fase
 * (r16/quartas/.../champion), o fast path em `evaluateTeamPhaseStatus`
 * checa `real[phase]` (não `real.group_stage`), e o helper era invocado
 * SEMPRE — não só para 3ºs fora dos top-8.
 *
 * Regras:
 *   - real.group_stage.has(team)             → 'reached' (1º/2º fechado OU 3º top-8)
 *   - team não no time/grupos abertos        → 'pending'
 *   - 4º colocado de grupo fechado           → 'eliminated'
 *   - 3º com 1ª fase aberta                  → 'pending'
 *   - 3º com 1ª fase fechada e NÃO no real   → 'eliminated' (3º fora dos top-8)
 */
function evaluateGroupStageStatusInternal(
  teamId: number,
  matches: Match[],
  teams: Team[],
  real: Record<QualificationPhase, Set<number>>,
): TeamPhaseStatus {
  // v77f — Fast path local: se o time está em real.group_stage, ele JÁ
  // avançou para o KO (1º/2º com grupo fechado, ou 3º top-8 com 1ª fase
  // fechada — ambos respeitam o gate v72). Esse é o caminho que estava
  // faltando e causava marcação falsa de 'eliminated' para top-8 thirds.
  if (real.group_stage.has(teamId)) return 'reached';

  const team = teams.find(t => t.id === teamId);
  if (!team) return 'pending';
  const completed = getCompletedGroups(matches);
  if (!completed.has(team.group_code)) return 'pending';
  const standings = computeGroupStandings(teams, matches, {
    tieBreakerMode: 'head_to_head',
  });
  const std = standings.get(team.group_code);
  const idx = std?.findIndex(s => s.team_id === teamId) ?? -1;
  if (idx === 3) return 'eliminated';  // 4º — sempre eliminado se grupo fechou
  if (idx === 2) {                     // 3º
    if (!isGroupStageFullyComplete(matches)) return 'pending';
    // 1ª fase fechou + não está em real.group_stage (não passou no fast path
    // acima) → confirmado fora dos top-8 → eliminated.
    return 'eliminated';
  }
  // 1º/2º que NÃO estão em real.group_stage seria estranho (gate v72 inclui
  // ambos quando o grupo está fechado). Defensivo: 'pending'.
  return 'pending';
}

function evaluateKOPhaseStatus(
  teamId: number,
  phase: QualificationPhase,
  matches: Match[],
): TeamPhaseStatus {
  // Ordem oficial dos matches KO (do mais cedo para o mais tarde).
  const koOrder: Match['phase'][] = [
    'round_of_32', 'round_of_16', 'quarter_finals', 'semi_finals',
    'third_place', 'final',
  ];
  const koPhaseIndex = (mp: Match['phase']) => koOrder.indexOf(mp);

  // Match real que "decide" a aposta de cada fase (vencer = alcançar a fase;
  // exceção: 'runner_up' = perder a final).
  const decidingMatchFor: Partial<Record<QualificationPhase, Match['phase']>> = {
    r32: 'round_of_32',
    r16: 'round_of_16',
    quarters: 'quarter_finals',
    semis: 'semi_finals',
    third_place: 'third_place',
    runner_up: 'final',
    champion: 'final',
  };

  const decidingPhase = decidingMatchFor[phase];
  if (!decidingPhase) return 'pending';  // defesa — group_stage não chega aqui
  const decidingIdx = koPhaseIndex(decidingPhase);

  // v77d — Fase PRÉ-REQUISITO que precisa estar TOTALMENTE decidida antes
  // de podermos usar o bracket real como evidência conclusiva de eliminação.
  //
  //   Por que esse cuidado? `populateKnockoutMatches` (bracket.ts) popula
  //   R32 provisoriamente assim que cada grupo tem ≥2 jogos jogados
  //   (`areAllGroupsMature` / `MIN_GAMES_PER_GROUP_FOR_BRACKET = 2`).
  //   Se o grupo de um 3º colocado ainda não fechou, o bracket provisório
  //   pode NÃO incluí-lo em R32 — mas ele ainda pode subir para a lista
  //   dos 8 melhores 3ºs quando a 1ª fase inteira fechar. Cravar
  //   `eliminated` baseado nesse bracket é PRECIPITADO.
  //
  //   Regra: só confiamos no bracket de `decidingPhase` quando a fase
  //   ANTERIOR (fonte dos times que entram nela) está totalmente fechada:
  //     - r32 → group_stage totalmente fechado (12×6 jogos)
  //     - r16 → r32 totalmente decidido
  //     - quarters → r16 totalmente decidido
  //     - semis → quarters totalmente decidido
  //     - third_place / runner_up / champion → semis totalmente decidido
  const prereqPhase: Partial<Record<QualificationPhase, QualificationPhase>> = {
    r32: 'group_stage',
    r16: 'r32',
    quarters: 'r16',
    semis: 'quarters',
    third_place: 'semis',
    runner_up: 'semis',
    champion: 'semis',
  };
  const prereq = prereqPhase[phase];

  // v77c+v77d — Walk-forward defensivo (gateado pela fase pré-requisito):
  // Só dispara quando a fase ANTERIOR está totalmente decidida (= o
  // bracket da fase atual é definitivo, não provisório).
  if (prereq && isPhaseCompleted(prereq, matches)) {
    const decidingMatches = matches.filter(m => m.phase === decidingPhase);
    if (decidingMatches.length > 0) {
      const allPopulated = decidingMatches.every(m =>
        m.home_team_id != null && m.away_team_id != null
      );
      if (allPopulated) {
        const isParticipant = decidingMatches.some(m =>
          m.home_team_id === teamId || m.away_team_id === teamId
        );
        if (!isParticipant) return 'eliminated';
      }
    }
  }

  // Detecção tradicional: derrota explícita do team em fase ≤ decidingIdx.
  const teamMatches = matches.filter(m =>
    (m.home_team_id === teamId || m.away_team_id === teamId) &&
    m.home_score != null && m.away_score != null
  );

  for (const m of teamMatches) {
    const mp = m.phase;
    // Group stages não eliminam KO (são considerados pelo gate de groups).
    if (mp === 'group_stage_1' || mp === 'group_stage_2' || mp === 'group_stage_3') continue;
    const w = determineMatchWinnerId(m);
    if (w == null) continue;                    // empate sem pens — não decide
    if (w === teamId) continue;                  // venceu — não elimina
    const mpIdx = koPhaseIndex(mp);
    if (mpIdx < 0) continue;                     // fase desconhecida — defesa
    // Time PERDEU este match KO. Avaliar se elimina a aposta:

    if (phase === 'champion') {
      // Qualquer derrota em KO elimina campeão.
      return 'eliminated';
    }
    if (phase === 'runner_up') {
      // Perder A FINAL → reached (já tratado no fast path). Aqui é defesa:
      // se caímos com mp === 'final' é porque o fast path não marcou; não
      // queremos pintar como eliminated indevidamente — pulamos.
      if (mp === 'final') continue;
      return 'eliminated';
    }
    if (phase === 'third_place') {
      // Perder SF é OK (assim o time chega ao jogo de 3º).
      if (mp === 'semi_finals') continue;
      // Perder A FINAL não impede o 3º (n/a — quem chega à final não joga 3º,
      // mas a derrota na final em si não é o que elimina o caminho do 3º).
      if (mp === 'final') continue;
      // Qualquer outra derrota elimina (R32/R16/QF/3º place).
      return 'eliminated';
    }
    // r32 / r16 / quarters / semis: derrota numa fase ≤ a apostada elimina.
    if (mpIdx <= decidingIdx) return 'eliminated';
  }

  return 'pending';
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
    // v75 — Caminho REAL/oficial: usa head-to-head no desempate.
    const standings = computeGroupStandings(opts.teams, matches, {
      tieBreakerMode: 'head_to_head',
    });
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

// v76 — `emptyPrediction()` foi removida. Ela tinha sido criada para
// devolver uma `UserPrediction` zerada quando os grupos do usuário não
// estavam maduros, mas a v72 reescreveu `extractUserPrediction` para
// chamar `extractAdvancingTeams(simMatches, hints)` diretamente nesse
// caso — então a função ficou órfã e quebrava o lint
// (@typescript-eslint/no-unused-vars).

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
