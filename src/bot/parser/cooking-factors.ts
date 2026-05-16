/**
 * Factores de conversión peso crudo ↔ cocido (Atlas Fotográfico UBA).
 *
 * Uso: cuando el usuario da gramos en un estado pero el food_items
 * matcheado está en el otro. Ej: "200g de arroz crudo" pero solo
 * tenemos el row "Arroz blanco, hervido" → convertimos 200g crudo
 * a su equivalente cocido antes de aplicar macros.
 *
 * food_portions ya encapsula la mayoría de los casos (la porción
 * "plato playo cocido" guarda gramos cocidos directamente); estos
 * factores cubren el resto: gramos explícitos con estado cruzado.
 */

export interface CookingFactor {
  /** keywords que deben aparecer en el nombre del alimento (sin acentos, lower). */
  match: string[];
  /** gramos cocidos por cada gramo crudo. cocido = crudo * factor. */
  rawToCookedFactor: number;
}

// Ordenado de más específico a más genérico (primer match gana).
export const COOKING_FACTORS: CookingFactor[] = [
  { match: ["fideo", "tallarin"], rawToCookedFactor: 2.7 },   // tallarines secos 70→180 / 100→280
  { match: ["fideo", "monito"], rawToCookedFactor: 2.5 },     // moñitos secos 100→250
  { match: ["fideo", "fresco"], rawToCookedFactor: 2.3 },     // tallarines frescos 100→230
  { match: ["fideo"], rawToCookedFactor: 2.5 },               // fideos secos genérico
  { match: ["pasta"], rawToCookedFactor: 2.5 },
  { match: ["arroz"], rawToCookedFactor: 3.29 },              // 70 crudo → 230 cocido
  { match: ["noqui"], rawToCookedFactor: 1.2 },               // 100→120 / 200→240
  { match: ["polenta"], rawToCookedFactor: 3.33 },            // harina de maíz 60→200
  { match: ["harina de maiz"], rawToCookedFactor: 3.33 },
  { match: ["garbanzo"], rawToCookedFactor: 2.5 },            // 70→175
  { match: ["lenteja"], rawToCookedFactor: 2.5 },
  { match: ["poroto"], rawToCookedFactor: 2.5 },
];

function findFactor(foodName: string): number | null {
  const n = foodName.toLowerCase();
  for (const f of COOKING_FACTORS) {
    if (f.match.every((kw) => n.includes(kw))) return f.rawToCookedFactor;
  }
  return null;
}

/** Gramos crudos → gramos cocidos equivalentes. Sin factor conocido → mismos gramos. */
export function rawToCooked(foodName: string, rawGrams: number): number {
  const f = findFactor(foodName);
  return f ? Math.round(rawGrams * f) : rawGrams;
}

/** Gramos cocidos → gramos crudos equivalentes. */
export function cookedToRaw(foodName: string, cookedGrams: number): number {
  const f = findFactor(foodName);
  return f ? Math.round(cookedGrams / f) : cookedGrams;
}

/** ¿Es un alimento donde crudo vs cocido cambia mucho los macros? */
const STATEFUL_KEYWORDS = [
  "arroz", "fideo", "pasta", "tallarin", "noqui", "lenteja",
  "garbanzo", "poroto", "polenta", "avena",
];

export function isStatefulFood(query: string): boolean {
  const q = query.toLowerCase();
  return STATEFUL_KEYWORDS.some((kw) => q.includes(kw));
}
