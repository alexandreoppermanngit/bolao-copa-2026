import { createClient } from '@/lib/supabase/server';
import { TeamNameWithFlag } from './TeamNameWithFlag';
import type {
  Team, UserQualificationScore, QualificationPhase, Match,
} from '@/types/database';
import { PHASE_DISPLAY_ORDER, isPhaseCompleted } from '@/lib/bolao/qualification';

interface Props { userId: string }

const PHASE_LABEL: Record<QualificationPhase, string> = {
  group_stage: 'Avança dos grupos',
  r32: 'Vence R32',
  r16: 'Vence R16',
  quarters: 'Vence Quartas',
  semis: 'Finalistas',
  third_place: '3º lugar',
  runner_up: 'Vice-campeão',
  champion: 'Campeão',
};

/**
 * Resumo de PONTUAÇÃO do usuário no topo de /apostas.
 *
 * IMPORTANTE: este bloco mostra APENAS dados que dependem do recálculo do
 * admin (`user_rankings_full`, `user_qualification_scores`, `bets.points`).
 *
 * Os cards de Campeão / Vice / Terceiro foram MOVIDOS para o `BetForm`
 * (componente cliente), pois aqueles valores precisam refletir o estado
 * LOCAL do palpite em tempo real — derivar de `user_qualification_scores`
 * (que só atualiza após `recalcAllQualificationScores`) deixava o topo
 * preso a valores antigos enquanto o final da página atualizava.
 */
export async function MyPointsSummary({ userId }: Props) {
  const supabase = createClient();
  const [rankRes, qualsRes, betsRes, teamsRes, matchesRes] = await Promise.all([
    supabase.from('user_rankings_full').select('*').eq('user_id', userId).maybeSingle(),
    // NB: o `.order('phase')` do Supabase ordena pela ordem física do enum no
    // Postgres — e a migration 006 colocou 'runner_up' depois de 'champion'
    // no enum, gerando ordem visualmente errada (3º → Campeão → Vice).
    // Re-ordenamos no client via PHASE_DISPLAY_ORDER logo abaixo.
    supabase.from('user_qualification_scores').select('*').eq('user_id', userId),
    supabase.from('bets').select('match_id, points, points_with_zebra').eq('user_id', userId),
    supabase.from('teams').select('id, name, group_code, flag_url'),
    // matches só para decidir se cada fase já foi CONCLUÍDA — diferencia
    // "errou" (❌) de "ainda pendente" (⏳) no detalhamento.
    supabase.from('matches').select('id, phase, group_code, home_score, away_score, home_pens, away_pens'),
  ]);

  const rank = rankRes.data as {
    game_points: number; qualification_points: number; total_points: number;
    games_correct: number; qualification_correct: number; position: number;
  } | null;
  const qualsRaw = (qualsRes.data ?? []) as UserQualificationScore[];
  // Ordena pela ordem desejada de exibição (Terceiro → Vice → Campeão no final).
  const quals = [...qualsRaw].sort((a, b) =>
    PHASE_DISPLAY_ORDER.indexOf(a.phase as QualificationPhase) -
    PHASE_DISPLAY_ORDER.indexOf(b.phase as QualificationPhase)
  );
  const bets = (betsRes.data ?? []) as { match_id: number; points: number; points_with_zebra: number }[];
  const teams = (teamsRes.data ?? []) as Team[];
  const teamById = new Map(teams.map(t => [t.id, t]));
  const matches = (matchesRes.data ?? []) as Match[];

  // Cache por fase: já foi concluída? — calculado UMA vez para todas as fases.
  const completedByPhase: Record<QualificationPhase, boolean> = {
    group_stage: isPhaseCompleted('group_stage', matches),
    r32:         isPhaseCompleted('r32', matches),
    r16:         isPhaseCompleted('r16', matches),
    quarters:    isPhaseCompleted('quarters', matches),
    semis:       isPhaseCompleted('semis', matches),
    third_place: isPhaseCompleted('third_place', matches),
    runner_up:   isPhaseCompleted('runner_up', matches),
    champion:    isPhaseCompleted('champion', matches),
  };

  // Pontos por jogo: total e quantos com ≥1 pt
  const gamesWithPoints = bets.filter(b => b.points_with_zebra > 0).length;
  const gameAttempts = bets.length;

  return (
    <section className="bg-gradient-to-br from-brand-500 to-brand-700 text-white rounded-xl p-5 shadow-md">
      <h2 className="text-xl font-bold mb-3">🎯 Sua pontuação</h2>
      <div className="grid sm:grid-cols-3 gap-3 text-sm">
        <Stat label="Pontos por jogos" value={Number(rank?.game_points ?? 0).toFixed(1)}
              sub={`${gamesWithPoints} de ${gameAttempts} jogos pontuaram`} />
        <Stat label="Pontos por classificação" value={Number(rank?.qualification_points ?? 0).toFixed(1)}
              sub={`${rank?.qualification_correct ?? 0} seleções acertadas`} />
        <Stat label="Total + posição" value={Number(rank?.total_points ?? 0).toFixed(1)}
              sub={rank?.position ? `#${rank.position} no ranking` : '—'} highlight />
      </div>

      <details className="mt-4 bg-white/10 rounded p-3">
        <summary className="cursor-pointer text-sm font-medium">📋 Detalhar pontuação por fase</summary>
        <p className="text-[11px] opacity-80 mt-1">
          Valores baseados no último recálculo do admin — para ver o palpite atual
          do seu campeão/vice/3º, veja o resumo logo abaixo (atualiza em tempo real).
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-white/80">
              <tr><th className="text-left">Fase</th><th className="text-left">Seleção</th><th>Acertou?</th><th className="text-right">Pts</th></tr>
            </thead>
            <tbody>
              {quals.length === 0 && (
                <tr><td colSpan={4} className="text-center py-3 opacity-70 italic">
                  Preencha mais palpites para gerar previsões de classificação
                </td></tr>
              )}
              {quals.map(q => {
                const t = teamById.get(q.team_id);
                const phase = q.phase as QualificationPhase;
                // Tri-estado:
                //   ✅ acertou
                //   ❌ errou (fase já concluída e o time apostado não chegou lá)
                //   ⏳ pendente (fase ainda não concluída — não dá pra saber)
                const status = q.is_correct
                  ? '✅'
                  : (completedByPhase[phase] ? '❌' : '⏳');
                return (
                  <tr key={q.id} className="border-t border-white/10">
                    <td className="py-1">{PHASE_LABEL[phase]}</td>
                    <td>{t ? <TeamNameWithFlag team={t} size="sm" /> : `#${q.team_id}`}</td>
                    <td className="text-center">{status}</td>
                    <td className="text-right font-mono">{Number(q.points_final).toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function Stat({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${highlight ? 'bg-white text-brand-700' : 'bg-white/10'}`}>
      <div className="text-xs uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs opacity-80 mt-1">{sub}</div>}
    </div>
  );
}
