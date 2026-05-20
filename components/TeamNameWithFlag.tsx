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

  /**
   * Quando true:
   * - desktop/tablet: mostra o nome normal;
   * - mobile: mostra acrônimo para caber melhor com a bandeira.
   */
  responsive?: boolean;
}

function teamAcronym(teamName: string): string {
  const map: Record<string, string> = {
    'Brasil': 'BRA',
    'Argentina': 'ARG',
    'França': 'FRA',
    'Mexico': 'MEX',
    'México': 'MEX',
    'Espanha': 'ESP',
    'Portugal': 'POR',
    'Alemanha': 'ALE',
    'Inglaterra': 'ING',
    'Itália': 'ITA',
    'Holanda': 'HOL',
    'Países Baixos': 'HOL',
    'Uruguai': 'URU',
    'Colômbia': 'COL',
    'Chile': 'CHI',
    'Paraguai': 'PAR',
    'Equador': 'EQU',
    'Peru': 'PER',
    'Bolívia': 'BOL',
    'Venezuela': 'VEN',
    'Estados Unidos': 'USA',
    'USA': 'USA',
    'Canadá': 'CAN',
    'Canada': 'CAN',
    'Japão': 'JPN',
    'Japao': 'JPN',
    'Coreia do Sul': 'KOR',
    'Marrocos': 'MAR',
    'Senegal': 'SEN',
    'Nigéria': 'NIG',
    'Nigeria': 'NIG',
    'Gana': 'GAN',
    'Camarões': 'CAM',
    'Camaroes': 'CAM',
    'Tunísia': 'TUN',
    'Tunisia': 'TUN',
    'Egito': 'EGI',
    'Austrália': 'AUS',
    'Australia': 'AUS',
    'Bélgica': 'BEL',
    'Belgica': 'BEL',
    'Croácia': 'CRO',
    'Croacia': 'CRO',
    'Suíça': 'SUI',
    'Suica': 'SUI',
    'Dinamarca': 'DIN',
    'Polônia': 'POL',
    'Polonia': 'POL',
    'Áustria': 'AUT',
    'Austria': 'AUT',
    'Sérvia': 'SER',
    'Servia': 'SER',
    'Turquia': 'TUR',
    'Arábia Saudita': 'SAU',
    'Arabia Saudita': 'SAU',
    'Irã': 'IRA',
    'Ira': 'IRA',
    'Catar': 'CAT',
    'Qatar': 'QAT',
  };

  return map[teamName] ?? teamName.slice(0, 3).toUpperCase();
}

export function TeamNameWithFlag({
  team,
  name,
  flagOnly,
  hideFlag,
  size = 'md',
  placeholder = '?',
  reverse,
  className = '',
  maxChars,
  responsive = false,
}: Props) {
  const finalName = team?.name ?? name ?? null;
  const flagUrl =
    team?.flag_url ??
    (finalName ? flagUrlForTeam(finalName) : null);

  const dim = size === 'sm' ? 14 : size === 'lg' ? 28 : 20;

  const display = finalName
    ? maxChars && finalName.length > maxChars
      ? finalName.slice(0, maxChars) + '…'
      : finalName
    : placeholder;

  const mobileDisplay = finalName ? teamAcronym(finalName) : placeholder;

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

  const nameEl = responsive ? (
    <>
      <span className={`hidden sm:inline ${!finalName ? 'text-gray-400 italic' : ''}`}>
        {display}
      </span>
      <span
        className={`inline sm:hidden ${!finalName ? 'text-gray-400 italic' : ''}`}
        title={finalName ?? placeholder}
      >
        {mobileDisplay}
      </span>
    </>
  ) : (
    <span className={!finalName ? 'text-gray-400 italic' : ''}>{display}</span>
  );

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {!reverse && flagEl}
      {nameEl}
      {reverse && flagEl}
    </span>
  );
}
