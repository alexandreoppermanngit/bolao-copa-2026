/**
 * ORQUESTRAÇÃO DE RECÁLCULO — versão otimizada
 *
 * Otimizações sobre a versão anterior:
 *   - UPDATEs de bets paralelizados via Promise.all (em vez de await sequential)
 *   - Cache de dados carregados (matches, teams, annexC) reutilizado dentro do request
 *   - Recálculo SELETIVO conforme a fase do jogo salvo:
 *       · grupo → não dispara recalcKnockoutMatchupsForAllUsers
 *       · KO    → dispara cross-fase
 *   - resetAllResults zera placar + ZERA bets em lote (1 query) e regrava qualification
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { calculateBasePoints, zebraMultiplier, outcomeOf, DEFAULT_SETTINGS } from './scoring';
import {
  computeGroupStandings, computeThirdPlaceRanking,
  sortedKeyOfQualifyingThirds, areAllGroupsMature,
} from './standings';
import { findAnnexCOption, populateKnockoutMatches, simulateBracket } from './bracket';
import { applyBracketOverrides } from './bracketOverrides';
import { findRealKnockoutMatchup } from './matchup';
import {
  extractAdvancingTeams, buildPredictionCensus,
  calculateUserQualificationScores,
  // v80_hotfix — helper que zera pens reais ao aplicar bet snapshot.
  applyBetSnapshotToMatch,
} from './qualification';
import { fetchAll } from '@/lib/supabase/fetchAll';
import type {
  Bet, Match, Team, Settings, AnnexCOption, BracketOverride,
} from '@/types/database';

type SB = ReturnType<typeof createServiceRoleClient>;

function isGroupPhase(phase: Match['phase']): boolean {
  return phase === 'group_stage_1' || phase === 'group_stage_2' || phase === 'group_stage_3';
}

/** Recalcula pontos para um jogo específico + side-effects relevantes. */
export async function recalcMatchAndAllBets(matchId: number) {
  const sb = createServiceRoleClient();
  const [{ data: settings }, { data: match }] = await Promise.all([
    sb.from('settings').select('*').eq('id', 1).single(),
    sb.from('matches').select('*').eq('id', matchId).single<Match>(),
  ]);
  if (!match) throw new Error(`Match ${matchId} não encontrado`);
  const cfg: Settings = (settings ?? DEFAULT_SETTINGS) as Settings;

  if (match.home_score == null || match.away_score == null) {
    const { error } = await sb.from('bets').update({ points: 0, points_with_zebra: 0 }).eq('match_id', matchId);
    if (error) throw new Error(`Erro zerando bets: ${error.message}`);
    return { updated: 0, message: 'Sem resultado — pontos zerados' };
  }

  const { data: bets } = await sb.from('bets').select('*').eq('match_id', matchId);
  const betsList: Bet[] = (bets ?? []) as Bet[];

  if (isGroupPhase(match.phase)) {
    const resultOutcome = outcomeOf(match.home_score, match.away_score);
    const counts = { home: 0, draw: 0, away: 0 };
    for (const b of betsList) counts[outcomeOf(b.home_score, b.away_score)]++;
    const total = betsList.length;
    const pctSame = total > 0 ? counts[resultOutcome] / total : 0;
    const mult = zebraMultiplier(pctSame, cfg);

    // UPDATEs em paralelo
    const updates = betsList.map(b => {
      const pts = calculateBasePoints(
        { home_score: b.home_score, away_score: b.away_score },
        { home_score: match.home_score!, away_score: match.away_score! }, cfg,
      );
      const ptsZebra = pts === 0 ? 0 : Number((pts * mult).toFixed(2));
      return sb.from('bets').update({ points: pts, points_with_zebra: ptsZebra }).eq('id', b.id);
    });
    await Promise.all(updates);
    await sb.from('matches').update({ result_code: resultOutcome }).eq('id', matchId);
    return { updated: betsList.length };
  }

  // v79_hotfix — KO: NÃO pontuar direto pelos scores do match!
  // No mata-mata, ponto só sai quando o CONFRONTO apostado (bet snapshot)
  // bate com o confronto real. A versão antiga deste loop chamava
  // `calculateBasePoints(b.scores, match.scores)` sem validar o matchup,
  // dando 10 pts para 1-1 vs 1-1 mesmo quando o usuário apostou
  // Suécia-Marrocos e o jogo real foi Holanda-Marrocos.
  //
  // Fix: zerar as bets deste match aqui e DELEGAR a pontuação para
  // `recalcKnockoutMatchupsForAllUsers`, que sabe percorrer todos os
  // KO matches reais comparando contra o snapshot (`bet_home_team_id` /
  // `bet_away_team_id`). Só lá o ponto certo é gravado.
  const zeros = betsList.map(b =>
    sb.from('bets').update({ points: 0, points_with_zebra: 0 }).eq('id', b.id),
  );
  await Promise.all(zeros);
  await sb.from('matches').update({
    result_code: outcomeOf(match.home_score!, match.away_score!),
  }).eq('id', matchId);

  // Cross-fase: re-pontua TODAS as bets KO de todos os usuários com base
  // em snapshot vs matches reais (incluindo este match recém-atualizado).
  await recalcKnockoutMatchupsForAllUsers(sb, cfg);

  return { updated: betsList.length };
}

/** Otimizado: paraleliza updates e usa cache local. */
async function recalcKnockoutMatchupsForAllUsers(sb: SB, cfg: Settings) {
  // v68 — PAGINAÇÃO obrigatória. PostgREST do Supabase default max-rows = 1000,
  // o que tinha truncado as 1.556 bets em produção: usuários com bets nas
  // linhas 1001-1556 não estavam tendo o cross-fase de KO recalculado.
  const [profiles, allBets, allMatches, teams, annexC, overrides] = await Promise.all([
    fetchAll<{ id: string }>((from, to) =>
      sb.from('profiles').select('id').range(from, to)),
    fetchAll<Bet>((from, to) =>
      sb.from('bets').select('*').range(from, to)),
    fetchAll<Match>((from, to) =>
      sb.from('matches').select('*').range(from, to)),
    fetchAll<Team>((from, to) =>
      sb.from('teams').select('*').range(from, to)),
    fetchAll<AnnexCOption>((from, to) =>
      sb.from('fifa_annex_c').select('*').range(from, to)),
    fetchAll<BracketOverride>((from, to) =>
      sb.from('bracket_overrides').select('*').range(from, to)),
  ]);

  const betsByUser = new Map<string, Bet[]>();
  for (const b of allBets) {
    if (!betsByUser.has(b.user_id)) betsByUser.set(b.user_id, []);
    betsByUser.get(b.user_id)!.push(b);
  }

  for (const profile of profiles) {
    const userBets = betsByUser.get(profile.id);
    if (!userBets || userBets.length === 0) continue;

    const userBetsByMatch = new Map(userBets.map(b => [b.match_id, b]));
    // v80_hotfix — usar `applyBetSnapshotToMatch` para também zerar pens
    // reais (palpite não tem pens; tiebreaker é `knockout_advancer`).
    // Sem isso, `populateKnockoutMatches` resolvia placeholders
    // `winner_Mxx` com o vencedor real dos pênaltis em vez de respeitar
    // o `knockout_advancer` do usuário.
    const simMatches: Match[] = allMatches.map(m => {
      const b = userBetsByMatch.get(m.id);
      if (b) return applyBetSnapshotToMatch(m, b);
      return m;
    });
    if (!areAllGroupsMature(simMatches)) continue;

    const standings = computeGroupStandings(teams, simMatches);
    const thirds = computeThirdPlaceRanking(standings);
    const key = sortedKeyOfQualifyingThirds(thirds);
    const opt = key.length === 8 ? findAnnexCOption(key, annexC) : null;
    const hints = new Map();
    for (const b of userBets) {
      if (b.knockout_advancer) hints.set(b.match_id, { knockout_advancer: b.knockout_advancer });
    }
    const userResolved = simulateBracket(simMatches, teams, standings, thirds, opt, hints);
    const userResolvedWithOverrides = applyBracketOverrides(userResolved, overrides);

    const updates = userBets
      .filter(b => {
        // Filtra pelo phase REAL do match (não simulado), pra não perder bets
        // de match KO que ficaram sem teams resolvidos na simulação.
        const real = allMatches.find(x => x.id === b.match_id);
        return real && !isGroupPhase(real.phase);
      })
      .map(b => {
        // v79_hotfix — FONTE DE VERDADE para o confronto apostado é o
        // SNAPSHOT da bet (`bet_home_team_id` / `bet_away_team_id`).
        // O snapshot é imune a re-resolução de placeholder no
        // `populateKnockoutMatches` (que pode produzir teams diferentes
        // do que o usuário apostou). Antes deste fix, esta função usava
        // `userResolvedWithOverrides[match].home_team_id/away_team_id`
        // (teams da simulação), o que invisibilizava o mismatch e dava
        // pontos quando não devia.
        //
        // Fallback (bets legadas pré-v65 sem snapshot): cai na simulação
        // do usuário — comportamento antigo, "best effort" para dados antigos.
        let pairHome = b.bet_home_team_id;
        let pairAway = b.bet_away_team_id;
        if (pairHome == null || pairAway == null) {
          const simM = userResolvedWithOverrides.find(x => x.id === b.match_id);
          pairHome = simM?.home_team_id ?? null;
          pairAway = simM?.away_team_id ?? null;
        }
        if (pairHome == null || pairAway == null) {
          return sb.from('bets').update({ points: 0, points_with_zebra: 0 }).eq('id', b.id);
        }
        // Procura este matchup APOSTADO em qualquer match KO REAL com placar.
        // Se nenhum match real teve esse confronto → 0 pts (confronto errado).
        const hit = findRealKnockoutMatchup(pairHome, pairAway, allMatches);
        if (!hit) {
          return sb.from('bets').update({ points: 0, points_with_zebra: 0 }).eq('id', b.id);
        }
        // `hit.inverted` é calculado contra o `pairHome` que passamos. Como
        // passamos o snapshot, a inversão é relativa à orientação do snapshot
        // (= orientação do palpite do usuário), garantindo que `b.home_score`
        // / `b.away_score` sejam comparados corretamente com o placar real.
        const adjusted = hit.inverted
          ? { home_score: b.away_score, away_score: b.home_score }
          : { home_score: b.home_score, away_score: b.away_score };
        const pts = calculateBasePoints(adjusted, {
          home_score: hit.match.home_score!,
          away_score: hit.match.away_score!,
        }, cfg);
        return sb.from('bets').update({ points: pts, points_with_zebra: pts }).eq('id', b.id);
      });
    await Promise.all(updates);
  }
}

export async function recalcBracket() {
  const sb = createServiceRoleClient();
  const [{ data: teams }, { data: matches }, { data: annexCOpts }, { data: overrides }] = await Promise.all([
    sb.from('teams').select('*'),
    sb.from('matches').select('*'),
    sb.from('fifa_annex_c').select('*'),
    sb.from('bracket_overrides').select('*'),
  ]);
  if (!teams || !matches || !annexCOpts) throw new Error('Falha ao carregar dados');

  const allMatches = matches as Match[];
  // v75 — caminho REAL/oficial: aplica head-to-head no desempate de grupos.
  // Simulações dos usuários (recalcKnockoutMatchupsForAllUsers /
  // extractUserPrediction) continuam usando o modo 'simple' default.
  const standings = computeGroupStandings(teams as Team[], allMatches, { tieBreakerMode: 'head_to_head' });
  const thirds = computeThirdPlaceRanking(standings);
  const key = sortedKeyOfQualifyingThirds(thirds);
  const annexC = findAnnexCOption(key, annexCOpts as AnnexCOption[]);
  const mature = areAllGroupsMature(allMatches);

  if (!mature) {
    const ko = allMatches.filter(m => !isGroupPhase(m.phase));
    await Promise.all(ko.map(m => {
      if ((m.home_placeholder && m.home_team_id != null) || (m.away_placeholder && m.away_team_id != null)) {
        return sb.from('matches').update({
          home_team_id: m.home_placeholder ? null : m.home_team_id,
          away_team_id: m.away_placeholder ? null : m.away_team_id,
        }).eq('id', m.id);
      }
      return Promise.resolve();
    }));
    return { sortedKey: '', annexCOption: null, updatedMatches: 0, mature: false };
  }

  const updates = populateKnockoutMatches(allMatches, teams as Team[], standings, thirds, annexC);
  const overridesList = (overrides ?? []) as BracketOverride[];
  const overrideByKey = new Map<string, number | null>();
  for (const o of overridesList) overrideByKey.set(`${o.match_id}:${o.side}`, o.team_id);

  await Promise.all(updates.map(u => {
    const homeOv = overrideByKey.get(`${u.match_id}:home`);
    const awayOv = overrideByKey.get(`${u.match_id}:away`);
    return sb.from('matches').update({
      home_team_id: homeOv !== undefined ? homeOv : u.home_team_id,
      away_team_id: awayOv !== undefined ? awayOv : u.away_team_id,
    }).eq('id', u.match_id);
  }));

  return {
    sortedKey: key,
    annexCOption: annexC?.option_number ?? null,
    updatedMatches: updates.length,
    mature: true,
  };
}

export async function recalcAllQualificationScores() {
  const sb = createServiceRoleClient();
  // v68 — PAGINAÇÃO obrigatória. Sem isso, com 1.556 bets em produção,
  // ~36% das apostas ficavam fora do cálculo de UQS — usuários cujas bets
  // caíam nas linhas 1001-1556 tinham pontuação por classificação ERRADA.
  const [{ data: settings }, profiles, allBets, allMatches, teams, annexC] = await Promise.all([
    sb.from('settings').select('*').eq('id', 1).single(),
    fetchAll<{ id: string }>((from, to) =>
      sb.from('profiles').select('id').range(from, to)),
    fetchAll<Bet>((from, to) =>
      sb.from('bets').select('*').range(from, to)),
    fetchAll<Match>((from, to) =>
      sb.from('matches').select('*').range(from, to)),
    fetchAll<Team>((from, to) =>
      sb.from('teams').select('*').range(from, to)),
    fetchAll<AnnexCOption>((from, to) =>
      sb.from('fifa_annex_c').select('*').range(from, to)),
  ]);

  const cfg: Settings = (settings ?? DEFAULT_SETTINGS) as Settings;

  // v72 — Aplica o GATE de pontuação por classificados (1º/2º só de grupos
  // com 6 jogos completos; 3ºs só se todos os 12 grupos completos). Antes do
  // gate, pontos por classificados entravam no ranking enquanto grupos ainda
  // estavam parcialmente preenchidos, porque o R32 já era populado pelo
  // recalcBracket com 2 jogos/grupo (areAllGroupsMature).
  const real = extractAdvancingTeams(allMatches, undefined, {
    gateGroupStage: true,
    teams,
  });
  const betsByUser = new Map<string, Bet[]>();
  for (const b of allBets) {
    if (!betsByUser.has(b.user_id)) betsByUser.set(b.user_id, []);
    betsByUser.get(b.user_id)!.push(b);
  }

  const allUserBets = profiles.map(p => ({ userId: p.id, bets: betsByUser.get(p.id) ?? [] }));
  const census = buildPredictionCensus(allUserBets, allMatches, teams, annexC);

  await sb.from('user_qualification_scores').delete().not('id', 'is', null);

  const allRows: ReturnType<typeof calculateUserQualificationScores> = [];
  for (const p of profiles) {
    const userBets = betsByUser.get(p.id) ?? [];
    if (userBets.length === 0) continue;
    const rows = calculateUserQualificationScores({
      userId: p.id, userBets, allMatches, realAdvancingTeams: real,
      censusCounts: census.counts, totalUsers: census.totalUsers,
      teams, annexCOptions: annexC, settings: cfg,
    });
    allRows.push(...rows);
  }

  if (allRows.length > 0) {
    // Insert em lote (até 1000 por vez por segurança)
    const chunkSize = 1000;
    for (let i = 0; i < allRows.length; i += chunkSize) {
      const chunk = allRows.slice(i, i + chunkSize);
      const { error } = await sb.from('user_qualification_scores').insert(chunk);
      if (error) console.warn('UQS insert error:', error.message);
    }
  }
  return { ok: true, users: profiles.length, rows: allRows.length };
}

/**
 * v80b — Recalcula pontuação de UM match de fase de grupos in-place.
 * Extraído do branch group de `recalcMatchAndAllBets` para uso em batch
 * dentro de `fullRecalc` sem o overhead de carregar settings a cada match.
 */
async function recalcGroupMatchInline(sb: SB, match: Match, cfg: Settings): Promise<void> {
  if (match.home_score == null || match.away_score == null) {
    await sb.from('bets').update({ points: 0, points_with_zebra: 0 }).eq('match_id', match.id);
    return;
  }
  const { data: bets } = await sb.from('bets').select('*').eq('match_id', match.id);
  const betsList: Bet[] = (bets ?? []) as Bet[];
  const resultOutcome = outcomeOf(match.home_score, match.away_score);
  const counts = { home: 0, draw: 0, away: 0 };
  for (const b of betsList) counts[outcomeOf(b.home_score, b.away_score)]++;
  const total = betsList.length;
  const pctSame = total > 0 ? counts[resultOutcome] / total : 0;
  const mult = zebraMultiplier(pctSame, cfg);
  await Promise.all(betsList.map(b => {
    const pts = calculateBasePoints(
      { home_score: b.home_score, away_score: b.away_score },
      { home_score: match.home_score!, away_score: match.away_score! }, cfg,
    );
    const ptsZebra = pts === 0 ? 0 : Number((pts * mult).toFixed(2));
    return sb.from('bets').update({ points: pts, points_with_zebra: ptsZebra }).eq('id', b.id);
  }));
  await sb.from('matches').update({ result_code: resultOutcome }).eq('id', match.id);
}

/**
 * v80b — `fullRecalc` refatorado para caber no timeout de 60s da Vercel.
 *
 * ANTES (v80 e anteriores): iterava TODOS os matches com placar chamando
 * `recalcMatchAndAllBets(m.id)`. Para cada match KO, isso disparava
 * `recalcKnockoutMatchupsForAllUsers` INTERNAMENTE — passagem pesada que
 * pagina profiles/bets/matches/teams/annexC/overrides e simula bracket
 * por usuário. Com N matches KO com placar, essa passagem rodava N vezes,
 * estourando o `maxDuration = 60` (erro FUNCTION_INVOCATION_TIMEOUT).
 *
 * AGORA: cross-phase recalc roda UMA vez no fim. Grupos ainda são
 * per-match (baratos, precisam do zebra por match).
 *
 * Passos:
 *   1. Carrega settings + matches uma vez.
 *   2. Recalcula grupos in-place (Promise.all das bets por match).
 *   3. Zera TODAS as bets de matches KO em lote.
 *   4. Grava `result_code` para KO com placar (batch).
 *   5. Chama `recalcKnockoutMatchupsForAllUsers` UMA vez (v79/v80 usa snapshot).
 *   6. `recalcBracket` (bracket oficial).
 *   7. `recalcAllQualificationScores` (v80 respeita advancer via snapshot).
 */
export async function fullRecalc() {
  const sb = createServiceRoleClient();
  const [{ data: settingsRaw }, { data: matchesRaw }] = await Promise.all([
    sb.from('settings').select('*').eq('id', 1).single(),
    sb.from('matches').select('*').order('id'),
  ]);
  const cfg: Settings = (settingsRaw ?? DEFAULT_SETTINGS) as Settings;
  const matches: Match[] = (matchesRaw ?? []) as Match[];
  const withScore = matches.filter(m => m.home_score != null && m.away_score != null);

  // 1) Grupos: pontuação direta com zebra por match (paralelizado nas bets).
  const groupMatches = withScore.filter(m => isGroupPhase(m.phase));
  for (const m of groupMatches) {
    await recalcGroupMatchInline(sb, m, cfg);
  }

  // 2) KO: zerar TODAS as bets em lote; result_code em batch.
  const koMatches = matches.filter(m => !isGroupPhase(m.phase));
  const koMatchIds = koMatches.map(m => m.id);
  if (koMatchIds.length > 0) {
    await sb.from('bets').update({ points: 0, points_with_zebra: 0 }).in('match_id', koMatchIds);
  }
  const koWithScore = withScore.filter(m => !isGroupPhase(m.phase));
  if (koWithScore.length > 0) {
    await Promise.all(koWithScore.map(m =>
      sb.from('matches').update({
        result_code: outcomeOf(m.home_score!, m.away_score!),
      }).eq('id', m.id),
    ));
  }

  // 3) Cross-phase KO recalc UMA vez (v79 usa snapshot, v80 zera pens reais).
  await recalcKnockoutMatchupsForAllUsers(sb, cfg);

  // 4) Bracket oficial.
  await recalcBracket();

  // 5) UQS (v80 respeita `knockout_advancer` via `applyBetSnapshotToMatch`).
  await recalcAllQualificationScores();

  return { ok: true };
}

/**
 * NOVO: reseta TODOS os placares + zera bets + apaga qualification + limpa KO.
 * Mantém: usuários, apostas (placares dos palpites), grupos, times, overrides, settings.
 */
export async function resetAllResults() {
  const sb = createServiceRoleClient();
  // Limpar placares oficiais
  await sb.from('matches').update({
    home_score: null, away_score: null,
    home_pens: null, away_pens: null,
    result_code: null,
  }).gt('id', 0);

  // Zerar pontos das bets em lote (1 query)
  await sb.from('bets').update({ points: 0, points_with_zebra: 0 }).gt('id', 0);

  // Apagar qualification (será regerada via recalc)
  await sb.from('user_qualification_scores').delete().not('id', 'is', null);

  // Recolocar bracket (vai limpar KO porque não há resultados de grupo)
  await recalcBracket();

  return { ok: true };
}
