/**
 * Resuelve un texto de alimento → fila(s) de food_items.
 *
 * NO adivina ni inventa: si hay varias variedades/estados plausibles en
 * la DB, devuelve `ambiguous` con las opciones REALES para que el bot le
 * pregunte al usuario (lista numerada). La verdad es siempre SARA2.
 */
import * as foodRepo from "../../repositories/food.repo.js";
import type { FoodCandidate } from "../../repositories/food.repo.js";
import { rankByCoverage } from "./food-match.js";

export type FoodState = "crudo" | "cocido" | null;

export type ResolveOutcome =
  | { kind: "resolved"; food: FoodCandidate; state: FoodState }
  | { kind: "ambiguous"; options: FoodCandidate[]; state: FoodState; query: string }
  | { kind: "none" };

const CRUDO_RE = /\b(crudo|cruda|crudos|crudas|sin cocinar)\b/;
const COCIDO_RE = /\b(cocido|cocida|cocidos|cocidas|hervido|hervida|hervidos|cocinad[oa]|al dente)\b/;
const NAME_CRUDO_RE = /\bcrud[oa]s?\b/;
const NAME_COCIDO_RE = /\b(cocid[oa]s?|hervid[oa]s?)\b/;

const COVERAGE_FLOOR = 0.5;
const MAX_OPTIONS = 6;
const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function extractState(text: string): { query: string; state: FoodState } {
  let state: FoodState = null;
  if (COCIDO_RE.test(text)) state = "cocido";
  else if (CRUDO_RE.test(text)) state = "crudo";
  const query = text.replace(CRUDO_RE, "").replace(COCIDO_RE, "").replace(/\s+/g, " ").trim();
  return { query: query || text, state };
}

export function classifyState(name: string): FoodState {
  const n = strip(name);
  if (NAME_COCIDO_RE.test(n)) return "cocido";
  if (NAME_CRUDO_RE.test(n)) return "crudo";
  return null;
}

/** Sesgo de ordenamiento dentro de igual cobertura (no fuerza, ordena). */
function bias(query: string, name: string): number {
  const q = strip(query);
  const n = strip(name);
  let b = 0;
  // "arroz" sin variedad → blanco primero
  if (/\barroz\b/.test(q) && !/(integral|yamani|basmati|salvaje)/.test(q)) {
    if (/\bblanco\b/.test(n)) b += 2;
    if (/(integral|yamani|salvaje)/.test(n)) b -= 1;
  }
  // "fideos/pasta" sin tipo → trigo, NO sin tacc / arroz / soja
  if (/\b(fideos?|pasta|tallarines?)\b/.test(q) && !/(sin tacc|arroz|soja)/.test(q)) {
    if (/sin tacc|arroz|soja|legumbre/.test(n)) b -= 2;
  }
  return b;
}

export async function resolveFood(rawQuery: string): Promise<ResolveOutcome> {
  const { query, state } = extractState(rawQuery);

  const cands = await foodRepo.searchFoodCandidates(query, 25);
  if (cands.length === 0) return { kind: "none" };

  const ranked = rankByCoverage(query, cands);

  // Plausibles: cobertura mínima + sacar SIN TACC salvo que lo pidan.
  const askedSinTacc = /sin tacc/.test(strip(query));
  let plausible = ranked
    .filter((r) => r.coverage >= COVERAGE_FLOOR)
    .filter((r) => askedSinTacc || !/sin tacc/.test(strip(r.item.name)));

  if (plausible.length === 0) return { kind: "none" };

  // Reordenar por [cobertura, sesgo, nombre corto].
  plausible = plausible.sort(
    (a, b) =>
      b.coverage - a.coverage ||
      bias(query, b.item.name) - bias(query, a.item.name) ||
      a.item.name.length - b.item.name.length,
  );

  // Si hay estado explícito, filtrar a esa variante (si existe en nombres).
  let pool = plausible;
  if (state) {
    const byState = plausible.filter((r) => classifyState(r.item.name) === state);
    if (byState.length > 0) pool = byState;
  }

  const exact = pool.filter((r) => r.coverage >= 0.999);

  // Un único match exacto domina → resolver sin preguntar.
  if (exact.length === 1) {
    return { kind: "resolved", food: exact[0].item, state: state ?? classifyState(exact[0].item.name) };
  }
  // Un solo plausible → resolver.
  if (pool.length === 1) {
    return { kind: "resolved", food: pool[0].item, state: state ?? classifyState(pool[0].item.name) };
  }

  // Varias variedades/estados → preguntar con opciones reales.
  return {
    kind: "ambiguous",
    options: pool.slice(0, MAX_OPTIONS).map((r) => r.item),
    state,
    query,
  };
}
