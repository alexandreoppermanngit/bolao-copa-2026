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

  // KO: precisa do recálculo cross-fase + bets desse jogo
  const updates = betsList.map(b => {
    const pts = calculateBasePoints(
      { home_score: b.home_score, away_score: b.away_score },
      { home_score: match.home_score!, away_score: match.away_score! }, cfg,
    );
    return sb.from('bets').update({ points: pts, points_with_zebra: pts }).eq('id', b.id);
  });
  await Promise.all(updates);
  await sb.from('matches').update({
    result_code: outcomeOf(match.home_score!, match.away_score!),
  }).eq('id', matchId);

  // Cross-fase: o NOVO resultado pode pontuar/despontuar palpites de outros usuários em outros jogos
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
    const simMatches: Match[] = allMatches.map(m => {
      const b = userBetsByMatch.get(m.id);
      if (b) return { ...m, home_score: b.home_score, away_score: b.away_score };
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
        const m = userResolvedWithOverrides.find(x => x.id === b.match_id);
        return m && !isGroupPhase(m.phase);
      })
      .map(b => {
        const m = userResolvedWithOverrides.find(x => x.id === b.match_id)!;
        if (m.home_team_id == null || m.away_team_id == null) {
          return sb.from('bets').update({ points: 0, points_with_zebra: 0 }).eq('id', b.id);
        }
        const hit = findRealKnockoutMatchup(m.home_team_id, m.away_team_id, allMatches);
        if (!hit) {
          return sb.from('bets').update({ points: 0, points_with_zebra: 0 }).eq('id', b.id);
        }
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

export async function fullRecalc() {
  const sb = createServiceRoleClient();
  const { data: matches } = await sb.from('matches').select('id, home_score, away_score, phase');
  for (const m of (matches ?? []) as { id: number; home_score: number | null; away_score: number | null; phase: Match['phase'] }[]) {
    if (m.home_score != null && m.away_score != null) {
      await recalcMatchAndAllBets(m.id);
    }
  }
  await recalcBracket();
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
