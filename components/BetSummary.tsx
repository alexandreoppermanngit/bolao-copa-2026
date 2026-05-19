'use client';
/**
 * Mostra o resumo do palpite do usuário: campeão, vice e 3º lugar.
 * Recebe os Team já resolvidos como props (computados no BetForm).
 */

import type { Team } from '@/types/database';
import { TeamNameWithFlag } from './TeamNameWithFlag';

interface Props {
  champion: Team | null;
  vice: Team | null;
  third: Team | null;
}

export function BetSummary({ champion, vice, third }: Props) {
  return (
    <section className="bg-gradient-to-r from-brand-500 to-brand-700 text-white rounded-xl p-6 shadow-md">
      <h2 className="text-xl font-bold mb-4">🏆 Resumo do seu palpite</h2>
      <div className="grid sm:grid-cols-3 gap-4">
        <SummaryCard label="🥇 Campeão" team={champion} />
        <SummaryCard label="🥈 Vice-campeão" team={vice} />
        <SummaryCard label="🥉 Terceiro lugar" team={third} />
      </div>
    </section>
  );
}

function SummaryCard({ label, team }: { label: string; team: Team | null }) {
  return (
    <div className="bg-white/10 rounded-lg p-4">
      <div className="text-xs uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-lg font-bold mt-1">
        {team
          ? <TeamNameWithFlag team={team} size="md" />
          : <span className="opacity-60 italic">A definir</span>}
      </div>
    </div>
  );
}
