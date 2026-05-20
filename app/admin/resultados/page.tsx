import { createClient } from '@/lib/supabase/server';
import { getActorContext, roleLabel } from '@/lib/bolao/permissions';
import { redirect } from 'next/navigation';
import { ResultsEditor } from '@/components/ResultsEditor';
import type { Match, Team } from '@/types/database';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function AdminResultsPage() {
  const ctx = await getActorContext();
  // Aceita admin completo OU editor de resultados
  if (!ctx.isAdmin && !ctx.canEditResults) redirect('/');

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
        <p className="text-xs mt-1 opacity-75">
          Você está logado como <strong>{roleLabel(ctx.role)}</strong>.
        </p>
      </div>
      <ResultsEditor
        matches={(matches ?? []) as Match[]}
        teams={(teams ?? []) as Team[]}
        canResetAll={ctx.isAdmin}
      />
    </div>
  );
}
