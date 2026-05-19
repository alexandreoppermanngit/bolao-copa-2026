'use client';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

export function LogoutButton({ email }: { email: string }) {
  const supabase = createClient();
  const router = useRouter();
  return (
    <button
      onClick={async () => { await supabase.auth.signOut(); router.refresh(); router.push('/'); }}
      className="text-sm hover:underline"
      title={`Logado como ${email}`}
    >
      Sair ({email.split('@')[0]})
    </button>
  );
}
