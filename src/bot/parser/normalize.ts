/**
 * Normaliza texto del usuario antes de clasificar.
 * - lowercase
 * - strip acentos (é → e, ñ → n)
 * - quita signos de puntuacion/emoji
 * - colapsa letras repetidas ≥3 ("siiii" → "sii", "holaaa" → "holaa")
 * - colapsa espacios multiples
 *
 * NO transforma semantica: "no" sigue siendo "no".
 */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .replace(/[¿¡!?.,;:_*`"'()[\]{}<>\\/|@#$%^&=+~]/g, " ")
    .replace(/(.)\1{2,}/g, "$1$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(normalized: string): string[] {
  if (!normalized) return [];
  return normalized.split(" ").filter(Boolean);
}

/** "200g", "2kg", "1.5 lts" → numero en gramos (mililitros tratado igual). */
export function extractGrams(normalized: string): number | null {
  const m = normalized.match(
    /(\d+(?:[.,]\d+)?)\s*(g|gr|gs|grs|grms|gramos|kg|kgs|kilos?|ml|cc|lts?|litros?)\b/,
  );
  if (!m) return null;
  const val = parseFloat(m[1].replace(",", "."));
  const unit = m[2];
  if (/^(kg|kgs|kilos?|lts?|litros?)$/.test(unit)) return Math.round(val * 1000);
  return Math.round(val);
}

/** Numero "puro" (RPE, sueño, dolor, etc): "5", "5/10", "siete" */
export function extractStandaloneNumber(normalized: string): number | null {
  const direct = normalized.match(/^(\d+)(?:\s*\/\s*\d+)?$/);
  if (direct) return parseInt(direct[1], 10);
  const words: Record<string, number> = {
    cero: 0, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
    seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  };
  if (words[normalized] !== undefined) return words[normalized];
  return null;
}
