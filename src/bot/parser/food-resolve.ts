/**
 * Resolución de un alimento (texto libre) → fila de food_items, con:
 *   - default de variedad: "arroz" → blanco, "fideos" → trigo (NO sin TACC)
 *   - estado crudo/cocido: detectado del texto o ambiguo (preguntar)
 *
 * No calcula gramos ni macros — solo elige QUÉ fila de food_items.
 */
import * as foodRepo from "../../repositories/food.repo.js";
import type { FoodMatch } from "../../repositories/food.repo.js";
import { isStatefulFood } from "./cooking-factors.js";

export type FoodState = "crudo" | "cocido" | null;

export interface ResolvedFood {
  /** Mejor fila elegida (según estado conocido o default). */
  food: FoodMatch;
  state: FoodState;
  /** Texto para avisar al usuario qué se asumió ("Asumí arroz blanco…"). */
  note: string | null;
  /** Si el estado es ambiguo y conviene preguntar crudo/cocido. */
  ambiguousState: boolean;
  crudoFood?: FoodMatch;
  cocidoFood?: FoodMatch;
}

const CRUDO_RE = /\b(crudo|cruda|crudos|crudas|sin cocinar)\b/;
const COCIDO_RE = /\b(cocido|cocida|cocidos|cocidas|hervido|hervida|hervidos|cocinad[oa]|al dente)\b/;

const NAME_CRUDO_RE = /\b(crud[oa]s?)\b/;
const NAME_COCIDO_RE = /\b(cocid[oa]s?|hervid[oa]s?)\b/;

/** Extrae el estado mencionado en el texto y lo quita del query. */
export function extractState(text: string): { query: string; state: FoodState } {
  let state: FoodState = null;
  if (COCIDO_RE.test(text)) state = "cocido";
  else if (CRUDO_RE.test(text)) state = "crudo";
  const query = text.replace(CRUDO_RE, "").replace(COCIDO_RE, "").replace(/\s+/g, " ").trim();
  return { query: query || text, state };
}

/**
 * Reglas de default de variedad. Devuelve el query (posiblemente
 * enriquecido) y un texto de aviso si asumimos algo.
 */
function applyVarietyDefault(query: string): { query: string; note: string | null } {
  const q = query.toLowerCase();

  // "arroz" sin variedad → blanco
  if (/\barroz\b/.test(q) && !/(integral|yamani|basmati|primavera|con pollo|salvaje)/.test(q)) {
    return { query: `${query} blanco`, note: "Asumí arroz blanco. Si es otro tipo, decime." };
  }
  // "fideos/pasta" sin tipo → trigo común (NO sin TACC / arroz / soja)
  if (/\b(fideos?|pasta|tallarines?)\b/.test(q) && !/(sin tacc|arroz|soja|integral|legumbre)/.test(q)) {
    return { query, note: "Asumí fideos de trigo. Si es otro tipo, decime." };
  }
  return { query, note: null };
}

function classifyState(name: string): FoodState {
  if (NAME_COCIDO_RE.test(name.toLowerCase())) return "cocido";
  if (NAME_CRUDO_RE.test(name.toLowerCase())) return "crudo";
  return null;
}

/** Penaliza candidatos no deseados (SIN TACC cuando no se pidió). */
function score(c: FoodMatch, q: string): number {
  let s = c.match_score;
  const n = c.name.toLowerCase();
  if (/sin tacc/.test(n) && !/sin tacc/.test(q)) s -= 0.4;
  if (/\barroz\b/.test(q) && /\bblanco\b/.test(n)) s += 0.15;
  if (/\b(fideos?|pasta|tallarines?)\b/.test(q) && /\btrigo\b/.test(n)) s += 0.1;
  return s;
}

export async function resolveFood(rawQuery: string): Promise<ResolvedFood | null> {
  const { query: noState, state } = extractState(rawQuery);
  const { query, note } = applyVarietyDefault(noState);

  const matches = await foodRepo.searchFood(query, 12);
  if (matches.length === 0) {
    // reintento sin el enriquecimiento de variedad
    const fallback = await foodRepo.searchFood(noState, 12);
    if (fallback.length === 0) return null;
    matches.push(...fallback);
  }

  const ranked = [...matches].sort((a, b) => score(b, query) - score(a, query));
  const best = ranked[0];

  const crudoFood = ranked.find((c) => classifyState(c.name) === "crudo");
  const cocidoFood = ranked.find((c) => classifyState(c.name) === "cocido");

  // Estado explícito en el texto → elegir esa variante.
  if (state) {
    const wanted = state === "crudo" ? crudoFood : cocidoFood;
    return {
      food: wanted ?? best,
      state,
      note,
      ambiguousState: false,
      crudoFood,
      cocidoFood,
    };
  }

  // Sin estado: ambiguo solo si el alimento es "stateful" y existen
  // ambas variantes con score decente.
  const ambiguous =
    isStatefulFood(query) &&
    !!crudoFood &&
    !!cocidoFood &&
    crudoFood.id !== cocidoFood.id;

  return {
    food: best,
    state: classifyState(best.name),
    note,
    ambiguousState: ambiguous,
    crudoFood,
    cocidoFood,
  };
}
