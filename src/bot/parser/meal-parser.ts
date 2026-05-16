import * as foodRepo from "../../repositories/food.repo.js";
import * as frequentMealRepo from "../../repositories/frequent-meal.repo.js";
import { splitMealText } from "../../services/gemini.service.js";
import { canUseAi, recordAiUse } from "../../services/ai-budget.service.js";
import { logger } from "../../config/logger.js";
import { parseMealItems, type ParsedItem } from "./meal-items.js";
import { resolveFood, classifyState, type FoodState } from "./food-resolve.js";
import type { FoodItem, FoodCandidate } from "../../repositories/food.repo.js";
import type { MealStateClarify, PendingMeal } from "../session.store.js";

const MATCH_CONFIDENCE_THRESHOLD = 0.5;

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
  note?: string | null;
  state?: FoodState;
}

export interface ClarifyOption {
  food_item_id: string;
  name: string;
}

/** Un item que quedó pendiente de desambiguar (varias opciones en la DB). */
export interface ClarifyEntry {
  /** lo necesitamos para recalcular gramos tras la elección. */
  item: ParsedItem;
  options: ClarifyOption[];
}

export interface FoodClarify {
  resolved: ParsedMealItem[];
  queue: ClarifyEntry[];
  raw_input: string;
  is_estimate: boolean;
}

export interface ParseResult {
  items: ParsedMealItem[];
  totals: { kcal: number; protein: number; carbs: number; fat: number };
  is_estimate: boolean;
  confidence: number;
  source:
    | "alias" | "quick" | "descriptive" | "ai" | "none"
    | "needs_clarification" | "needs_food_clarification"
    | "needs_state_clarification";
  frequent_meal_id?: string;
  food_hint?: string;
  food_clarify?: FoodClarify;
  state_clarify?: MealStateClarify;
  raw_input?: string;
}

/**
 * Parser de comidas. La verdad es SIEMPRE food_items (SARA2) + food_portions.
 *   1) ALIAS — frequent_meals del user.
 *   2) QUICK — regex split + resolver determinístico (coverage).
 *   3) AI    — Gemini SOLO separa el texto; el resolver es el mismo.
 * Si un alimento es ambiguo (varias variedades/estados en la DB) → se
 * pregunta con lista numerada (no se adivina, la AI no inventa macros).
 */
export async function parseMeal(
  userId: string,
  normalized: string,
  rawText: string,
  opts: { skipClarification?: boolean } = {},
): Promise<ParseResult> {
  const alias = await tryAlias(userId, normalized);
  if (alias) return alias;

  const quickItems = parseMealItems(normalized);
  if (quickItems.length > 0) {
    const res = await resolveItems(quickItems, rawText, "quick");
    if (res.items.length > 0 || res.source === "needs_food_clarification") return res;
  }

  if (!opts.skipClarification && !/\d/.test(normalized) && quickItems.length === 0) {
    return {
      items: [], totals: zero(), is_estimate: false, confidence: 0,
      source: "needs_clarification", food_hint: extractFoodHint(normalized),
    };
  }

  return tryAi(rawText, userId);
}

const MEAL_VERB_PREFIX =
  /^(?:me\s+)?(?:comi|come|comer|cene|ceno|cenar|desayune|desayuno|desayunar|almorce|almorzo|almorzar|merende|merendar|tome|tomo|tomar|probé|probe|probar)\s+/;

function extractFoodHint(normalized: string): string {
  return normalized.replace(MEAL_VERB_PREFIX, "").trim() || normalized;
}

const zero = () => ({ kcal: 0, protein: 0, carbs: 0, fat: 0 });

// ── 1) ALIAS ────────────────────────────────────────────────
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
        kcal: match.total_kcal, protein: match.total_protein_g,
        carbs: match.total_carbs_g, fat: match.total_fat_g,
      },
      is_estimate: false, confidence: 1.0, source: "alias",
      frequent_meal_id: match.id,
    };
  }
  return null;
}

// ── macros / gramos ─────────────────────────────────────────
export function macros(food: Pick<FoodItem, "kcal_per_100g" | "protein_per_100g" | "carbs_per_100g" | "fat_per_100g">, grams: number) {
  const f = grams / 100;
  return {
    kcal: food.kcal_per_100g * f,
    protein_g: food.protein_per_100g * f,
    carbs_g: food.carbs_per_100g * f,
    fat_g: food.fat_per_100g * f,
  };
}

/** Resuelve gramos según el modo del item + food_portions. */
export async function resolveGrams(
  item: ParsedItem,
  foodId: string,
  standardPortionG: number | null,
  state: FoodState,
): Promise<{ grams: number; estimate: boolean }> {
  if (item.mode === "grams") return { grams: item.qty, estimate: false };

  if (item.mode === "measure" && item.measure) {
    const p = await foodRepo.findPortionByMeasure(foodId, item.measure, state ?? undefined);
    if (p) return { grams: Math.round(item.qty * p.portion_grams), estimate: false };
    const generic = GENERIC_MEASURE_G[item.measure];
    if (generic) return { grams: Math.round(item.qty * generic), estimate: true };
  }

  const def = await foodRepo.getDefaultPortion(foodId, state ?? undefined);
  if (def) return { grams: Math.round(item.qty * def.portion_grams), estimate: item.mode === "bare" };
  if (standardPortionG) return { grams: Math.round(item.qty * standardPortionG), estimate: true };
  return { grams: Math.round(item.qty * 100), estimate: true };
}

/** Construye un ParsedMealItem ya resuelto (food elegido). */
export async function buildItem(
  pi: ParsedItem,
  food: FoodItem,
  state: FoodState,
): Promise<{ entry: ParsedMealItem; estimate: boolean }> {
  const st = state ?? classifyState(food.name);
  const { grams, estimate } = await resolveGrams(pi, food.id, food.standard_portion_g, st);
  const m = macros(food, grams);
  return {
    entry: {
      name: pi.food, grams,
      kcal: m.kcal, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g,
      food_item_id: food.id, matched_db_name: food.name, state: st,
    },
    estimate,
  };
}

// ── 2) RESOLVER (compartido quick + AI) ─────────────────────
async function resolveItems(
  items: ParsedItem[],
  rawText: string,
  source: "quick" | "ai",
): Promise<ParseResult> {
  const resolved: ParsedMealItem[] = [];
  const queue: ClarifyEntry[] = [];
  let isEstimate = false;

  for (const pi of items) {
    const r = await resolveFood(pi.food);

    if (r.kind === "resolved") {
      const { entry, estimate } = await buildItem(pi, r.food, r.state);
      if (estimate) isEstimate = true;
      resolved.push(entry);
    } else if (r.kind === "ambiguous") {
      queue.push({
        item: pi,
        options: r.options.map((o: FoodCandidate) => ({ food_item_id: o.id, name: o.name })),
      });
    } else if (pi.mode === "grams") {
      resolved.push({
        name: pi.food, grams: pi.qty,
        kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
        food_item_id: null, matched_db_name: null,
      });
      isEstimate = true;
    }
  }

  if (queue.length > 0) {
    return {
      items: resolved,
      totals: sumTotals(resolved),
      is_estimate: isEstimate,
      confidence: 0,
      source: "needs_food_clarification",
      food_clarify: { resolved, queue, raw_input: rawText, is_estimate: isEstimate },
    };
  }

  if (resolved.length === 0) {
    return { items: [], totals: zero(), is_estimate: false, confidence: 0, source: "none" };
  }

  // ── Deteccion crudo/cocido — si un item resolvió pero tiene ambas
  //    variantes en la DB, preguntar al user.
  const sc = await detectStateClarify(resolved);
  if (sc) {
    return {
      items: resolved,
      totals: sumTotals(resolved),
      is_estimate: isEstimate,
      confidence: 0,
      source: "needs_state_clarification",
      state_clarify: sc,
      raw_input: rawText,
    };
  }

  const allMatched = resolved.every((i) => i.matched_db_name);
  const confidence = allMatched && !isEstimate ? 0.9 : allMatched ? 0.8 : 0.65;
  return finalize(resolved, isEstimate, confidence, source);
}

/**
 * Aplica la elección del usuario sobre el item ambiguo `entry`.
 * Devuelve el ParsedMealItem calculado (macros desde SARA2).
 */
export async function applyFoodChoice(
  entry: ClarifyEntry,
  option: ClarifyOption,
): Promise<ParsedMealItem | null> {
  const food = await foodRepo.getFoodById(option.food_item_id);
  if (!food) return null;
  const { entry: built } = await buildItem(entry.item, food, classifyState(food.name));
  return built;
}

// ── 3) AI fallback (SOLO split, sin macros) ─────────────────
async function tryAi(rawText: string, userId: string): Promise<ParseResult> {
  if (!canUseAi(userId)) {
    logger.warn("ai budget exceeded — skipping splitMealText", { userId });
    return { items: [], totals: zero(), is_estimate: false, confidence: 0, source: "none" };
  }
  recordAiUse(userId);
  const split = await splitMealText(rawText);
  if (!split || split.length === 0) {
    return { items: [], totals: zero(), is_estimate: false, confidence: 0, source: "none" };
  }

  const items: ParsedItem[] = split.map((s) => {
    const mode: ParsedItem["mode"] =
      s.unit === "g" ? "grams" :
      s.unit === "units" ? "units" :
      s.unit === "measure" ? "measure" :
      s.qty != null ? "units" : "bare";
    const food = s.state ? `${s.food} ${s.state}` : s.food;
    return {
      raw: s.food,
      mode,
      qty: s.qty ?? 1,
      measure: s.measure ?? undefined,
      food,
    };
  });

  return resolveItems(items, rawText, "ai");
}

function sumTotals(items: ParsedMealItem[]) {
  return items.reduce(
    (a, it) => ({
      kcal: a.kcal + it.kcal,
      protein: a.protein + it.protein_g,
      carbs: a.carbs + it.carbs_g,
      fat: a.fat + it.fat_g,
    }),
    zero(),
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

// ── Deteccion de ambigüedad crudo/cocido ─────────────────────
// Busca el primer item resuelto cuyo alimento tiene AMBAS variantes
// (crudo+cocido) en la DB y el usuario NO especificó estado.
async function detectStateClarify(
  items: ParsedMealItem[],
): Promise<MealStateClarify | null> {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.food_item_id || it.state) continue; // ya tiene estado o sin match

    const food = await foodRepo.getFoodById(it.food_item_id);
    if (!food) continue;

    // Buscar la variante opuesta por nombre base (ej: "Arroz, blanco" → crudo/cocido)
    const nameBase = food.name.replace(/,?\s*(crud[oa]s?|cocid[oa]s?|hervid[oa]s?)\b.*/i, "").trim();
    const cands = await foodRepo.searchFoodCandidates(nameBase, 10);

    const crudoItem = cands.find((c) => classifyState(c.name) === "crudo");
    const cocidoItem = cands.find((c) => classifyState(c.name) === "cocido");

    if (crudoItem && cocidoItem) {
      const grams = it.grams;
      const f = grams / 100;
      return {
        item_index: i,
        food_label: nameBase || food.name,
        grams,
        crudo: {
          food_item_id: crudoItem.id,
          kcal: crudoItem.kcal_per_100g * f,
          protein_g: crudoItem.protein_per_100g * f,
          carbs_g: crudoItem.carbs_per_100g * f,
          fat_g: crudoItem.fat_per_100g * f,
        },
        cocido: {
          food_item_id: cocidoItem.id,
          kcal: cocidoItem.kcal_per_100g * f,
          protein_g: cocidoItem.protein_per_100g * f,
          carbs_g: cocidoItem.carbs_per_100g * f,
          fat_g: cocidoItem.fat_per_100g * f,
        },
      };
    }
  }
  return null;
}

/**
 * Aplica la elección crudo/cocido del usuario sobre el item ambiguo.
 * Recalcula macros del item con la variante elegida.
 */
export async function applyStateChoice(
  items: PendingMeal["parsed_items"],
  clarify: MealStateClarify,
  choice: "crudo" | "cocido",
): Promise<{ items: ParsedMealItem[]; totals: ReturnType<typeof sumTotals> }> {
  const variant = choice === "crudo" ? clarify.crudo : clarify.cocido;
  const updated = items.map((it, idx) => {
    if (idx !== clarify.item_index) return it;
    return {
      ...it,
      food_item_id: variant.food_item_id,
      kcal: variant.kcal,
      protein_g: variant.protein_g,
      carbs_g: variant.carbs_g,
      fat_g: variant.fat_g,
      state: choice as FoodState,
    };
  });
  return { items: updated, totals: sumTotals(updated) };
}

export type { PendingMeal };
// Re-export for consumers that need the clarify entry type
export type { MealStateClarify };

export { MATCH_CONFIDENCE_THRESHOLD };
