'use client';

/**
 * Tabela admin de usuários com ações de:
 *   - Promover/rebaixar admin (botão switch)
 *   - Deletar usuário (com 2 confirmações)
 *
 * Guards no FRONT (UX) + BACKEND (segurança real):
 *   - admin principal alexandre.oppermann@gmail.com: não permite remover/deletar
 *   - não permite ações em si mesmo (deleção)
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const MAIN_ADMIN_EMAIL = 'alexandre.oppermann@gmail.com';

interface ProfileRow {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  created_at: string;
}

export function UsersAdminTable({
  users, currentUserId,
}: {
  users: ProfileRow[];
  currentUserId: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<{ kind: 'idle'|'ok'|'err'; msg: string }>({ kind: 'idle', msg: '' });
  const [busy, setBusy] = useState<string | null>(null);

  async function toggleAdmin(u: ProfileRow) {
    const newValue = !u.is_admin;
    setBusy(`promote:${u.id}`); setStatus({ kind: 'idle', msg: 'Salvando…' });
    try {
      const res = await fetch('/api/users/promote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: u.id, is_admin: newValue }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) setStatus({ kind: 'err', msg: `Erro: ${j?.error ?? 'falha'}` });
      else { setStatus({ kind: 'ok', msg: `✓ ${j.message}` }); router.refresh(); }
    } catch (e) {
      setStatus({ kind: 'err', msg: `Erro: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  async function deleteUser(u: ProfileRow) {
    const ok1 = window.confirm(
      `Tem certeza que quer DELETAR o usuário ${u.email}?\n\n` +
      `Isto apagará: perfil, apostas, pontuações de classificação.\n\n` +
      `Esta ação é IRREVERSÍVEL.`
    );
    if (!ok1) return;
    const typed = window.prompt(`Para confirmar, digite o email do usuário a deletar (${u.email}):`);
    if (typed?.trim().toLowerCase() !== u.email.toLowerCase()) {
      setStatus({ kind: 'err', msg: 'Email não confere — cancelado.' });
      return;
    }
    setBusy(`delete:${u.id}`); setStatus({ kind: 'idle', msg: 'Deletando…' });
    try {
      const res = await fetch('/api/users/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: u.id, confirm: 'DELETE_USER' }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) setStatus({ kind: 'err', msg: `Erro: ${j?.error ?? 'falha'}` });
      else { setStatus({ kind: 'ok', msg: `✓ ${j.message}` }); router.refresh(); }
    } catch (e) {
      setStatus({ kind: 'err', msg: `Erro: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  const statusCls =
    status.kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800' :
    status.kind === 'err' ? 'bg-red-50 border-red-200 text-red-800' :
    'bg-yellow-50 border-yellow-200 text-yellow-900';

  return (
    <>
      {status.msg && (
        <div className={`text-sm border rounded px-3 py-2 ${statusCls}`}>{status.msg}</div>
      )}
      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="spreadsheet-table text-xs">
          <thead>
            <tr>
              <th>Email</th><th>Nome</th><th>Admin?</th><th>Cadastrado em</th><th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => {
              const isMainAdmin = u.email.toLowerCase() === MAIN_ADMIN_EMAIL;
              const isSelf = currentUserId === u.id;
              return (
                <tr key={u.id} className={isMainAdmin ? 'bg-yellow-50' : ''}>
                  <td className="font-mono text-xs">
                    {u.email}{isMainAdmin && <span className="ml-1 text-amber-700 text-xs" title="Admin principal">⭐</span>}
                  </td>
                  <td>{u.display_name ?? '—'}</td>
                  <td className="text-center">{u.is_admin ? '✓' : ''}</td>
                  <td className="text-xs">{new Date(u.created_at).toLocaleString('pt-BR')}</td>
                  <td>
                    <div className="flex gap-1 flex-wrap">
                      <button
                        className="btn-ghost text-xs"
                        disabled={isMainAdmin || busy === `promote:${u.id}`}
                        onClick={() => toggleAdmin(u)}
                        title={isMainAdmin ? 'Admin principal — protegido' : ''}
                      >
                        {busy === `promote:${u.id}` ? '⏳' : (u.is_admin ? '↓ Rebaixar' : '↑ Tornar admin')}
                      </button>
                      <button
                        className="btn-danger text-xs"
                        disabled={isMainAdmin || isSelf || busy === `delete:${u.id}`}
                        onClick={() => deleteUser(u)}
                        title={isMainAdmin ? 'Admin principal — protegido' : isSelf ? 'Você não pode se deletar' : ''}
                      >
                        {busy === `delete:${u.id}` ? '⏳' : '🗑️ Deletar'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500">
        ⭐ = admin principal (não pode ser rebaixado/deletado). Ações também são validadas no servidor.
      </p>
    </>
  );
}
