'use client';

import { createClient } from '@/lib/supabase/client';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function LoginPage() {
  const supabase = createClient();
  const params = useSearchParams();
  const redirectTo = params.get('redirectTo') ?? '/apostas';
  const errorMsg = params.get('error');

  const [loading, setLoading] = useState(false);
  const [debugInfo, setDebugInfo] = useState<string>('');

  // Se já existe sessão, redireciona imediatamente
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) window.location.href = redirectTo;
    });
  }, [supabase, redirectTo]);

  async function signInWithGoogle() {
    setLoading(true);
    setDebugInfo('');
    const origin = window.location.origin;
    // IMPORTANTE: o redirectTo do OAuth deve apontar para /auth/callback;
    // o parâmetro `next` propaga para onde queremos ir após login.
    const callbackUrl = `${origin}/auth/callback?next=${encodeURIComponent(redirectTo)}`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callbackUrl },
    });
    if (error) {
      setLoading(false);
      setDebugInfo(`Erro OAuth: ${error.message}`);
    }
  }

  return (
    <div className="max-w-md mx-auto mt-12">
      <div className="bg-white rounded-xl p-8 shadow-md text-center">
        <h1 className="text-2xl font-bold mb-2">Entrar no Bolão Copa 2026</h1>
        <p className="text-sm text-gray-600 mb-6">
          Use sua conta Google para começar a apostar
        </p>

        {errorMsg && (
          <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded p-3 mb-4">
            ⚠️ {decodeURIComponent(errorMsg)}
          </div>
        )}

        <button
          onClick={signInWithGoogle}
          disabled={loading}
          className="btn-primary w-full flex items-center justify-center gap-3 disabled:opacity-50"
        >
          <GoogleIcon /> {loading ? 'Aguardando Google…' : 'Continuar com Google'}
        </button>

        {debugInfo && (
          <p className="text-xs text-red-600 mt-3">{debugInfo}</p>
        )}

        <p className="text-xs text-gray-500 mt-6">
          Ao continuar, você concorda em receber atualizações sobre o bolão.
        </p>
      </div>

      <details className="mt-4 text-xs text-gray-500">
        <summary className="cursor-pointer">Debug: parâmetros recebidos</summary>
        <pre className="bg-gray-50 p-2 rounded mt-2 overflow-auto">
          {`redirectTo: ${redirectTo}\nerror: ${errorMsg ?? '—'}`}
        </pre>
      </details>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5h-1.9V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.1 6.5 29.3 4.5 24 4.5 12.7 4.5 3.5 13.7 3.5 25S12.7 45.5 24 45.5 44.5 36.3 44.5 25c0-1.5-.2-3-.5-4.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c3 0 5.8 1.1 7.9 3l5.7-5.7C34.1 6.5 29.3 4.5 24 4.5c-7.4 0-13.8 4-17.2 10.2z" />
      <path fill="#4CAF50" d="M24 45.5c5.2 0 9.9-2 13.4-5.3l-6.2-5.2c-2 1.4-4.5 2.2-7.2 2.2-5.2 0-9.6-3.3-11.3-7.9l-6.6 5.1C9.6 41.4 16.2 45.5 24 45.5z" />
      <path fill="#1976D2" d="M43.6 20.5H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.4l6.2 5.2c4-3.7 6.6-9.1 6.6-15.6 0-1-.1-2-.4-3z" />
    </svg>
  );
}
