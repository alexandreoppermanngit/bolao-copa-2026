/**
 * Estatísticas: para CADA fase de classificação, mostra TODAS as seleções que
 * receberam pelo menos 1 palpite (não esconde as pouco apostadas).
 *
 * Colunas: seleção (com bandeira) · apostadores · % · realmente chegou? · fator · pts possíveis
 */

import { createClient, createServiceRoleClient, requireAdmin } from '@/lib/supabase/server';
import type {
  Match, Team, Bet, AnnexCOption, QualificationPhase, Settings,
} from '@/types/database';
import {
  buildPredictionCensus, extractAdvancingTeams, extractRunnerUp,
  phasePointsBase, qualificationZebraFactor,
} from '@/lib/bolao/qualification';
import { DEFAULT_SETTINGS } from '@/lib/bolao/scoring';
import { getGlobalLockStatus } from '@/lib/bolao/lockStatus';
import { TeamNameWithFlag } from '@/components/TeamNameWithFlag';

// Página depende de `settings` (lock dinâmico baseado em now()) — não cachear.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

// Labels usando a terminologia do usuário (16-avos / oitavas / quartas / semis).
// IMPORTANTE: a SEMÂNTICA de cada chave continua igual a `extractAdvancingTeams`:
//   - group_stage  = times que avançaram dos grupos para os 16-avos (32 times)
//   - r32          = vencedores dos 16-avos, que vão para as oitavas (16 times)
//   - r16          = vencedores das oitavas, que vão para as quartas (8 times)
//   - quarters     = vencedores das quartas, que vão para as semis (4 times)
//   - semis        = finalistas, vencedores das semis (2 times)
//   - third_place  = vencedor do jogo de 3º (1 seleção)
//   - champion     = vencedor da final (1 seleção)
const PHASE_LABELS: Record<QualificationPhase, string> = {
  group_stage: 'Classificados da fase de grupos para os 16-avos (32 times)',
  r32:         'Classificados para as oitavas (16 times)',
  r16:         'Classificados para as quartas (8 times)',
  quarters:    'Classificados para as semifinais (4 times)',
  semis:       'Finalistas (2 times)',
  third_place: 'Terceiro lugar (1 seleção)',
  champion:    'Campeão (1 seleção)',
};

// Ordem de EXIBIÇÃO em /estatisticas. Difere de PHASE_ORDER (que rege o scoring
// e a persistência em user_qualification_scores e fica INALTERADO). Adiciona
// um pseudo-phase 'runner_up' que só existe nesta página.
type DisplayPhase = QualificationPhase | 'runner_up';
const DISPLAY_ORDER: DisplayPhase[] = [
  'group_stage', 'r32', 'r16', 'quarters', 'semis',
  'champion', 'runner_up', 'third_place',
];
const RUNNER_UP_LABEL = 'Vice (1 seleção)';

export default async function EstatisticasPage() {
  const supabase = createClient();
  const { isAdmin } = await requireAdmin();

  // 1) Settings + matches/teams/annexC/users — todos via cliente autenticado (públicos via RLS).
  const [
    { data: usersRaw },
    { data: matchesRaw },
    { data: teamsRaw },
    { data: annexRaw },
    { data: settingsRaw },
  ] = await Promise.all([
    supabase.from('profiles').select('id'),
    supabase.from('matches').select('*'),
    supabase.from('teams').select('*'),
    supabase.from('fifa_annex_c').select('*'),
    supabase.from('settings').select('*').eq('id', 1).single(),
  ]);

  const settings: Settings = (settingsRaw ?? DEFAULT_SETTINGS) as Settings;
  const lock = getGlobalLockStatus(settings);

  // Regra: agregado de TODAS as apostas (= "estatística real") só fica visível para
  // admin OU quando apostas estão bloqueadas. Caso contrário, mostra apenas o
  // recorte do usuário logado (1 apostador) — RLS naturalmente já restringe via cliente autenticado.
  const canSeeAllBets = isAdmin || lock.locked;

  // 2) bets — fonte depende de canSeeAllBets
  let bets: Bet[] = [];
  if (canSeeAllBets) {
    // Service role bypassa RLS — TODAS as apostas (defesa em profundidade: migration 005 também libera).
    const sb = createServiceRoleClient();
    const { data: betsRaw } = await sb.from('bets').select('*');
    bets = (betsRaw ?? []) as Bet[];
  } else {
    // Usuário comum + apostas ABERTAS: cliente autenticado, RLS limita à própria aposta.
    const { data: betsRaw } = await supabase.from('bets').select('*');
    bets = (betsRaw ?? []) as Bet[];
  }

  const users = (usersRaw ?? []) as { id: string }[];
  const matches = (matchesRaw ?? []) as Match[];
  const teams = (teamsRaw ?? []) as Team[];
  const annexC = (annexRaw ?? []) as AnnexCOption[];

  // Bets por usuário
  const betsByUser = new Map<string, Bet[]>();
  for (const b of bets) {
    if (!betsByUser.has(b.user_id)) betsByUser.set(b.user_id, []);
    betsByUser.get(b.user_id)!.push(b);
  }
  // Quando apenas o recorte do próprio usuário está visível (apostas abertas + não-admin),
  // a "população" do censo deve ser apenas o(s) user(s) que aparecem no `bets`, não TODOS
  // os perfis (caso contrário o cálculo de % vira pequeno demais e enganoso).
  const userIdsToCensus = canSeeAllBets
    ? users
    : Array.from(new Set(bets.map(b => b.user_id))).map(id => ({ id }));
  const allUserBets = userIdsToCensus.map(u => ({ userId: u.id, bets: betsByUser.get(u.id) ?? [] }));

  const census = buildPredictionCensus(allUserBets, matches, teams, annexC);
  const real = extractAdvancingTeams(matches);
  // Vice real (perdedor da final) — só conhecido quando a final tem resultado;
  // jogos reais têm pens, então não precisa de hints aqui.
  const realRunnerUpId = extractRunnerUp(matches);

  // Para cada fase real (que vai pontuar), listar todos os teamIds que tiveram ≥1 voto.
  type Row = { team: Team; bettors: number; pct: number; reallyAdvanced: boolean; factor: number; possiblePts: number };
  function rowsForPhase(phase: QualificationPhase): Row[] {
    const teamsWithVotes: Row[] = [];
    for (const t of teams) {
      const bettors = census.counts.get(`${phase}:${t.id}`) ?? 0;
      if (bettors === 0) continue;
      const pct = census.totalUsers > 0 ? bettors / census.totalUsers : 0;
      const reallyAdvanced = real[phase].has(t.id);
      const factor = qualificationZebraFactor(census.totalUsers, bettors);
      const basePts = phasePointsBase(phase, settings);
      const possiblePts = Number((basePts * (1 + factor)).toFixed(2));
      teamsWithVotes.push({ team: t, bettors, pct, reallyAdvanced, factor, possiblePts });
    }
    return teamsWithVotes.sort((a, b) => b.bettors - a.bettors);
  }

  // Linhas do card "Vice" (perdedor da final): pseudo-phase, NÃO pontua.
  type RunnerRow = { team: Team; bettors: number; pct: number; reallyRunnerUp: boolean };
  function runnerUpRows(): RunnerRow[] {
    const rows: RunnerRow[] = [];
    for (const t of teams) {
      const bettors = census.runnerUpCounts.get(t.id) ?? 0;
      if (bettors === 0) continue;
      const pct = census.totalUsers > 0 ? bettors / census.totalUsers : 0;
      rows.push({ team: t, bettors, pct, reallyRunnerUp: realRunnerUpId === t.id });
    }
    return rows.sort((a, b) => b.bettors - a.bettors);
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl p-4 shadow-sm">
        <h1 className="text-2xl font-bold">📈 Estatísticas — Seleções Apostadas por Fase</h1>
        <p className="text-sm text-gray-600 mt-1">
          Para cada fase, todas as seleções que receberam pelo menos 1 palpite, com % de apostadores,
          fator multiplicador zebra de classificação e pontos possíveis. Total de apostadores
          {canSeeAllBets ? ' ativos' : ' considerados (você)'}:
          <strong> {census.totalUsers}</strong>
        </p>
        {!isAdmin && !lock.locked && (
          <p className="text-xs mt-2 bg-amber-50 border border-amber-200 text-amber-900 rounded px-2 py-1 inline-block">
            ⏳ Enquanto as apostas estão <strong>abertas</strong>, você vê apenas as suas próprias
            estatísticas. O agregado de todos os jogadores fica visível quando as apostas forem encerradas.
          </p>
        )}
        {!isAdmin && lock.locked && (
          <p className="text-xs mt-2 bg-green-50 border border-green-200 text-green-900 rounded px-2 py-1 inline-block">
            🔓 Apostas encerradas — você agora vê o agregado de todos os apostadores.
          </p>
        )}
      </div>

      {DISPLAY_ORDER.map(phase => {
        // Card especial: VICE (perdedor da final) — não pontua, layout enxuto.
        if (phase === 'runner_up') {
          const rows = runnerUpRows();
          return (
            <div key={phase} className="bg-white rounded-xl shadow-sm p-4">
              <h2 className="font-bold text-brand-500 mb-2">
                {RUNNER_UP_LABEL} — informativo (não pontua)
              </h2>
              {rows.length === 0 && (
                <p className="text-sm text-gray-500">Sem palpites para esta fase.</p>
              )}
              {rows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="spreadsheet-table text-xs w-full">
                    <thead>
                      <tr>
                        <th>Seleção</th><th>Apostadores</th><th>%</th><th>Foi vice?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.team.id} className={r.reallyRunnerUp ? 'bg-green-50' : ''}>
                          <td><TeamNameWithFlag team={r.team} size="sm" /></td>
                          <td className="text-center">{r.bettors}</td>
                          <td className="text-center">{(r.pct * 100).toFixed(0)}%</td>
                          <td className="text-center">{r.reallyRunnerUp ? '✅' : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        }

        // Cards regulares — phase é QualificationPhase
        const rows = rowsForPhase(phase);
        return (
          <div key={phase} className="bg-white rounded-xl shadow-sm p-4">
            <h2 className="font-bold text-brand-500 mb-2">{PHASE_LABELS[phase]} — pts base: {phasePointsBase(phase, settings)}</h2>
            {rows.length === 0 && <p className="text-sm text-gray-500">Sem palpites para esta fase.</p>}
            {rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="spreadsheet-table text-xs w-full">
                  <thead>
                    <tr>
                      <th>Seleção</th><th>Apostadores</th><th>%</th><th>Avançou?</th><th>Fator</th><th>Pts possíveis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.team.id} className={r.reallyAdvanced ? 'bg-green-50' : ''}>
                        <td><TeamNameWithFlag team={r.team} size="sm" /></td>
                        <td className="text-center">{r.bettors}</td>
                        <td className="text-center">{(r.pct * 100).toFixed(0)}%</td>
                        <td className="text-center">{r.reallyAdvanced ? '✅' : '—'}</td>
                        <td className="text-center">{(1 + r.factor).toFixed(2)}×</td>
                        <td className="text-right font-bold">{r.possiblePts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
