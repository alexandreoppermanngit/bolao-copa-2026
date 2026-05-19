import { createClient, requireAdmin } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { SettingsForm } from '@/components/SettingsForm';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  const { isAdmin } = await requireAdmin();
  if (!isAdmin) redirect('/');
  const supabase = createClient();
  const { data: settings } = await supabase.from('settings').select('*').single();
  const { data: logs } = await supabase
    .from('audit_log').select('*')
    .order('created_at', { ascending: false }).limit(50);

  return (
    <div className="space-y-4">
      <div className="bg-accent-red text-white rounded-xl p-4">
        <h1 className="text-2xl font-bold">⚙️ Configurações</h1>
      </div>
      <SettingsForm settings={settings} />

      <div className="bg-white rounded-xl shadow-sm p-4">
        <h2 className="text-lg font-bold mb-2">📜 Últimos eventos</h2>
        <table className="w-full text-xs">
          <thead><tr className="text-left"><th>Quando</th><th>Quem</th><th>Ação</th></tr></thead>
          <tbody>
            {(logs ?? []).map((l: { id: number; created_at: string; actor_email: string | null; action: string }) => (
              <tr key={l.id} className="border-b">
                <td>{new Date(l.created_at).toLocaleString('pt-BR')}</td>
                <td>{l.actor_email ?? 'system'}</td>
                <td className="font-mono">{l.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
