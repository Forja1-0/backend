import * as foodRepo from "../../repositories/food.repo.js";
import * as frequentMealRepo from "../../repositories/frequent-meal.repo.js";
import { parseMealText } from "../../services/gemini.service.js";
import { canUseAi, recordAiUse } from "../../services/ai-budget.service.js";
import { logger } from "../../config/logger.js";

/** Threshold de similarity para confiar en el match SARA — bajo de esto NO pisa macros AI. */
const MATCH_CONFIDENCE_THRESHOLD = 0.5;

export interface ParsedMealItem {
  name: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  food_item_id: string | null;
  matched_db_name: string | null;
}

export interface ParseResult {
  items: ParsedMealItem[];
  totals: { kcal: number; protein: number; carbs: number; fat: number };
  is_estimate: boolean;
  /** Confianza global. >=0.7 → guardar directo. <0.7 → pedir confirmacion. */
  confidence: number;
  source: "alias" | "quick" | "descriptive" | "ai" | "none" | "needs_clarification";
  /** Si match a frequent_meal, su id (para bumpear use_count). */
  frequent_meal_id?: string;
  /** Texto descriptivo de la comida mencionada (sin verbo) para usar en la pregunta de aclaracion. */
  food_hint?: string;
}

/**
 * Parser de comidas en cascada (la pieza clave del bot).
 *
 *   1) ALIAS  — match exacto contra frequent_meals.alias del user. (gratis, instantaneo)
 *   2) QUICK  — extraer pares (cantidad, alimento) por regex + searchFood. (gratis, ~50ms)
 *   3) AI     — Gemini parsea el texto libre + matcheamos cada item contra SARA. (paga)
 *
 * Cada nivel intenta resolver y devuelve si tuvo exito. El router decide si confirma.
 */
export async function parseMeal(
  userId: string,
  normalized: string,
  rawText: string,
  opts: { skipClarification?: boolean } = {},
): Promise<ParseResult> {
  // ── 1) ALIAS ──────────────────────────────────────────────
  const alias = await tryAlias(userId, normalized);
  if (alias) return alias;

  // ── 2) QUICK (regex-driven) ───────────────────────────────
  const quick = await tryQuick(normalized);
  if (quick && quick.items.length > 0) return quick;

  // ── 2.5) CLARIFICACION — si no hay cantidad alguna, pedimos detalles
  //         antes de gastar AI. El segundo intento (clarify handler) pasa
  //         skipClarification=true para caer a AI si sigue vago.
  if (!opts.skipClarification && !/\d/.test(normalized)) {
    return {
      items: [],
      totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
      is_estimate: false,
      confidence: 0,
      source: "needs_clarification",
      food_hint: extractFoodHint(normalized),
    };
  }

  // ── 3) AI ─────────────────────────────────────────────────
  const ai = await tryAi(rawText, userId);
  return ai;
}

// ────────────────────────────────────────────────────────────
// Extract food hint — strip verb prefix to use in clarification prompt.
//   "comi pescado"           → "pescado"
//   "almorce pollo con arroz"→ "pollo con arroz"
//   "tomé un licuado"        → "un licuado"
// ────────────────────────────────────────────────────────────
const MEAL_VERB_PREFIX =
  /^(?:me\s+)?(?:comi|come|comer|cene|ceno|cenar|desayune|desayuno|desayunar|almorce|almorzo|almorzar|merende|merendar|tome|tomo|tomar|probé|probe|probar)\s+/;

function extractFoodHint(normalized: string): string {
  const stripped = normalized.replace(MEAL_VERB_PREFIX, "").trim();
  return stripped || normalized;
}

// ────────────────────────────────────────────────────────────
// 1) ALIAS
// ────────────────────────────────────────────────────────────
async function tryAlias(userId: string, normalized: string): Promise<ParseResult | null> {
  // El alias puede ocupar todo el mensaje o estar al principio
  // ("desayuno 1", "almuerzo gym"). Probamos el texto completo primero.
  const candidates = [normalized, normalized.split(" ").slice(0, 3).join(" ")];
  for (const candidate of candidates) {
    const match = await frequentMealRepo.findByAlias(userId, candidate);
    if (!match) continue;

    const items: ParsedMealItem[] = (match.ingredients as any[]).map((ing) => ({
      name: ing.name,
      grams: ing.grams ?? 0,
      kcal: ing.kcal ?? 0,
      protein_g: ing.protein_g ?? ing.protein ?? 0,
      carbs_g: ing.carbs_g ?? ing.carbs ?? 0,
      fat_g: ing.fat_g ?? ing.fat ?? 0,
      food_item_id: ing.food_item_id ?? null,
      matched_db_name: null,
    }));

    return {
      items,
      totals: {
        kcal: match.total_kcal,
        protein: match.total_protein_g,
        carbs: match.total_carbs_g,
        fat: match.total_fat_g,
      },
      is_estimate: false,
      confidence: 1.0,
      source: "alias",
      frequent_meal_id: match.id,
    };
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// 2) QUICK — parser tokenizado
//
// Camina los tokens izq→der buscando triplets (cantidad, unidad, food).
// Soporta:
//   - unidades de masa/volumen:   "100g", "200 gramos", "1 kg", "500ml"
//   - unidades contables:         "2 rodajas", "1 taza", "3 fetas"
//   - foods contables sin unidad: "5 huevos", "2 bananas"
//   - food antes o despues:       "pescado 100g" / "100g pescado"
//   - items multiples:            "X y Z", "X con Z", "X, Z"
//   - items sin cantidad:         "100g pollo y arroz" → arroz toma porcion estandar
// ────────────────────────────────────────────────────────────

const MASS_UNITS_G = new Set(["g", "gr", "gs", "grs", "gramo", "gramos"]);
const MASS_UNITS_KG = new Set(["kg", "kgs", "kilo", "kilos"]);
const VOL_UNITS_ML = new Set(["ml", "cc"]);
const VOL_UNITS_L = new Set(["l", "lt", "lts", "litro", "litros"]);

/** Unidades contables: cuantos gramos aproximados pesa CADA una. */
const COUNTABLE_UNIT_G: Record<string, number> = {
  rodaja: 30, rodajas: 30,
  feta: 25, fetas: 25,
  taza: 240, tazas: 240,
  vaso: 250, vasos: 250,
  pocillo: 100, pocillos: 100,
  cucharada: 15, cucharadas: 15,
  cucharadita: 5, cucharaditas: 5,
  porcion: 150, porciones: 150,
  plato: 300, platos: 300,
  unidad: 100, unidades: 100,
  pieza: 100, piezas: 100,
  puñado: 30, puñados: 30, punado: 30, punados: 30,
};

/** Foods que se cuentan en unidades (sin unidad explicita): peso aprox por pieza. */
const FOOD_PER_UNIT_G: Record<string, number> = {
  huevo: 60, huevos: 60,
  banana: 120, bananas: 120,
  manzana: 180, manzanas: 180,
  pera: 180, peras: 180,
  naranja: 130, naranjas: 130,
  mandarina: 90, mandarinas: 90,
  kiwi: 75, kiwis: 75,
  durazno: 150, duraznos: 150,
  ciruela: 60, ciruelas: 60,
  tomate: 120, tomates: 120,
  papa: 170, papas: 170,
  zanahoria: 80, zanahorias: 80,
  galletita: 8, galletitas: 8,
  medialuna: 50, medialunas: 50,
};

const STOPWORDS_IN_FOOD = new Set(["de", "del", "la", "el", "las", "los", "un", "una", "uno", "con"]);
const CONJUNCTIONS = new Set(["y", "e", "mas", "más", "con", "+", ","]);

/** Tokens que NUNCA forman parte del nombre de un food (verbos, adverbios temporales). */
const FOOD_NOISE = new Set([
  "comi", "come", "comer", "cene", "ceno", "cenar", "cenando",
  "desayune", "desayuno", "desayunar", "desayunando",
  "almorce", "almuerzo", "almorzar", "almorzando",
  "merende", "meriendo", "merendar", "merendando",
  "tome", "tomo", "tomar", "tomando",
  "probe", "probar", "probando",
  "ahora", "recien", "hoy", "ayer", "anoche", "manana", "tarde", "noche",
  "me", "te", "se", "le",
]);

interface QtyToken {
  qty: number;
  /** "g" canonical despues de normalizar (kg→g, l→ml, etc). null = sin unidad. */
  unit: "g" | "count" | null;
  /** Index en el array de tokens. */
  i: number;
  /** Cuantos tokens consume (numero + unidad). */
  consumed: number;
}

async function tryQuick(normalized: string): Promise<ParseResult | null> {
  const tokens = normalized
    .replace(/([,.+])/g, " $1 ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

  // Detectar todas las cantidades con su rango de tokens consumidos.
  const qtyHits: QtyToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const num = parseNumber(tokens[i]);
    if (num === null) continue;
    const next = tokens[i + 1]?.toLowerCase() ?? "";

    if (MASS_UNITS_G.has(next)) qtyHits.push({ qty: num, unit: "g", i, consumed: 2 });
    else if (MASS_UNITS_KG.has(next)) qtyHits.push({ qty: num * 1000, unit: "g", i, consumed: 2 });
    else if (VOL_UNITS_ML.has(next)) qtyHits.push({ qty: num, unit: "g", i, consumed: 2 });
    else if (VOL_UNITS_L.has(next)) qtyHits.push({ qty: num * 1000, unit: "g", i, consumed: 2 });
    else if (COUNTABLE_UNIT_G[next] !== undefined) {
      qtyHits.push({ qty: num * COUNTABLE_UNIT_G[next], unit: "g", i, consumed: 2 });
    } else {
      // "100g" pegado: el numero ya trae la unidad adentro
      const inline = tokens[i].match(/^(\d+(?:[.,]\d+)?)(g|gr|grs|gramos|kg|kgs|kilos?|ml|cc|lts?|litros?)$/i);
      if (inline) {
        const u = inline[2].toLowerCase();
        const factor = MASS_UNITS_KG.has(u) || VOL_UNITS_L.has(u) ? 1000 : 1;
        qtyHits.push({ qty: parseFloat(inline[1].replace(",", ".")) * factor, unit: "g", i, consumed: 1 });
      } else {
        // Numero sin unidad: dejarlo como "count" para resolver con food contable.
        qtyHits.push({ qty: num, unit: "count", i, consumed: 1 });
      }
    }
  }

  if (qtyHits.length === 0) {
    // Sin numeros: tryQuick no puede. Caera a clarify/AI segun corresponda.
    return null;
  }

  const consumedTokens = new Set<number>();
  const candidates: { name: string; grams: number; sourceQtyIndex: number | null }[] = [];

  // Para cada qty, intentamos asociar food a su derecha (preferente) o izquierda.
  for (const hit of qtyHits) {
    // Marcar los tokens de la qty como consumidos
    for (let k = 0; k < hit.consumed; k++) consumedTokens.add(hit.i + k);

    // Buscar food a la derecha primero
    const right = collectFoodSpan(tokens, hit.i + hit.consumed, consumedTokens, "forward");
    if (right) {
      const grams = resolveGrams(hit, right.firstFoodToken);
      right.indices.forEach((idx) => consumedTokens.add(idx));
      candidates.push({ name: right.text, grams, sourceQtyIndex: hit.i });
      continue;
    }
    // Si no hay nada a la derecha, mirar a la izquierda
    const left = collectFoodSpan(tokens, hit.i - 1, consumedTokens, "backward");
    if (left) {
      const grams = resolveGrams(hit, left.firstFoodToken);
      left.indices.forEach((idx) => consumedTokens.add(idx));
      candidates.push({ name: left.text, grams, sourceQtyIndex: hit.i });
      continue;
    }
    // Sin food asociable: descartar este hit
  }

  // Items sin cantidad pero ligados con "y/con": buscar food spans en lo no consumido
  for (let i = 0; i < tokens.length; i++) {
    if (consumedTokens.has(i)) continue;
    const t = tokens[i].toLowerCase();
    if (CONJUNCTIONS.has(t) || STOPWORDS_IN_FOOD.has(t) || FOOD_NOISE.has(t)) continue;
    if (!/^[a-záéíóúñ]/i.test(t)) continue;
    const span = collectFoodSpan(tokens, i, consumedTokens, "forward");
    if (span && span.text.length >= 3) {
      span.indices.forEach((idx) => consumedTokens.add(idx));
      candidates.push({ name: span.text, grams: 0, sourceQtyIndex: null });
    }
  }

  if (candidates.length === 0) return null;

  const items: ParsedMealItem[] = [];
  let isEstimate = false;

  for (const cand of candidates) {
    const dbMatches = await foodRepo.searchFood(cand.name, 1);
    const top = dbMatches[0];
    if (!top || top.match_score < MATCH_CONFIDENCE_THRESHOLD) {
      // No matcheo: si era item sin qty, lo dropeamos; si tenia qty, lo dejamos como estimate
      if (cand.sourceQtyIndex !== null) {
        items.push({
          name: cand.name,
          grams: cand.grams,
          kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
          food_item_id: null,
          matched_db_name: null,
        });
        isEstimate = true;
      }
      continue;
    }

    // Si no hay cantidad explicita, usar standard_portion_g del food
    const grams = cand.grams > 0 ? cand.grams : (top.standard_portion_g ?? 100);
    if (cand.grams === 0) isEstimate = true;

    const factor = grams / 100;
    items.push({
      name: cand.name,
      grams,
      kcal: Math.round(top.kcal_per_100g * factor),
      protein_g: top.protein_per_100g * factor,
      carbs_g: top.carbs_per_100g * factor,
      fat_g: top.fat_per_100g * factor,
      food_item_id: top.id,
      matched_db_name: top.name,
    });
    if (top.match_score < 0.85) isEstimate = true;
  }

  if (items.length === 0) return null;

  const allMatched = items.every((i) => i.matched_db_name);
  const confidence = allMatched && !isEstimate ? 0.9 : allMatched ? 0.8 : 0.65;
  return finalize(items, isEstimate, confidence, "quick");
}

function parseNumber(token: string): number | null {
  if (/^\d+(?:[.,]\d+)?$/.test(token)) return parseFloat(token.replace(",", "."));
  return null;
}

/**
 * Si la unidad detectada fue "count" (numero pelado), intentamos resolver
 * el peso usando FOOD_PER_UNIT_G del primer token de comida. Si no esta,
 * caemos a interpretar el numero como gramos (legacy).
 */
function resolveGrams(hit: QtyToken, firstFoodToken: string): number {
  if (hit.unit === "g") return Math.round(hit.qty);
  // unit === "count"
  const perUnit = FOOD_PER_UNIT_G[firstFoodToken.toLowerCase()];
  if (perUnit !== undefined) return Math.round(hit.qty * perUnit);
  // Numero sin unidad ni food contable conocida: asumimos gramos.
  return Math.round(hit.qty);
}

/**
 * Recolecta tokens contiguos formando el nombre de un food, parando en
 * conjunciones, cantidades, puntuacion, o tokens ya consumidos.
 */
function collectFoodSpan(
  tokens: string[],
  start: number,
  consumed: Set<number>,
  direction: "forward" | "backward",
): { text: string; indices: number[]; firstFoodToken: string } | null {
  const step = direction === "forward" ? 1 : -1;
  const indices: number[] = [];
  const collected: string[] = [];

  for (let i = start; i >= 0 && i < tokens.length; i += step) {
    if (consumed.has(i)) break;
    const t = tokens[i].toLowerCase();
    if (CONJUNCTIONS.has(t)) break;
    if (parseNumber(t) !== null) break;
    if (/^[,.+]$/.test(t)) break;
    // Noise (verbos de comer, adverbios temporales): saltar pero no incluir
    if (FOOD_NOISE.has(t)) {
      indices.push(i);
      continue;
    }
    // Stopwords (de, la, el): saltar pero no incluir
    if (STOPWORDS_IN_FOOD.has(t)) {
      indices.push(i);
      continue;
    }
    if (!/^[a-záéíóúñ]/i.test(tokens[i])) break;
    indices.push(i);
    collected.push(t);
  }

  if (collected.length === 0) return null;
  const ordered = direction === "forward" ? collected : [...collected].reverse();
  return {
    text: ordered.join(" "),
    indices,
    firstFoodToken: ordered[0],
  };
}

// ────────────────────────────────────────────────────────────
// 3) AI fallback
// ────────────────────────────────────────────────────────────
async function tryAi(rawText: string, userId: string): Promise<ParseResult> {
  if (!canUseAi(userId)) {
    logger.warn("ai budget exceeded — skipping parseMealText", { userId });
    return {
      items: [],
      totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
      is_estimate: false,
      confidence: 0,
      source: "none",
    };
  }
  recordAiUse(userId);
  const parsed = await parseMealText(rawText);
  if (!parsed || parsed.length === 0) {
    return {
      items: [],
      totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
      is_estimate: false,
      confidence: 0,
      source: "none",
    };
  }

  const items: ParsedMealItem[] = [];
  let isEstimate = false;

  for (const item of parsed) {
    const dbMatches = await foodRepo.searchFood(item.name, 1);
    const top = dbMatches[0];

    let kcal = item.kcal;
    let prot = item.protein_g;
    let carbs = item.carbs_g;
    let fat = item.fat_g;
    let dbId: string | null = null;
    let dbName: string | null = null;

    if (top && top.match_score >= MATCH_CONFIDENCE_THRESHOLD) {
      // Tenemos match confiable: pisamos los macros AI con los reales SARA
      const grams = item.grams > 0 ? item.grams : (top.standard_portion_g ?? 100);
      const factor = grams / 100;
      kcal = Math.round(top.kcal_per_100g * factor);
      prot = top.protein_per_100g * factor;
      carbs = top.carbs_per_100g * factor;
      fat = top.fat_per_100g * factor;
      dbId = top.id;
      dbName = top.name;
      if (top.match_score < 0.85) isEstimate = true;
    } else {
      isEstimate = true;
    }

    if (item.is_estimate) isEstimate = true;

    items.push({
      name: item.name,
      grams: item.grams,
      kcal,
      protein_g: prot,
      carbs_g: carbs,
      fat_g: fat,
      food_item_id: dbId,
      matched_db_name: dbName,
    });
  }

  // Confianza: alta si todos los items matchearon SARA; baja si fueron solo estimaciones AI.
  const matchedRatio = items.filter((i) => i.matched_db_name).length / Math.max(items.length, 1);
  const confidence = isEstimate ? 0.5 + matchedRatio * 0.2 : 0.8;

  return finalize(items, isEstimate, confidence, "ai");
}

function finalize(
  items: ParsedMealItem[],
  isEstimate: boolean,
  confidence: number,
  source: ParseResult["source"],
): ParseResult {
  const totals = items.reduce(
    (acc, it) => ({
      kcal: acc.kcal + it.kcal,
      protein: acc.protein + it.protein_g,
      carbs: acc.carbs + it.carbs_g,
      fat: acc.fat + it.fat_g,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  );
  return { items, totals, is_estimate: isEstimate, confidence, source };
}
