import { createClient, requireAdmin } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { UsersAdminTable } from '@/components/UsersAdminTable';

export const dynamic = 'force-dynamic';

interface ProfileRow {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  can_edit_results: boolean;
  created_at: string;
}

export default async function AdminUsersPage() {
  const { isAdmin, user } = await requireAdmin();
  if (!isAdmin) redirect('/');

  const supabase = createClient();
  const { data: users } = await supabase
    .from('profiles')
    .select('id, email, display_name, is_admin, can_edit_results, created_at')
    .order('created_at', { ascending: false });

  return (
    <div className="space-y-4">
      <div className="bg-accent-red text-white rounded-xl p-4">
        <h1 className="text-2xl font-bold">👥 Usuários</h1>
        <p className="text-sm mt-1 opacity-90">
          Promova/rebaixe admins ou delete usuários. Ações são registradas em <code>audit_log</code>.
        </p>
      </div>

      <UsersAdminTable
        users={(users ?? []) as ProfileRow[]}
        currentUserId={user?.id ?? null}
      />
    </div>
  );
}
