import * as foodRepo from "../../repositories/food.repo.js";
import * as frequentMealRepo from "../../repositories/frequent-meal.repo.js";
import { parseMealText } from "../../services/gemini.service.js";
import { canUseAi, recordAiUse } from "../../services/ai-budget.service.js";
import { logger } from "../../config/logger.js";
import { parseMealItems, type ParsedItem } from "./meal-items.js";
import { resolveFood, type FoodState } from "./food-resolve.js";
import type { FoodMatch } from "../../repositories/food.repo.js";

/** Threshold de similarity para confiar en el match SARA. */
const MATCH_CONFIDENCE_THRESHOLD = 0.5;

/** Fallback de gramos por medida casera cuando no hay fila en food_portions. */
const GENERIC_MEASURE_G: Record<string, number> = {
  plato: 250, "plato playo": 230, "plato hondo": 300,
  cucharada: 15, "cucharada sopera": 15, cucharadita: 5,
  taza: 200, vaso: 200, pocillo: 60, pote: 170, lata: 120,
  feta: 25, rodaja: 25, porcion: 150, punado: 25, rulo: 5,
};

export interface ParsedMealItem {
  name: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  food_item_id: string | null;
  matched_db_name: string | null;
  /** Aviso al usuario ("Asumí arroz blanco…"). */
  note?: string | null;
  state?: FoodState;
}

export interface StateClarify {
  /** índice del item ambiguo dentro de `items`. */
  item_index: number;
  food_label: string;
  grams: number;
  crudo: { food_item_id: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  cocido: { food_item_id: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number };
}

export interface ParseResult {
  items: ParsedMealItem[];
  totals: { kcal: number; protein: number; carbs: number; fat: number };
  is_estimate: boolean;
  confidence: number;
  source: "alias" | "quick" | "descriptive" | "ai" | "none" | "needs_clarification" | "needs_state_clarification";
  frequent_meal_id?: string;
  food_hint?: string;
  /** Presente solo si source === 'needs_state_clarification'. */
  state_clarify?: StateClarify;
  /** raw input (para reprocesar tras aclarar estado). */
  raw_input?: string;
}

/**
 * Parser de comidas en cascada:
 *   1) ALIAS  — match exacto contra frequent_meals.alias.
 *   2) QUICK  — split multi-item + patrones + food_portions + SARA.
 *   3) AI     — Gemini parsea texto libre + match SARA.
 */
export async function parseMeal(
  userId: string,
  normalized: string,
  rawText: string,
  opts: { skipClarification?: boolean } = {},
): Promise<ParseResult> {
  const alias = await tryAlias(userId, normalized);
  if (alias) return alias;

  const quick = await tryQuick(normalized, rawText);
  if (quick && (quick.items.length > 0 || quick.source === "needs_state_clarification")) {
    return quick;
  }

  // Nada resuelto por quick: pedir aclaración (salvo segundo intento) o AI.
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

  return tryAi(rawText, userId);
}

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
// 2) QUICK — split + patrones + food_portions
// ────────────────────────────────────────────────────────────
function macros(food: FoodMatch, grams: number) {
  const f = grams / 100;
  return {
    kcal: food.kcal_per_100g * f,
    protein_g: food.protein_per_100g * f,
    carbs_g: food.carbs_per_100g * f,
    fat_g: food.fat_per_100g * f,
  };
}

/** Resuelve gramos según el modo del item + food_portions. */
async function resolveGrams(
  item: ParsedItem,
  foodId: string,
  standardPortionG: number | null,
  state: FoodState,
): Promise<{ grams: number; estimate: boolean }> {
  if (item.mode === "grams") {
    return { grams: item.qty, estimate: false };
  }

  if (item.mode === "measure" && item.measure) {
    const p = await foodRepo.findPortionByMeasure(foodId, item.measure, state ?? undefined);
    if (p) return { grams: Math.round(item.qty * p.portion_grams), estimate: false };
    const generic = GENERIC_MEASURE_G[item.measure];
    if (generic) return { grams: Math.round(item.qty * generic), estimate: true };
  }

  // units / bare → porción default del alimento
  const def = await foodRepo.getDefaultPortion(foodId, state ?? undefined);
  if (def) {
    return { grams: Math.round(item.qty * def.portion_grams), estimate: item.mode === "bare" };
  }
  if (standardPortionG) {
    return { grams: Math.round(item.qty * standardPortionG), estimate: true };
  }
  return { grams: Math.round(item.qty * 100), estimate: true };
}

async function tryQuick(normalized: string, rawText: string): Promise<ParseResult | null> {
  const parsed = parseMealItems(normalized);
  if (parsed.length === 0) return null;

  const items: ParsedMealItem[] = [];
  let isEstimate = false;
  let stateClarify: StateClarify | undefined;

  for (const it of parsed) {
    const resolved = await resolveFood(it.food);
    if (!resolved || resolved.food.match_score < MATCH_CONFIDENCE_THRESHOLD) {
      // alimento no reconocido: lo dejamos como estimación sin macros
      // solo si traía cantidad explícita; si era "bare", lo dropeamos.
      if (it.mode === "grams") {
        items.push({
          name: it.food, grams: it.qty,
          kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
          food_item_id: null, matched_db_name: null,
        });
        isEstimate = true;
      }
      continue;
    }

    const { food } = resolved;
    const { grams, estimate } = await resolveGrams(
      it, food.id, food.standard_portion_g, resolved.state,
    );
    if (estimate) isEstimate = true;

    const m = macros(food, grams);
    const idx = items.length;
    items.push({
      name: it.food,
      grams,
      kcal: m.kcal,
      protein_g: m.protein_g,
      carbs_g: m.carbs_g,
      fat_g: m.fat_g,
      food_item_id: food.id,
      matched_db_name: food.name,
      note: resolved.note,
      state: resolved.state,
    });

    // Ambigüedad crudo/cocido: solo preguntamos por el PRIMER item ambiguo
    // (y solo si es el único item del mensaje, para no encadenar preguntas).
    if (
      resolved.ambiguousState &&
      resolved.crudoFood &&
      resolved.cocidoFood &&
      !stateClarify &&
      parsed.length === 1
    ) {
      const cr = macros(resolved.crudoFood, grams);
      const co = macros(resolved.cocidoFood, grams);
      stateClarify = {
        item_index: idx,
        food_label: it.food,
        grams,
        crudo: { food_item_id: resolved.crudoFood.id, ...cr },
        cocido: { food_item_id: resolved.cocidoFood.id, ...co },
      };
    }
  }

  if (items.length === 0) return null;

  if (stateClarify) {
    return {
      items,
      totals: sumTotals(items),
      is_estimate: isEstimate,
      confidence: 0,
      source: "needs_state_clarification",
      state_clarify: stateClarify,
      raw_input: rawText,
    };
  }

  const allMatched = items.every((i) => i.matched_db_name);
  const confidence = allMatched && !isEstimate ? 0.9 : allMatched ? 0.8 : 0.65;
  return finalize(items, isEstimate, confidence, "quick");
}

/**
 * Recalcula un item tras aclarar crudo/cocido. Lo llama el handler con
 * la respuesta del usuario.
 */
export async function applyStateChoice(
  items: ParsedMealItem[],
  clarify: StateClarify,
  choice: "crudo" | "cocido",
): Promise<{ items: ParsedMealItem[]; totals: ParseResult["totals"] }> {
  const pick = clarify[choice];
  const food = await foodRepo.getFoodById(pick.food_item_id);
  const next = items.map((it, i) =>
    i === clarify.item_index
      ? {
          ...it,
          kcal: pick.kcal,
          protein_g: pick.protein_g,
          carbs_g: pick.carbs_g,
          fat_g: pick.fat_g,
          food_item_id: pick.food_item_id,
          matched_db_name: food?.name ?? it.matched_db_name,
          state: choice,
          note: null,
        }
      : it,
  );
  return { items: next, totals: sumTotals(next) };
}

// ────────────────────────────────────────────────────────────
// 3) AI fallback
// ────────────────────────────────────────────────────────────
async function tryAi(rawText: string, userId: string): Promise<ParseResult> {
  if (!canUseAi(userId)) {
    logger.warn("ai budget exceeded — skipping parseMealText", { userId });
    return emptyResult();
  }
  recordAiUse(userId);
  const parsed = await parseMealText(rawText);
  if (!parsed || parsed.length === 0) return emptyResult();

  const items: ParsedMealItem[] = [];
  let isEstimate = false;

  for (const item of parsed) {
    const resolved = await resolveFood(item.name);
    let kcal = item.kcal;
    let prot = item.protein_g;
    let carbs = item.carbs_g;
    let fat = item.fat_g;
    let dbId: string | null = null;
    let dbName: string | null = null;

    if (resolved && resolved.food.match_score >= MATCH_CONFIDENCE_THRESHOLD) {
      const grams = item.grams > 0 ? item.grams : (resolved.food.standard_portion_g ?? 100);
      const m = macros(resolved.food, grams);
      kcal = m.kcal; prot = m.protein_g; carbs = m.carbs_g; fat = m.fat_g;
      dbId = resolved.food.id;
      dbName = resolved.food.name;
      if (resolved.food.match_score < 0.85) isEstimate = true;
    } else {
      isEstimate = true;
    }
    if (item.is_estimate) isEstimate = true;

    items.push({
      name: item.name,
      grams: item.grams,
      kcal, protein_g: prot, carbs_g: carbs, fat_g: fat,
      food_item_id: dbId,
      matched_db_name: dbName,
    });
  }

  const matchedRatio = items.filter((i) => i.matched_db_name).length / Math.max(items.length, 1);
  const confidence = isEstimate ? 0.5 + matchedRatio * 0.2 : 0.8;
  return finalize(items, isEstimate, confidence, "ai");
}

function emptyResult(): ParseResult {
  return {
    items: [],
    totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    is_estimate: false,
    confidence: 0,
    source: "none",
  };
}

function sumTotals(items: ParsedMealItem[]) {
  return items.reduce(
    (acc, it) => ({
      kcal: acc.kcal + it.kcal,
      protein: acc.protein + it.protein_g,
      carbs: acc.carbs + it.carbs_g,
      fat: acc.fat + it.fat_g,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

function finalize(
  items: ParsedMealItem[],
  isEstimate: boolean,
  confidence: number,
  source: ParseResult["source"],
): ParseResult {
  return { items, totals: sumTotals(items), is_estimate: isEstimate, confidence, source };
}
