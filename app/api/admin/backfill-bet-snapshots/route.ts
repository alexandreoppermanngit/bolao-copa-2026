/**
 * POST /api/admin/backfill-bet-snapshots
 *
 * Preenche `bet_home_team_id`/`bet_away_team_id` em bets já existentes
 * que ainda não têm snapshot (migration 008).
 *
 * Estratégia por bet:
 *   1) Match de fase de grupos (group_stage_*) → snapshot vem direto de
 *      `match.home_team_id`/`away_team_id` (slots fixos no DB).
 *   2) Match de mata-mata → simula o bracket DAQUELE usuário com versão
 *      TOLERANTE (sem `areAllGroupsMature` como bloqueio). Se o usuário
 *      tem palpites de grupos completos, resolve tudo; se parciais,
 *      resolve o que dá; o que não der fica null para nova passada.
 *   3) Slots que não puderam ser resolvidos por nenhuma fonte: ficam null
 *      e entram no relatório como "pendentes".
 *
 * NUNCA sobrescreve um snapshot já gravado, a menos que `?force=true` na
 * URL (modo reparo controlado).
 *
 * Cuidado: esta rota NÃO toca em home_score/away_score/knockout_advancer/
 * points — apenas nos snapshots novos. As apostas em si seguem intactas.
 *
 * Autorização: `requireAdmin` (mesma usada nas outras rotas /admin).
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  createServiceRoleClient, requireAdmin,
} from '@/lib/supabase/server';
import type { Match, Team, Bet, AnnexCOption } from '@/types/database';
import {
  computeGroupStandings, computeThirdPlaceRanking,
  sortedKeyOfQualifyingThirds,
} from '@/lib/bolao/standings';
import {
  findAnnexCOption, simulateBracket, type KoTiebreakHint,
} from '@/lib/bolao/bracket';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ReportPending {
  bet_id: number;
  user_id: string;
  match_id: number;
  phase: string;
  missing_home: boolean;
  missing_away: boolean;
}

interface Report {
  total_bets: number;
  ko_bets: number;
  filled_from_group_match: number;
  filled_from_simulation: number;
  filled_from_bracket_official: number;
  unchanged_already_filled: number;
  pending: number;
  pending_list: ReportPending[];
  force: boolean;
  ms: number;
}

function isGroup(phase: string): boolean {
  return phase === 'group_stage_1' || phase === 'group_stage_2' || phase === 'group_stage_3';
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const { isAdmin } = await requireAdmin();
    if (!isAdmin) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 403 });
    }

    const force = new URL(req.url).searchParams.get('force') === 'true';

    const sb = createServiceRoleClient();

    const [
      { data: allBetsRaw },
      { data: allMatchesRaw },
      { data: teamsRaw },
      { data: annexRaw },
    ] = await Promise.all([
      sb.from('bets').select('*'),
      sb.from('matches').select('*').order('id'),
      sb.from('teams').select('*'),
      sb.from('fifa_annex_c').select('*'),
    ]);

    const allBets    = (allBetsRaw    ?? []) as Bet[];
    const allMatches = (allMatchesRaw ?? []) as Match[];
    const teams      = (teamsRaw      ?? []) as Team[];
    const annexC     = (annexRaw      ?? []) as AnnexCOption[];

    const matchById = new Map(allMatches.map(m => [m.id, m]));

    // Bets agrupadas por usuário (para simular bracket de cada um)
    const betsByUser = new Map<string, Bet[]>();
    for (const b of allBets) {
      if (!betsByUser.has(b.user_id)) betsByUser.set(b.user_id, []);
      betsByUser.get(b.user_id)!.push(b);
    }

    // Simulação tolerante por usuário — sem o guard de areAllGroupsMature.
    // Resolve o que conseguir; slots que não resolvem ficam null.
    const simByUser = new Map<string, Map<number, Match>>();
    for (const [userId, userBets] of betsByUser) {
      const userBetByMatch = new Map(userBets.map(b => [b.match_id, b]));
      const simMatches: Match[] = allMatches.map(m => {
        const b = userBetByMatch.get(m.id);
        if (!b) return m;
        const next: Match = { ...m, home_score: b.home_score, away_score: b.away_score };
        // Snapshots já gravados são respeitados como base do bracket pessoal.
        if (b.bet_home_team_id != null) next.home_team_id = b.bet_home_team_id;
        if (b.bet_away_team_id != null) next.away_team_id = b.bet_away_team_id;
        return next;
      });

      // Computa standings com o que houver (tolerante a grupos imaturos).
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

    // Itera bets e decide o snapshot
    const updates: { id: number; bet_home_team_id?: number | null; bet_away_team_id?: number | null }[] = [];
    const report: Report = {
      total_bets: allBets.length,
      ko_bets: 0,
      filled_from_group_match: 0,
      filled_from_simulation: 0,
      filled_from_bracket_official: 0,
      unchanged_already_filled: 0,
      pending: 0,
      pending_list: [],
      force,
      ms: 0,
    };

    for (const b of allBets) {
      const m = matchById.get(b.match_id);
      if (!m) continue;
      const isKO = !isGroup(m.phase);
      if (isKO) report.ko_bets++;

      // Já preenchido?
      const already = b.bet_home_team_id != null && b.bet_away_team_id != null;
      if (already && !force) {
        report.unchanged_already_filled++;
        continue;
      }

      let newHome: number | null = b.bet_home_team_id ?? null;
      let newAway: number | null = b.bet_away_team_id ?? null;
      let source: 'group' | 'sim' | 'official' | null = null;

      if (!isKO) {
        // 1) Fase de grupos: pega home/away_team_id do match (fixos).
        if (newHome == null && m.home_team_id != null) {
          newHome = m.home_team_id;
          source = 'group';
        }
        if (newAway == null && m.away_team_id != null) {
          newAway = m.away_team_id;
          source = 'group';
        }
      } else {
        // 2) KO: usa a simulação tolerante daquele usuário.
        const userSim = simByUser.get(b.user_id);
        const simM = userSim?.get(b.match_id);
        if (simM) {
          if (newHome == null && simM.home_team_id != null) {
            newHome = simM.home_team_id;
            source = 'sim';
          }
          if (newAway == null && simM.away_team_id != null) {
            newAway = simM.away_team_id;
            source = 'sim';
          }
        }
        // 3) Fallback final: bracket oficial atual (pode estar null).
        if (newHome == null && m.home_team_id != null) {
          newHome = m.home_team_id;
          source = 'official';
        }
        if (newAway == null && m.away_team_id != null) {
          newAway = m.away_team_id;
          source = 'official';
        }
      }

      const willUpdateHome = newHome != null && newHome !== b.bet_home_team_id;
      const willUpdateAway = newAway != null && newAway !== b.bet_away_team_id;

      if (willUpdateHome || willUpdateAway) {
        updates.push({
          id: b.id,
          ...(willUpdateHome ? { bet_home_team_id: newHome } : {}),
          ...(willUpdateAway ? { bet_away_team_id: newAway } : {}),
        });
        if (source === 'group')    report.filled_from_group_match++;
        if (source === 'sim')      report.filled_from_simulation++;
        if (source === 'official') report.filled_from_bracket_official++;
      }

      // Ainda pendente após tudo?
      if (newHome == null || newAway == null) {
        report.pending++;
        // Limita lista para não explodir resposta JSON
        if (report.pending_list.length < 50) {
          report.pending_list.push({
            bet_id: b.id,
            user_id: b.user_id,
            match_id: b.match_id,
            phase: m.phase,
            missing_home: newHome == null,
            missing_away: newAway == null,
          });
        }
      }
    }

    // Aplica updates em lote (paralelo, ~100 por batch para evitar payload gigante)
    const BATCH = 100;
    for (let i = 0; i < updates.length; i += BATCH) {
      const slice = updates.slice(i, i + BATCH);
      await Promise.all(slice.map(u => {
        const row: Record<string, unknown> = {};
        if ('bet_home_team_id' in u) row.bet_home_team_id = u.bet_home_team_id;
        if ('bet_away_team_id' in u) row.bet_away_team_id = u.bet_away_team_id;
        return sb.from('bets').update(row).eq('id', u.id);
      }));
    }

    report.ms = Date.now() - t0;
    return NextResponse.json({ success: true, report });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: (e as Error).message, ms: Date.now() - t0 },
      { status: 500 },
    );
  }
}
