import { createClient } from '@/lib/supabase/server';
import { TeamNameWithFlag } from './TeamNameWithFlag';
import type { Team, UserQualificationScore, QualificationPhase } from '@/types/database';

interface Props { userId: string }

const PHASE_LABEL: Record<QualificationPhase, string> = {
  group_stage: 'Avança dos grupos',
  r32: 'Vence R32',
  r16: 'Vence R16',
  quarters: 'Vence Quartas',
  semis: 'Finalistas',
  third_place: '3º lugar',
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
  const [rankRes, qualsRes, betsRes, teamsRes] = await Promise.all([
    supabase.from('user_rankings_full').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('user_qualification_scores').select('*').eq('user_id', userId).order('phase'),
    supabase.from('bets').select('match_id, points, points_with_zebra').eq('user_id', userId),
    supabase.from('teams').select('id, name, group_code, flag_url'),
  ]);

  const rank = rankRes.data as {
    game_points: number; qualification_points: number; total_points: number;
    games_correct: number; qualification_correct: number; position: number;
  } | null;
  const quals = (qualsRes.data ?? []) as UserQualificationScore[];
  const bets = (betsRes.data ?? []) as { match_id: number; points: number; points_with_zebra: number }[];
  const teams = (teamsRes.data ?? []) as Team[];
  const teamById = new Map(teams.map(t => [t.id, t]));

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
                return (
                  <tr key={q.id} className="border-t border-white/10">
                    <td className="py-1">{PHASE_LABEL[q.phase as QualificationPhase]}</td>
                    <td>{t ? <TeamNameWithFlag team={t} size="sm" /> : `#${q.team_id}`}</td>
                    <td className="text-center">{q.is_correct ? '✅' : '⏳'}</td>
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
