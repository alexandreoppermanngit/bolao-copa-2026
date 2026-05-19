import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface FullRow {
  user_id: string; email: string; display_name: string | null;
  game_points: number; game_points_base: number;
  qualification_points: number; qualification_points_base: number;
}

export default async function RankingZebraPage() {
  const supabase = createClient();
  const { data } = await supabase
    .from('user_rankings_full')
    .select('*')
    .order('total_points', { ascending: false })
    .limit(500);
  const rows = (data ?? []) as FullRow[];

  // Bônus zebra = pontos finais menos base, tanto de jogos quanto de classificação
  const enriched = rows.map(r => {
    const gameBonus = Number(r.game_points) - Number(r.game_points_base);
    const qualBonus = Number(r.qualification_points) - Number(r.qualification_points_base);
    const totalBonus = gameBonus + qualBonus;
    return { ...r, gameBonus, qualBonus, totalBonus };
  }).sort((a, b) => b.totalBonus - a.totalBonus);

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-accent-gold to-yellow-400 text-brand-900 rounded-xl p-4 shadow-sm">
        <h1 className="text-2xl font-bold">🦓 Ranking Zebra</h1>
        <p className="text-sm mt-1">
          Soma dos bônus do multiplicador zebra: jogos de grupo (1.5×/2×) + classificação de seleções
          (fator dinâmico). Quem aposta no improvável e acerta sobe aqui.
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="spreadsheet-table">
          <thead>
            <tr>
              <th className="w-16">Pos</th>
              <th>Apostador</th>
              <th className="text-right">Bônus Jogos</th>
              <th className="text-right">Bônus Classific.</th>
              <th className="text-right">Total Bônus Zebra</th>
            </tr>
          </thead>
          <tbody>
            {enriched.length === 0 && (
              <tr><td colSpan={5} className="text-center py-8 text-gray-500">Sem dados ainda</td></tr>
            )}
            {enriched.map((r, i) => (
              <tr key={r.user_id} className={i < 3 ? 'font-semibold' : ''}>
                <td className="text-center">{i + 1}</td>
                <td>{r.display_name ?? r.email.split('@')[0]}</td>
                <td className="text-right font-mono">{r.gameBonus.toFixed(2)}</td>
                <td className="text-right font-mono">{r.qualBonus.toFixed(2)}</td>
                <td className="text-right font-mono font-bold">{r.totalBonus.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
