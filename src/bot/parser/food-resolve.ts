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
const strip = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * Detecta nombres corruptos de SARA2 (truncados en la importación).
 * Ejemplos: "gelada Milanesa de pollo, prefrita con-"
 *           "zada Milanesa de (carnicería) carne vacuna rebo-"
 *           "llería / Milanesa de granja) pollo rebozada (po-"
 */
function isCorruptName(name: string): boolean {
  const trimmed = name.trim();
  // Empieza con minúscula (fragmento de palabra anterior)
  if (/^[a-záéíóúü]/.test(trimmed)) return true;
  // Termina con guión (palabra cortada)
  if (trimmed.endsWith("-")) return true;
  // Tiene paréntesis desbalanceados
  const opens = (trimmed.match(/\(/g) || []).length;
  const closes = (trimmed.match(/\)/g) || []).length;
  if (opens !== closes) return true;
  return false;
}

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
  // "milanesa" sin tipo -> carne vacuna primero
  if (/\bmilanesas?\b/.test(q) && !/(pollo|pescado|soja|arroz)/.test(q)) {
    if (/\bcarne vacuna\b/.test(n)) b += 3;
    if (/(soja|arroz|pescado)/.test(n)) b -= 2;
  }
  // "huevo" sin parte -> entero primero
  if (/\bhuevos?\b/.test(q) && !/(yema|clara)/.test(q)) {
    if (/\bentero\b/.test(n)) b += 3;
    if (/(yema|clara)/.test(n)) b -= 3;
  }
  // "pollo" -> pollo sin piel primero, descartar partes sueltas raras
  if (/\bpollo\b/.test(q) && !/(grasa|menudos|higado)/.test(q)) {
    if (/\bgrasa\b/.test(n)) b -= 5;
    if (/\bmenudos\b/.test(n)) b -= 5;
    if (/\bhigado\b/.test(n)) b -= 5;
    if (/\bsin piel\b/.test(n)) b += 2;
  }
  // "pan" -> pan blanco lacteado o frances primero
  if (/\bpan\b/.test(q) && !/(rallado|arabe|salvado|integral|dulce)/.test(q)) {
    if (/\b(blanco|lacteado|frances)\b/.test(n)) b += 2;
    if (/\brallado\b/.test(n)) b -= 3;
  }
  // "leche" -> leche entera fluida primero, castigar leche materna y en polvo
  if (/\bleche\b/.test(q) && !/(materna|polvo|condensada|almendra|soja|descremada)/.test(q)) {
    if (/\bentera\b/.test(n)) b += 3;
    if (/\bfluida\b/.test(n)) b += 2;
    if (/(materna|polvo|condensada)/.test(n)) b -= 5;
  }
  return b;
}

export async function resolveFood(rawQuery: string): Promise<ResolveOutcome> {
  const { query, state } = extractState(rawQuery);

  const cands = await foodRepo.searchFoodCandidates(query, 25);
  if (cands.length === 0) return { kind: "none" };

  const ranked = rankByCoverage(query, cands);

  // Plausibles: cobertura mínima + sacar SIN TACC salvo que lo pidan + sacar corruptos.
  const askedSinTacc = /sin tacc/.test(strip(query));
  let plausible = ranked
    .filter((r) => r.coverage >= COVERAGE_FLOOR)
    .filter((r) => askedSinTacc || !/sin tacc/.test(strip(r.item.name)))
    .filter((r) => !isCorruptName(r.item.name));

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

  // Si todos los candidatos tienen la misma cobertura máxima y el query
  // es genérico (1 token significativo, ej "milanesa"), auto-pick el
  // primero (el más específico/corto) en vez de preguntar con opciones
  // que al usuario no le dicen nada.
  const topCov = pool[0].coverage;
  const allSameCov = pool.every((r) => Math.abs(r.coverage - topCov) < 0.01);
  const queryTokenCount = query.split(/\s+/).filter((t) => t.length >= 2).length;
  if (allSameCov && queryTokenCount <= 1) {
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
