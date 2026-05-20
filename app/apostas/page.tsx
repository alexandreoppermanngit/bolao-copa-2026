import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { BetForm } from '@/components/BetForm';
import { MyPointsSummary } from '@/components/MyPointsSummary';

// Sempre renderizar no servidor com dados frescos do Supabase.
// `revalidate = 0` + `force-dynamic` desabilitam Data Cache / Full Route Cache.
// O Router Cache do client é tratado em next.config.js (staleTimes.dynamic = 0)
// e por `router.refresh()` chamado no BetForm após cada save.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export default async function BetsPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?redirectTo=/apostas');

  const [{ data: matches }, { data: teams }, { data: bets }, { data: settings }, { data: annexC }] =
    await Promise.all([
      supabase.from('matches').select('*').order('id'),
      supabase.from('teams').select('*'),
      supabase.from('bets').select('*').eq('user_id', user.id),
      supabase.from('settings').select('*').single(),
      supabase.from('fifa_annex_c').select('*'),
    ]);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl p-4 shadow-sm">
        <h1 className="text-2xl font-bold">⚽ Minhas Apostas</h1>
        <p className="text-sm text-gray-600 mt-1">
          Preencha os placares de todos os 72 jogos da fase de grupos. Os cruzamentos do mata-mata se
          atualizam automaticamente conforme você preenche. Cada palpite é salvo automaticamente.
        </p>
      </div>

      {/* Resumo de pontuação do usuário (jogos + classificação) */}
      <MyPointsSummary userId={user.id} />

      <BetForm
        userId={user.id}
        matches={matches ?? []}
        teams={teams ?? []}
        existingBets={bets ?? []}
        annexCOptions={annexC ?? []}
        settings={settings}
      />
    </div>
  );
}
