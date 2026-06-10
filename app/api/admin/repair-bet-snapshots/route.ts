/**
 * POST /api/admin/repair-bet-snapshots
 *
 * Substitui o backfill da v65 (que tinha um bug: o Supabase JS client
 * trunca SELECTs sem `range` em 1000 linhas; com 1.556 bets, ~556 ficavam
 * fora). Agora pagina explicitamente.
 *
 * Dois modos, controlados por querystring:
 *
 *   ?dryRun=true       (default)        — só DIAGNOSTICA. Retorna propostas
 *                                         por bet. NÃO altera o banco.
 *   ?mode=repair       (requer opt-in)  — APLICA propostas com
 *                                         confidence='high' (e 'medium'
 *                                         se ?includeMedium=true).
 *
 * Fontes de reparo por fase:
 *   - group_stage_*  → source 'group_stage_match_fixed', confidence 'high'.
 *                      Trivial: home_team_id/away_team_id do match.
 *   - round_of_*, quarter_finals, semi_finals
 *                    → source 'simulation', confidence 'medium' se a
 *                      simulação tolerante resolveu, 'low' se parcial.
 *   - final          → source 'qualification_scores_final', confidence
 *                      'high' se temos champion + runner_up em UQS e
 *                      orientação via knockout_advancer. 'medium' se
 *                      precisou inferir orientação (orientation_inferred=true).
 *   - third_place    → source 'qualification_scores_third', confidence
 *                      'medium' (só um time conhecido — UQS.third_place).
 *                      Adversário tenta simulação; se não der, fica pendente
 *                      como manual_needed.
 *
 * Proteções obrigatórias:
 *   - Nunca apaga bets, scores ou advancer.
 *   - Nunca toca em matches/results/ranking/pontuação.
 *   - Snapshot existente não é sobrescrito; se diverge da proposta, vai
 *     para `divergences` no relatório. Para forçar sobrescrita, usar
 *     `?force=true` (não recomendado sem revisar divergences).
 *   - mode=repair só aplica propostas com confidence aceita.
 *
 * Autorização: requireAdmin.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  createServiceRoleClient, requireAdmin,
} from '@/lib/supabase/server';
import type {
  Match, Team, Bet, AnnexCOption, UserQualificationScore,
} from '@/types/database';
import {
  computeGroupStandings, computeThirdPlaceRanking,
  sortedKeyOfQualifyingThirds,
} from '@/lib/bolao/standings';
import {
  findAnnexCOption, simulateBracket, type KoTiebreakHint,
} from '@/lib/bolao/bracket';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------
// Tipos do relatório
// ---------------------------------------------------------------------
type Confidence = 'high' | 'medium' | 'low';
type Source =
  | 'group_stage_match_fixed'
  | 'simulation'
  | 'qualification_scores_final'
  | 'qualification_scores_third'
  | 'manual_needed';

interface Proposal {
  user_id: string;
  display_name: string | null;
  match_id: number;
  phase: string;
  current_home_team_id: number | null;
  current_away_team_id: number | null;
  proposed_home_team_id: number | null;
  proposed_away_team_id: number | null;
  source: Source;
  confidence: Confidence;
  orientation_inferred: boolean;
  reason: string;
}

interface Divergence {
  bet_id: number;
  match_id: number;
  phase: string;
  user_id: string;
  current_home_team_id: number | null;
  current_away_team_id: number | null;
  proposed_home_team_id: number | null;
  proposed_away_team_id: number | null;
  source: Source;
  note: string;
}

interface ByPhase {
  total: number;
  missing_before: number;
  proposals_high: number;
  proposals_medium: number;
  proposals_low: number;
  pending: number;
  divergences: number;
  applied: number;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function isGroup(phase: string): boolean {
  return phase === 'group_stage_1' || phase === 'group_stage_2' || phase === 'group_stage_3';
}

type FetchPageResult<T> = {
  data: T[] | null;
  error: { message?: string } | null;
};

/**
 * Paginação manual para contornar o limit 1000 padrão do Supabase JS.
 * Faz `range(offset, offset+PAGE-1)` até esvaziar.
 */
async function fetchAll<T>(
  fn: (from: number, to: number) => PromiseLike<unknown>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;

  // Loop até receber página vazia. Defensivo contra loops infinitos: hard cap.
  for (let i = 0; i < 100; i++) {
    const to = from + pageSize - 1;
    const result = (await fn(from, to)) as FetchPageResult<T>;
    const { data, error } = result;

    if (error) {
      throw new Error(`fetchAll error: ${error.message ?? String(error)}`);
    }

    const rows = data ?? [];
    out.push(...rows);

    if (rows.length < pageSize) break;

    from += pageSize;
  }

  return out;
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const { isAdmin } = await requireAdmin();
    if (!isAdmin) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 403 });
    }

    const url = new URL(req.url);
    const dryRun = url.searchParams.get('mode') !== 'repair';
    const includeMedium = url.searchParams.get('includeMedium') === 'true';
    const force = url.searchParams.get('force') === 'true';

    const sb = createServiceRoleClient();

    // 1) Carregar TUDO com paginação explícita (fix do bug v65).
    const [
      allBets, allMatches, teams, annexC, uqsAll, profiles,
    ] = await Promise.all([
      fetchAll<Bet>((from, to) =>
        sb.from('bets').select('*').range(from, to)),
      fetchAll<Match>((from, to) =>
        sb.from('matches').select('*').order('id').range(from, to)),
      fetchAll<Team>((from, to) =>
        sb.from('teams').select('*').range(from, to)),
      fetchAll<AnnexCOption>((from, to) =>
        sb.from('fifa_annex_c').select('*').range(from, to)),
      fetchAll<UserQualificationScore>((from, to) =>
        sb.from('user_qualification_scores').select('*').range(from, to)),
      fetchAll<{ id: string; display_name: string | null }>((from, to) =>
        sb.from('profiles').select('id, display_name').range(from, to)),
    ]);

    const matchById = new Map(allMatches.map(m => [m.id, m]));
    const displayNameByUser = new Map(profiles.map(p => [p.id, p.display_name]));

    // UQS indexada por (user_id, phase) — útil para final/3º
    const uqsByUserPhase = new Map<string, UserQualificationScore[]>();
    for (const q of uqsAll) {
      const key = `${q.user_id}:${q.phase}`;
      if (!uqsByUserPhase.has(key)) uqsByUserPhase.set(key, []);
      uqsByUserPhase.get(key)!.push(q);
    }

    // Bets agrupadas por usuário, para simular bracket por usuário
    const betsByUser = new Map<string, Bet[]>();
    for (const b of allBets) {
      if (!betsByUser.has(b.user_id)) betsByUser.set(b.user_id, []);
      betsByUser.get(b.user_id)!.push(b);
    }

    // 2) Simulação tolerante por usuário (mesma da v65, sem guard de maturidade).
    //    Resulta em Map<user_id, Map<match_id, Match>> para lookup rápido.
    const simByUser = new Map<string, Map<number, Match>>();
    for (const [userId, userBets] of betsByUser) {
      const userBetByMatch = new Map(userBets.map(b => [b.match_id, b]));
      const simMatches: Match[] = allMatches.map(m => {
        const b = userBetByMatch.get(m.id);
        if (!b) return m;
        const next: Match = { ...m, home_score: b.home_score, away_score: b.away_score };
        if (b.bet_home_team_id != null) next.home_team_id = b.bet_home_team_id;
        if (b.bet_away_team_id != null) next.away_team_id = b.bet_away_team_id;
        return next;
      });
      const standings = computeGroupStandings(teams, simMatches);
      const thirds = computeThirdPlaceRanking(standings);
      const key = sortedKeyOfQualifyingThirds(thirds);
      const opt = key.length === 8 ? findAnnexCOption(key, annexC) : null;
      const hints = new Map<number, KoTiebreakHint>();
      for (const b of userBets) {
        if (b.knockout_advancer) hints.set(b.match_id, { knockout_advancer: b.knockout_advancer });
      }
      const resolved = simulateBracket(simMatches, teams, standings, thirds, opt, hints);
      simByUser.set(userId, new Map(resolved.map(m => [m.id, m])));
    }

    // 3) Gerar propostas
    const proposals: Proposal[] = [];
    const pending: Proposal[] = [];  // mesma forma; source = 'manual_needed'
    const divergences: Divergence[] = [];

    const byPhase: Record<string, ByPhase> = {};
    function bumpPhase(phase: string, key: keyof ByPhase, n = 1) {
      if (!byPhase[phase]) byPhase[phase] = {
        total: 0, missing_before: 0,
        proposals_high: 0, proposals_medium: 0, proposals_low: 0,
        pending: 0, divergences: 0, applied: 0,
      };
      byPhase[phase][key] += n;
    }

    let missingBefore = 0;

    for (const b of allBets) {
      const m = matchById.get(b.match_id);
      if (!m) continue;

      bumpPhase(m.phase, 'total');
      const isMissing = b.bet_home_team_id == null || b.bet_away_team_id == null;
      if (isMissing) { missingBefore++; bumpPhase(m.phase, 'missing_before'); }

      // ---- monta proposta candidata ----
      let proposedHome: number | null = null;
      let proposedAway: number | null = null;
      let source: Source = 'manual_needed';
      let confidence: Confidence = 'low';
      let orientation_inferred = false;
      let reason = '';

      // (A) Fase de grupos: trivial e seguro (slots fixos no DB)
      if (isGroup(m.phase)) {
        proposedHome = m.home_team_id ?? null;
        proposedAway = m.away_team_id ?? null;
        source = 'group_stage_match_fixed';
        confidence = (proposedHome && proposedAway) ? 'high' : 'low';
        reason = 'Match de fase de grupos tem times fixos no schema.';
      }
      // (B) Final via UQS: champion + runner_up
      else if (m.phase === 'final') {
        const champRows = uqsByUserPhase.get(`${b.user_id}:champion`) ?? [];
        const runnerRows = uqsByUserPhase.get(`${b.user_id}:runner_up`) ?? [];
        const champId  = champRows[0]?.team_id ?? null;
        const runnerId = runnerRows[0]?.team_id ?? null;
        if (champId && runnerId) {
          // orientação via advancer
          if (b.knockout_advancer === 'home') {
            proposedHome = champId; proposedAway = runnerId;
          } else if (b.knockout_advancer === 'away') {
            proposedHome = runnerId; proposedAway = champId;
          } else {
            // Sem advancer (placar com vencedor não-empate): preserva ordem
            // canônica (campeão como home) e marca orientação inferida.
            proposedHome = champId; proposedAway = runnerId;
            orientation_inferred = true;
          }
          source = 'qualification_scores_final';
          confidence = orientation_inferred ? 'medium' : 'high';
          reason = 'Reconstruído a partir de user_qualification_scores (champion + runner_up).';
        } else {
          // Fallback: tentar simulação por usuário
          const userSim = simByUser.get(b.user_id);
          const simM = userSim?.get(b.match_id);
          if (simM?.home_team_id && simM?.away_team_id) {
            proposedHome = simM.home_team_id;
            proposedAway = simM.away_team_id;
            source = 'simulation';
            confidence = 'medium';
            reason = 'Sem UQS final; usando simulação tolerante por usuário.';
          } else {
            source = 'manual_needed';
            confidence = 'low';
            reason = 'Sem UQS champion+runner_up e simulação não resolveu.';
          }
        }
      }
      // (C) Terceiro lugar via UQS
      else if (m.phase === 'third_place') {
        const thirdRows = uqsByUserPhase.get(`${b.user_id}:third_place`) ?? [];
        const thirdId = thirdRows[0]?.team_id ?? null;
        const userSim = simByUser.get(b.user_id);
        const simM = userSim?.get(b.match_id);
        const simH = simM?.home_team_id ?? null;
        const simA = simM?.away_team_id ?? null;
        // Caso ideal: simulação dá os dois e bate com UQS
        if (simH && simA) {
          proposedHome = simH; proposedAway = simA;
          source = 'simulation';
          confidence = 'medium';
          reason = 'Simulação tolerante resolveu os dois slots do 3º lugar.';
        } else if (thirdId) {
          // Só temos um time conhecido. Pode tentar atribuir se simulação
          // conhece pelo menos um lado.
          if (simH) {
            proposedHome = simH; proposedAway = thirdId === simH ? null : thirdId;
            source = 'qualification_scores_third';
            confidence = 'low';
            reason = 'UQS 3º + simulação parcial (1 lado).';
          } else if (simA) {
            proposedHome = thirdId === simA ? null : thirdId; proposedAway = simA;
            source = 'qualification_scores_third';
            confidence = 'low';
            reason = 'UQS 3º + simulação parcial (1 lado).';
          } else {
            source = 'manual_needed';
            confidence = 'low';
            reason = `UQS 3º conhecido (team_id=${thirdId}), mas adversário não pôde ser inferido.`;
          }
        } else {
          source = 'manual_needed';
          confidence = 'low';
          reason = 'Sem UQS 3º e simulação não resolveu.';
        }
      }
      // (D) Demais KO: simulação tolerante
      else {
        const userSim = simByUser.get(b.user_id);
        const simM = userSim?.get(b.match_id);
        const simH = simM?.home_team_id ?? null;
        const simA = simM?.away_team_id ?? null;
        if (simH && simA) {
          proposedHome = simH; proposedAway = simA;
          source = 'simulation';
          confidence = 'medium';
          reason = 'Simulação tolerante por usuário resolveu os dois slots.';
        } else if (simH || simA) {
          proposedHome = simH; proposedAway = simA;
          source = 'simulation';
          confidence = 'low';
          reason = 'Simulação resolveu apenas um lado (palpites parciais de grupos).';
        } else {
          source = 'manual_needed';
          confidence = 'low';
          reason = 'Simulação não resolveu nenhum lado.';
        }
      }

      // ---- decide divergência vs proposta ----
      const curH = b.bet_home_team_id ?? null;
      const curA = b.bet_away_team_id ?? null;

      const proposal: Proposal = {
        user_id: b.user_id,
        display_name: displayNameByUser.get(b.user_id) ?? null,
        match_id: b.match_id,
        phase: m.phase,
        current_home_team_id: curH,
        current_away_team_id: curA,
        proposed_home_team_id: proposedHome,
        proposed_away_team_id: proposedAway,
        source,
        confidence,
        orientation_inferred,
        reason,
      };

      // Divergência: snapshot existente diferente da proposta confiável
      if (curH != null && proposedHome != null && curH !== proposedHome) {
        divergences.push({
          bet_id: b.id, match_id: b.match_id, phase: m.phase,
          user_id: b.user_id,
          current_home_team_id: curH, current_away_team_id: curA,
          proposed_home_team_id: proposedHome, proposed_away_team_id: proposedAway,
          source, note: 'home diverge',
        });
        bumpPhase(m.phase, 'divergences');
      } else if (curA != null && proposedAway != null && curA !== proposedAway) {
        divergences.push({
          bet_id: b.id, match_id: b.match_id, phase: m.phase,
          user_id: b.user_id,
          current_home_team_id: curH, current_away_team_id: curA,
          proposed_home_team_id: proposedHome, proposed_away_team_id: proposedAway,
          source, note: 'away diverge',
        });
        bumpPhase(m.phase, 'divergences');
      }

      // Categoriza
      if (source === 'manual_needed') {
        pending.push(proposal);
        bumpPhase(m.phase, 'pending');
      } else {
        proposals.push(proposal);
        if (confidence === 'high')   bumpPhase(m.phase, 'proposals_high');
        if (confidence === 'medium') bumpPhase(m.phase, 'proposals_medium');
        if (confidence === 'low')    bumpPhase(m.phase, 'proposals_low');
      }
    }

    // 4) Se mode=repair, aplica as propostas elegíveis
    let updated = 0;
    let wouldUpdate = 0;
    const applyConfidences = new Set<Confidence>(includeMedium ? ['high', 'medium'] : ['high']);

    const eligible = proposals.filter(p => {
      if (!applyConfidences.has(p.confidence)) return false;
      // Snapshot já igual? não faz nada.
      const sameHome = p.proposed_home_team_id != null && p.current_home_team_id === p.proposed_home_team_id;
      const sameAway = p.proposed_away_team_id != null && p.current_away_team_id === p.proposed_away_team_id;
      if (sameHome && sameAway) return false;
      // Tem divergência E não veio com force → pula (relata)
      const divergesHome = p.current_home_team_id != null && p.proposed_home_team_id != null
        && p.current_home_team_id !== p.proposed_home_team_id;
      const divergesAway = p.current_away_team_id != null && p.proposed_away_team_id != null
        && p.current_away_team_id !== p.proposed_away_team_id;
      if ((divergesHome || divergesAway) && !force) return false;
      // Pelo menos UM dos lados precisa ter proposta válida
      return p.proposed_home_team_id != null || p.proposed_away_team_id != null;
    });

    wouldUpdate = eligible.length;

    if (!dryRun && eligible.length > 0) {
      // Aplica em batches paralelos por user/match.
      // Importante: só seta o lado que tem proposta válida E não está igual ao atual,
      // assim não sobrescreve um snapshot já correto.
      const BATCH = 100;
      // Precisamos do bet.id para o UPDATE. Reconstruir via lookup.
      const betById = new Map<string, Bet>();
      for (const b of allBets) betById.set(`${b.user_id}:${b.match_id}`, b);

      for (let i = 0; i < eligible.length; i += BATCH) {
        const slice = eligible.slice(i, i + BATCH);
        await Promise.all(slice.map(p => {
          const b = betById.get(`${p.user_id}:${p.match_id}`);
          if (!b) return Promise.resolve();
          const row: Record<string, unknown> = {};
          // Aplica home se: tem proposta e (current é null OU force)
          if (p.proposed_home_team_id != null
              && (b.bet_home_team_id == null || force)
              && b.bet_home_team_id !== p.proposed_home_team_id) {
            row.bet_home_team_id = p.proposed_home_team_id;
          }
          // Idem away
          if (p.proposed_away_team_id != null
              && (b.bet_away_team_id == null || force)
              && b.bet_away_team_id !== p.proposed_away_team_id) {
            row.bet_away_team_id = p.proposed_away_team_id;
          }
          if (Object.keys(row).length === 0) return Promise.resolve();
          updated++;
          bumpPhase(p.phase, 'applied');
          return sb.from('bets').update(row).eq('id', b.id);
        }));
      }
    }

    // Limita listas no JSON de resposta para não explodir
    const sliceN = <T,>(arr: T[], n = 200): T[] => arr.slice(0, n);

    return NextResponse.json({
      success: true,
      dryRun,
      mode: dryRun ? 'dryRun' : 'repair',
      includeMedium,
      force,
      totalBets: allBets.length,
      missingBefore,
      wouldUpdate,
      updated,
      byPhase,
      proposals: sliceN(proposals, 500),
      pending: sliceN(pending, 200),
      divergences: sliceN(divergences, 200),
      // Notas e diagnóstico
      diagnostics: {
        pagination_used: true,
        page_size: 1000,
        bets_pages: Math.ceil(allBets.length / 1000),
        note_v65_bug: 'v65 esquecia paginação e truncava em 1000. v66 lê tudo via fetchAll().',
        truncation_notice: {
          proposals_full_count: proposals.length,
          proposals_shown_in_response: Math.min(proposals.length, 500),
          pending_full_count: pending.length,
          pending_shown_in_response: Math.min(pending.length, 200),
          divergences_full_count: divergences.length,
          divergences_shown_in_response: Math.min(divergences.length, 200),
        },
      },
      ms: Date.now() - t0,
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: (e as Error).message, ms: Date.now() - t0 },
      { status: 500 },
    );
  }
}
