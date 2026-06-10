/**
 * Helper de paginação para SELECTs do Supabase JS.
 *
 * Motivação:
 *   O cliente do Supabase tem um LIMIT padrão de 1000 linhas em
 *   `.select(...)` se você não passar `range()` ou `limit()` explícito.
 *   Em produção (1.5k+ bets) isso trunca silenciosamente e a UI fica
 *   sem mostrar dados. Foi a causa raiz do problema corrigido na v66.
 *
 * Uso:
 *   const allBets = await fetchAll<Bet>((from, to) =>
 *     supabase.from('bets').select('*').range(from, to)
 *   );
 *
 *   const allBetsOrdered = await fetchAll<Bet>((from, to) =>
 *     supabase.from('bets').select('*').order('id').range(from, to)
 *   );
 *
 *   const filtered = await fetchAll<Bet>((from, to) =>
 *     supabase.from('bets').select('*').eq('user_id', userId).range(from, to)
 *   );
 *
 * Aplica IMPORTANTE em qualquer tabela que pode passar de 1000 linhas:
 *   - public.bets         (>1.5k em produção)
 *   - public.user_qualification_scores (≥7 fases × N usuários — vai além)
 *   - public.profiles     (depende do tamanho do bolão)
 *   - public.audit_log    (cresce com o tempo)
 *
 * Não usa em tabelas pequenas conhecidas (matches=104, teams=48,
 * fifa_annex_c=495) — mas também não atrapalha lá.
 */

interface PageResponse<T> {
  data: T[] | null;
  error: unknown;
}

/**
 * Lê TODAS as linhas paginadamente. Pede pages de 1000 linhas até
 * receber uma página menor que `pageSize` (= esvaziou).
 *
 * @param queryBuilder factory que recebe `[from, to]` (inclusive em ambos)
 *                     e devolve um Promise com data/error do Supabase.
 * @param pageSize     tamanho da página (default 1000).
 * @param hardCap      limite defensivo contra loops infinitos (default 100 páginas = 100k).
 *
 * Lança Error se uma página retornar erro do PostgREST.
 */
export async function fetchAll<T>(
  queryBuilder: (from: number, to: number) => PromiseLike<PageResponse<T>>,
  pageSize = 1000,
  hardCap = 100,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (let i = 0; i < hardCap; i++) {
    const to = from + pageSize - 1;
    const { data, error } = await queryBuilder(from, to);
    if (error) {
      const msg = (error as { message?: string }).message ?? String(error);
      throw new Error(`fetchAll: ${msg}`);
    }
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;  // página parcial → última
    from += pageSize;
  }
  return out;
}
