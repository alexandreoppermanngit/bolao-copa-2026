import { createClient, requireAdmin } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import type { Match, Team, BracketOverride } from '@/types/database';
import { BracketOverrideEditor } from '@/components/BracketOverrideEditor';

export const dynamic = 'force-dynamic';

export default async function AdminBracketOverridesPage() {
  const { isAdmin } = await requireAdmin();
  if (!isAdmin) redirect('/');

  const supabase = createClient();
  const [{ data: matches }, { data: teams }, { data: overrides }] = await Promise.all([
    supabase.from('matches').select('*').not('group_code', 'is', null).order('id'),  // só grupos pra contexto
    supabase.from('teams').select('*'),
    supabase.from('bracket_overrides').select('*'),
  ]);

  const { data: koMatches } = await supabase.from('matches').select('*').is('group_code', null).order('id');

  return (
    <div className="space-y-4">
      <div className="bg-accent-red text-white rounded-xl p-4">
        <h1 className="text-2xl font-bold">🛠️ Overrides do Bracket</h1>
        <p className="text-sm mt-1 opacity-90">
          Substitua manualmente seleções em slots de mata-mata quando o cálculo automático não puder
          resolver (ex.: empate de 3ºs por critério FIFA que a app não suporta).
          Após salvar, todos os rankings são recalculados.
        </p>
      </div>

      <BracketOverrideEditor
        matches={[...((matches ?? []) as Match[]), ...((koMatches ?? []) as Match[])]}
        teams={(teams ?? []) as Team[]}
        overrides={(overrides ?? []) as BracketOverride[]}
      />
    </div>
  );
}
