/**
 * PrizeEstimateBox — Premiação estimada na home.
 *
 * Cálculo (regra do bolão):
 *   total = participantes × R$ 50
 *   1º lugar = 60% do total
 *   2º lugar = 30% do total
 *   3º lugar = 10% do total
 *
 * Recebe `participants` como prop (a home já busca `count` em `profiles`,
 * então reaproveita esse número — sem nova query). Render server-friendly
 * (sem hooks). Server Component por default.
 *
 * Importante:
 *   - "Participantes cadastrados" inclui TODOS os perfis criados (sem
 *     distinguir pago/não pago). É a regra atual; ajuste no futuro se
 *     for adicionar controle de pagamento.
 *   - Não toca em PixCopyBox / hero / outros componentes da home.
 */

interface Props {
  /** Número de participantes cadastrados (totalUsers na home). */
  participants: number;
  /** Valor por participante (R$). Default 50. */
  perParticipant?: number;
}

const FMT_BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function PrizeEstimateBox({ participants, perParticipant = 50 }: Props) {
  const total = participants * perParticipant;
  const first  = total * 0.6;
  const second = total * 0.3;
  const third  = total * 0.1;

  return (
    <section className="bg-gradient-to-br from-accent-gold/20 to-accent-gold/5 border border-accent-gold/40 rounded-xl p-4 sm:p-5 shadow-sm">
      <h2 className="text-base sm:text-lg font-bold mb-2 flex items-center gap-2">
        💰 Premiação estimada
      </h2>
      <p className="text-xs sm:text-sm text-gray-700">
        Participantes cadastrados: <strong>{participants}</strong> ·
        Total estimado: <strong>{FMT_BRL.format(total)}</strong>
        <span className="text-gray-500"> ({participants} × {FMT_BRL.format(perParticipant)})</span>
      </p>
      <div className="grid grid-cols-3 gap-2 sm:gap-3 mt-3">
        <PrizeCell rank="🥇 1º lugar" pct="60%" value={FMT_BRL.format(first)}  highlight />
        <PrizeCell rank="🥈 2º lugar" pct="30%" value={FMT_BRL.format(second)} />
        <PrizeCell rank="🥉 3º lugar" pct="10%" value={FMT_BRL.format(third)}  />
      </div>
      <p className="text-[11px] text-gray-500 mt-2">
        Estimativa baseada no número atual de participantes cadastrados; o valor
        final depende da participação confirmada.
      </p>
    </section>
  );
}

function PrizeCell({
  rank, pct, value, highlight,
}: {
  rank: string; pct: string; value: string; highlight?: boolean;
}) {
  return (
    <div className={
      'rounded-lg p-2 sm:p-3 ' +
      (highlight
        ? 'bg-accent-gold/30 border border-accent-gold/60'
        : 'bg-white border border-gray-200')
    }>
      <div className="text-[10px] sm:text-xs uppercase tracking-wide text-gray-600">{rank}</div>
      <div className="text-xs sm:text-sm font-bold mt-0.5">{value}</div>
      <div className="text-[10px] sm:text-xs text-gray-500">{pct}</div>
    </div>
  );
}
