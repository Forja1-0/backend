/**
 * Distancia de edicion (Levenshtein) optimizada para strings cortos.
 * Pensada para tolerar typos en keywords del bot, NO para busqueda en DB
 * (eso usa pg_trgm en food.repo).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > 3) return Math.abs(al - bl);

  const prev = new Array(bl + 1);
  const curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= bl; j++) prev[j] = curr[j];
  }
  return prev[bl];
}

/** Threshold de typo proporcional al largo de la palabra. */
export function maxTypoDistance(word: string): number {
  if (word.length <= 3) return 0;
  if (word.length <= 5) return 1;
  if (word.length <= 8) return 2;
  return 3;
}

/**
 * Devuelve true si alguna palabra del texto matchea (con tolerancia a typos)
 * cualquier keyword del set.
 */
export function fuzzyTokenMatch(tokens: string[], keywords: readonly string[]): boolean {
  for (const tok of tokens) {
    for (const kw of keywords) {
      if (tok === kw) return true;
      if (Math.abs(tok.length - kw.length) > 3) continue;
      if (levenshtein(tok, kw) <= maxTypoDistance(kw)) return true;
    }
  }
  return false;
}
