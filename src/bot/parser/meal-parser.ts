import * as foodRepo from "../../repositories/food.repo.js";
import * as frequentMealRepo from "../../repositories/frequent-meal.repo.js";
import { parseMealText } from "../../services/gemini.service.js";
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
  const ai = await tryAi(rawText);
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
// 2) QUICK — regex de cantidad + searchFood
// ────────────────────────────────────────────────────────────
const QUANTITY_FOOD_REGEX =
  /(\d+(?:[.,]\d+)?)\s*(g|gr|gs|grs|gramos|kg|kgs|kilos?|ml|cc|lts?|litros?)?\s+(?:de\s+)?([a-z][a-z\s]{2,40}?)(?=\s+(?:y|con|mas|de|\d|$|[,.]))/g;

async function tryQuick(normalized: string): Promise<ParseResult | null> {
  const matches = Array.from(normalized.matchAll(QUANTITY_FOOD_REGEX));
  if (matches.length === 0) return null;

  const items: ParsedMealItem[] = [];
  let isEstimate = false;

  for (const m of matches) {
    const rawQty = parseFloat(m[1].replace(",", "."));
    const unit = m[2] ?? "";
    const foodName = m[3].trim();

    const grams =
      /^(kg|kgs|kilos?|lts?|litros?)$/.test(unit) ? Math.round(rawQty * 1000) :
      unit ? Math.round(rawQty) :
      Math.round(rawQty); // sin unidad asumimos gramos

    const dbMatches = await foodRepo.searchFood(foodName, 1);
    const top = dbMatches[0];
    if (!top || top.match_score < MATCH_CONFIDENCE_THRESHOLD) continue;

    const factor = grams / 100;
    items.push({
      name: foodName,
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

  return finalize(items, isEstimate, items.every((i) => i.matched_db_name) ? 0.85 : 0.7, "quick");
}

// ────────────────────────────────────────────────────────────
// 3) AI fallback
// ────────────────────────────────────────────────────────────
async function tryAi(rawText: string): Promise<ParseResult> {
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
