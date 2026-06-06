/**
 * Helpers de agenda dos jogos — compor kickoff a partir das colunas
 * `match_date` (ISO date YYYY-MM-DD) + `kickoff_brt` (HH:MM) e decidir
 * qual jogo é o "do momento" para abrir telas como `/comparativo`.
 *
 * Brasil não tem horário de verão desde 2019 → BRT = UTC-3 fixo.
 * Usamos offset explícito (`-03:00`) no ISO para que o cálculo
 * funcione corretamente independente do fuso do servidor.
 */

import type { Match } from '@/types/database';

/** Janela em que um jogo é considerado "em andamento" a partir do kickoff. */
const MATCH_DURATION_MS = 2 * 60 * 60 * 1000;  // 2 horas

/**
 * Converte `match_date` + `kickoff_brt` num `Date` (UTC). Retorna null
 * se algum campo estiver malformado (defensivo — não deveria acontecer
 * em produção porque o seed garante esses valores).
 */
export function matchKickoffDate(
  m: Pick<Match, 'match_date' | 'kickoff_brt'>,
): Date | null {
  if (!m.match_date || !m.kickoff_brt) return null;
  const hhmm = m.kickoff_brt.slice(0, 5);  // descarta segundos se houver
  const iso = `${m.match_date}T${hhmm}:00-03:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Decide qual jogo abrir por padrão em telas que precisam de um foco
 * automático (ex.: `/comparativo`). Em ordem de prioridade:
 *
 *   1. Jogo em ANDAMENTO — `now ∈ [kickoff, kickoff + 2h)`.
 *      Se houver mais de um (jogos simultâneos), retorna o de menor `id`
 *      (que coincide com o menor `kickoff`, dado o sort).
 *   2. PRÓXIMO jogo futuro mais próximo do agora.
 *   3. ÚLTIMO jogo da lista — quando todos já passaram (após Copa).
 *   4. `null` se a lista vier vazia.
 *
 * Não muta o array de entrada (clona via spread). Aceita `now` injetável
 * para testes.
 */
export function pickInitialMatchId(
  matches: Pick<Match, 'id' | 'match_date' | 'kickoff_brt'>[],
  now: Date = new Date(),
): number | null {
  if (matches.length === 0) return null;

  // Sort por (kickoff asc, id asc). Jogos sem data válida vão pro fim.
  const sorted = matches
    .map(m => ({ m, t: matchKickoffDate(m)?.getTime() ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.t - b.t || a.m.id - b.m.id);

  const nowMs = now.getTime();

  // 1) Jogo ao vivo dentro da janela de 2h.
  const live = sorted.find(({ t }) => t <= nowMs && nowMs < t + MATCH_DURATION_MS);
  if (live) return live.m.id;

  // 2) Próximo futuro.
  const next = sorted.find(({ t }) => t > nowMs);
  if (next) return next.m.id;

  // 3) Último (todos já passaram).
  return sorted[sorted.length - 1]?.m.id ?? null;
}
