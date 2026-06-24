import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * v76 — Tipo agora reflete `user_rankings_full` (não mais a subset
 * `user_rankings`). A view full já carrega `game_points` e
 * `qualification_points` separados, então não precisamos recalcular nada
 * no frontend. `correct_results` é mapeado a partir de `games_correct`
 * (nome da subset) — na full chama `games_correct`.
 */
interface RankingRow {
  user_id: string;
  display_name: string | null;
  // Migration 007: views públicas devolvem email = null (privacidade).
  email: string | null;
  game_points: number;            // v76 — coluna "Jogos"
  qualification_points: number;   // v76 — coluna "Classificados"
  total_points: number;
  games_correct: number;
  exact_scores: number;
  total_bets: number;
  position: number;
}

export default async function RankingPage() {
  const supabase = createClient();
  // v76 — passa a ler de user_rankings_full (a subset 'user_rankings' não
  // expunha game_points/qualification_points). Pontos vêm calculados pelo
  // recalc; aqui é só leitura.
  const { data } = await supabase
    .from('user_rankings_full')
    .select('*')
    .order('position', { ascending: true })
    .limit(500);

  const rows = (data ?? []) as RankingRow[];

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl p-4 shadow-sm">
        <h1 className="text-2xl font-bold">🏆 Ranking Geral</h1>
        <p className="text-sm text-gray-600 mt-1">
          Pontuação dos apostadores. Atualizada a cada novo resultado oficial.
          <span className="block sm:inline sm:ml-2 text-xs text-gray-500">
            Pontos = jogos + classificados.
          </span>
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="spreadsheet-table">
          <thead>
            <tr>
              <th className="w-16">Pos</th>
              <th>Apostador</th>
              <th className="text-right">Pontos</th>
              {/* v76 — Jogos / Classificados substituem a antiga coluna "Apostas".
                  Em mobile o nome é encurtado via responsive classes. */}
              <th className="text-right">
                <span className="hidden sm:inline">Jogos</span>
                <span className="sm:hidden">Jogos</span>
              </th>
              <th className="text-right">
                <span className="hidden sm:inline">Classificados</span>
                <span className="sm:hidden">Classif.</span>
              </th>
              <th className="text-center">
                <span className="hidden sm:inline">Acertos</span>
                <span className="sm:hidden">Ac.</span>
              </th>
              <th className="text-center">
                <span className="hidden sm:inline">Placares Exatos</span>
                <span className="sm:hidden">Exatos</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-gray-500">Nenhuma aposta registrada ainda</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.user_id} className={r.position <= 3 ? 'font-semibold' : ''}>
                <td className="text-center">
                  {r.position === 1 ? '🥇 1' : r.position === 2 ? '🥈 2' : r.position === 3 ? '🥉 3' : r.position}
                </td>
                <td>{r.display_name ?? 'Anônimo'}</td>
                <td className="text-right font-mono">{Number(r.total_points).toFixed(1)}</td>
                <td className="text-right font-mono">{Number(r.game_points).toFixed(1)}</td>
                <td className="text-right font-mono">{Number(r.qualification_points).toFixed(1)}</td>
                <td className="text-center">{r.games_correct}</td>
                <td className="text-center">{r.exact_scores}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
