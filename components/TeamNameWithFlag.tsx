/**
 * Componente reutilizável bandeira + nome de uma seleção.
 *
 * SEM event handlers — pode ser renderizado tanto em Server quanto Client
 * Components sem problemas de RSC serialization.
 *
 * Aceita ou (a) objeto Team (preferindo `flag_url` do banco),
 * ou (b) apenas nome string (usa mapping local em flags.ts).
 *
 * Fallback: se a URL falhar, o navegador mostra ícone de imagem quebrada
 * (raro com flagcdn.com). Não usamos onError para evitar problemas com RSC.
 */

import { flagUrlForTeam } from '@/lib/bolao/flags';
import type { Team } from '@/types/database';

interface Props {
  team?: Team | null;
  name?: string | null;
  flagOnly?: boolean;
  hideFlag?: boolean;
  size?: 'sm' | 'md' | 'lg';
  placeholder?: string;
  reverse?: boolean;
  className?: string;
  maxChars?: number;
}

export function TeamNameWithFlag({
  team, name, flagOnly, hideFlag, size = 'md',
  placeholder = '?', reverse, className = '', maxChars,
}: Props) {
  const finalName = team?.name ?? name ?? null;
  const flagUrl =
    team?.flag_url ??
    (finalName ? flagUrlForTeam(finalName) : null);

  const dim = size === 'sm' ? 14 : size === 'lg' ? 28 : 20;
  const display = finalName
    ? (maxChars && finalName.length > maxChars ? finalName.slice(0, maxChars) + '…' : finalName)
    : placeholder;

  const flagEl = !hideFlag && flagUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={flagUrl}
      alt=""
      aria-hidden="true"
      width={dim}
      height={Math.round(dim * 0.7)}
      className="inline-block rounded-sm shadow-sm shrink-0"
      style={{ width: dim, height: 'auto' }}
      loading="lazy"
    />
  ) : null;

  if (flagOnly) return flagEl ?? <span className="text-gray-400">?</span>;

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {!reverse && flagEl}
      <span className={!finalName ? 'text-gray-400 italic' : ''}>{display}</span>
      {reverse && flagEl}
    </span>
  );
}
