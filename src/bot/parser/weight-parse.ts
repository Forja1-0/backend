/**
 * Parser puro de peso corporal desde texto libre de WhatsApp.
 *
 * Reconoce dos formas:
 *   1. keyword + número  →  "peso 82", "me pesé 79.5", "peso: 100", "estoy en 95"
 *   2. número + unidad   →  "82.5 kg", "79 kilos"
 *
 * Conservador a propósito: exige 2-3 dígitos (descarta "1 kg de pollo") y un
 * rango plausible (25-400 kg). Devuelve los kg con 1 decimal, o null.
 *
 * Pura y sin dependencias → la usan el classifier (detección de intent) y el
 * weight.handler (extracción real), sin duplicar la lógica.
 */

const MIN_KG = 25;
const MAX_KG = 400;

// keyword de peso seguido (hasta 8 no-dígitos: ":", " hoy ", etc.) de un número.
// Sin `\b` final (no funciona tras vocal acentuada: "pesé"); `(?![a-z])` evita
// matchear dentro de palabras más largas ("pescado", "pesero").
const KEYWORD_NUM =
  /\b(?:peso|pes[eé]|me pes[eé]|peso hoy|peso actual|peso de hoy|peso ahora|estoy en|estoy pesando)(?![a-z])[^\d]{0,8}(\d{2,3}(?:\.\d{1,2})?)/;

// número de 2-3 dígitos seguido de una unidad de masa.
const NUM_UNIT = /\b(\d{2,3}(?:\.\d{1,2})?)\s?(?:kg|kgs|kilos?|kilogramos?)\b/;

export function parseWeightKg(text: string): number | null {
  if (!text) return null;
  // coma decimal → punto ("82,5" → "82.5"); minúsculas.
  const t = text.toLowerCase().replace(/(\d),(\d)/g, "$1.$2");

  const m = t.match(KEYWORD_NUM) ?? t.match(NUM_UNIT);
  if (!m) return null;

  const kg = Number.parseFloat(m[1]);
  if (!Number.isFinite(kg) || kg < MIN_KG || kg > MAX_KG) return null;
  return Math.round(kg * 10) / 10;
}
