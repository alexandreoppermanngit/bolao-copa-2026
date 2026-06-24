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
 * v74 — Retorna a data de HOJE em horário de Brasília (UTC-3 fixo desde
 * 2019, sem DST), em formato `YYYY-MM-DD`. Independente do fuso do client:
 * subtraímos 3h de UTC e extraímos partes via `getUTC*` — assim a string
 * resultante representa o dia "civil" em São Paulo / Brasília.
 *
 * Usado por /meus-resultados (filtro inicial) e /admin/resultados (scroll
 * automático para o dia atual). É o mesmo helper original da v71, agora
 * exportado deste módulo (era inline no MyResultsView).
 */
export function getBrtTodayISO(): string {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const y = brt.getUTCFullYear();
  const m = String(brt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(brt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * v74 — Dada uma lista de datas (YYYY-MM-DD) já ordenada ASC com jogos
 * disponíveis e a data de hoje, escolhe qual dia priorizar:
 *
 *   1. Hoje, se houver jogos hoje.
 *   2. Próximo dia futuro com jogos.
 *   3. Último dia da lista (se tudo já passou).
 *   4. 'all' se a lista vier vazia.
 *
 * Usado para inicializar filtros/scroll-anchors em /meus-resultados e
 * /admin/resultados.
 */
export function pickInitialDayFromDates(sortedDates: string[], today: string): string {
  if (sortedDates.length === 0) return 'all';
  if (sortedDates.includes(today)) return today;
  const next = sortedDates.find(d => d > today);
  if (next) return next;
  return sortedDates[sortedDates.length - 1];
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
