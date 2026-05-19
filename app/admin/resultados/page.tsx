import { createClient, requireAdmin } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { ResultsEditor } from '@/components/ResultsEditor';
import type { Match, Team } from '@/types/database';

export const dynamic = 'force-dynamic';

export default async function AdminResultsPage() {
  const { isAdmin } = await requireAdmin();
  if (!isAdmin) redirect('/');

  const supabase = createClient();
  const [{ data: matches }, { data: teams }] = await Promise.all([
    supabase.from('matches').select('*').order('id'),
    supabase.from('teams').select('*'),
  ]);

  return (
    <div className="space-y-4">
      <div className="bg-accent-red text-white rounded-xl p-4">
        <h1 className="text-2xl font-bold">🏟️ Resultados Oficiais dos Jogos</h1>
        <p className="text-sm mt-1 opacity-90">
          Salvar placar aciona recálculo automático: pontuação dos apostadores + cruzamentos da chave eliminatória.
        </p>
      </div>
      <ResultsEditor
        matches={(matches ?? []) as Match[]}
        teams={(teams ?? []) as Team[]}
      />
    </div>
  );
}
