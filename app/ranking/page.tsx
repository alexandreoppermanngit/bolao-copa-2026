import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface RankingRow {
  user_id: string;
  display_name: string | null;
  email: string;
  total_points: number;
  correct_results: number;
  exact_scores: number;
  total_bets: number;
  position: number;
}

export default async function RankingPage() {
  const supabase = createClient();
  const { data } = await supabase
    .from('user_rankings')
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
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="spreadsheet-table">
          <thead>
            <tr>
              <th className="w-16">Pos</th>
              <th>Apostador</th>
              <th className="text-right">Pontos</th>
              <th className="text-center">Acertos</th>
              <th className="text-center">Placares Exatos</th>
              <th className="text-center">Apostas</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6} className="text-center py-8 text-gray-500">Nenhuma aposta registrada ainda</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.user_id} className={r.position <= 3 ? 'font-semibold' : ''}>
                <td className="text-center">
                  {r.position === 1 ? '🥇 1' : r.position === 2 ? '🥈 2' : r.position === 3 ? '🥉 3' : r.position}
                </td>
                <td>{r.display_name ?? r.email.split('@')[0]}</td>
                <td className="text-right font-mono">{Number(r.total_points).toFixed(1)}</td>
                <td className="text-center">{r.correct_results}</td>
                <td className="text-center">{r.exact_scores}</td>
                <td className="text-center">{r.total_bets}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
