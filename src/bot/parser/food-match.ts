/**
 * Ranking de candidatos de food_items por COBERTURA de tokens.
 *
 * El FTS español topea su rank en ~0.40 → con threshold fijo se
 * rechazaban matches correctos ("Pollo, pechuga sin piel, crudo")
 * mientras trigram dejaba pasar basura ("maní"→"Mango").
 *
 * Solución (probada en el seed): puntuar por cuántas palabras del
 * query aparecen en el nombre. "pollo pechuga" → ambas en
 * "Pollo, pechuga sin piel, crudo" → cobertura 1.0. "mani" no está
 * en "Mango" → 0.0 → descartado.
 */

const strip = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const STOPWORDS = new Set([
  "de", "del", "la", "el", "los", "las", "con", "y", "e", "a", "al", "en", "tipo",
]);

const sing = (w: string): string =>
  w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;

export function queryTokens(q: string): string[] {
  return strip(q)
    .split(/[\s,()/-]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(sing);
}

export function coverage(query: string, name: string): number {
  const qs = queryTokens(query);
  if (qs.length === 0) return 0;
  const ns = queryTokens(name);
  const hit = qs.filter((t) => ns.includes(t)).length;
  return hit / qs.length;
}

export interface Ranked<T> {
  item: T;
  coverage: number;
}

/**
 * Ordena candidatos por cobertura desc, luego nombre más corto (más
 * específico al query suele ser el más corto), luego base_score.
 */
export function rankByCoverage<T extends { name: string; base_score: number }>(
  query: string,
  candidates: T[],
): Ranked<T>[] {
  return candidates
    .map((item) => ({ item, coverage: coverage(query, item.name) }))
    .sort(
      (a, b) =>
        b.coverage - a.coverage ||
        a.item.name.length - b.item.name.length ||
        b.item.base_score - a.item.base_score,
    );
}
