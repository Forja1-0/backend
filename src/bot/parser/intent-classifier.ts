import { normalize, tokenize, extractGrams, extractStandaloneNumber } from "./normalize.js";
import { fuzzyTokenMatch } from "./fuzzy.js";
import { parseWeightKg } from "./weight-parse.js";
import * as P from "./patterns.js";

export type Intent =
  | "command_help"
  | "command_baja"
  | "command_perfil"
  | "greeting"
  | "gratitude"
  | "affirmation"
  | "negation"
  | "correction"
  | "numeric"
  | "weight_log"
  | "training_complete"
  | "training_skip"
  | "training_query"
  | "meal_log"
  | "nutrition_query"
  | "progress_query"
  | "disruption_injury"
  | "disruption_illness"
  | "disruption_desliz"
  | "unknown";

export interface Classification {
  intent: Intent;
  /** 0..1 — solo dispatch directo si >= 0.7. Entre 0.4 y 0.7 → AI desambigua. <0.4 → AI fallback. */
  confidence: number;
  normalized: string;
  tokens: string[];
  /** Datos extraidos durante la clasificacion para no recalcular en el handler. */
  features: Features;
}

interface Features {
  grams: number | null;
  standaloneNumber: number | null;
  hasMealVerb: boolean;
  hasMealTime: boolean;
  hasFoodHint: boolean;
  hasQuantity: boolean;
  hasTrainingNoun: boolean;
  hasMacroNoun: boolean;
  hasNegation: boolean;
  isShort: boolean;
}

/**
 * Clasifica un mensaje del usuario.
 * Estrategia: reglas ordenadas por especificidad. La primera que cumple gana.
 * Si ninguna cumple con suficiente confianza → 'unknown' → AI fallback en el router.
 *
 * Si hay una SESION ACTIVA, este clasificador NO se usa — el router despacha
 * directo al handler de la sesion. Esto cubre RPE, checkin, confirmacion de comida.
 */
export function classify(input: string): Classification {
  const normalized = normalize(input);
  const tokens = tokenize(normalized);
  const features = extractFeatures(normalized, tokens);

  const base = { normalized, tokens, features };

  // ── 1. COMMANDS exactos ──────────────────────────────────
  if (P.REGEX_HELP.test(normalized)) return { ...base, intent: "command_help", confidence: 1 };
  if (P.REGEX_BAJA.test(normalized)) return { ...base, intent: "command_baja", confidence: 1 };
  if (P.REGEX_PERFIL.test(normalized)) return { ...base, intent: "command_perfil", confidence: 1 };

  // ── 1b. PESO CORPORAL ("peso 82", "me pesé 79.5", "81 kg") ──
  // Antes que NUMERO PURO: "peso 82" tiene un número y 2 tokens, caería en
  // numeric. El guard excluye comidas ("comí 1kg de X" → meal, no peso).
  if (parseWeightKg(normalized) !== null && !(features.hasMealVerb && features.hasFoodHint)) {
    return { ...base, intent: "weight_log", confidence: 0.9 };
  }

  // ── 2. NUMERO PURO (RPE, sueño, dolor — solo significativo en sesion) ──
  // Si no hay sesion, igual lo marcamos: el router decide si tiene sentido.
  if (features.standaloneNumber !== null && tokens.length <= 2) {
    return { ...base, intent: "numeric", confidence: 0.95 };
  }

  // ── 3. AFIRMACION / NEGACION (cortos) ────────────────────
  if (features.isShort) {
    if (fuzzyTokenMatch(tokens, P.KEYWORDS_AFFIRMATION) && !features.hasNegation) {
      return { ...base, intent: "affirmation", confidence: 0.85 };
    }
    if (features.hasNegation && tokens.length <= 3) {
      return { ...base, intent: "negation", confidence: 0.85 };
    }
  }

  // ── 4. GREETING ──────────────────────────────────────────
  if (
    fuzzyTokenMatch(tokens, P.KEYWORDS_GREETING) &&
    tokens.length <= 4 &&
    !features.hasMealVerb &&
    !features.hasTrainingNoun
  ) {
    return { ...base, intent: "greeting", confidence: 0.9 };
  }

  // ── 5. GRATITUDE ─────────────────────────────────────────
  if (fuzzyTokenMatch(tokens, P.KEYWORDS_GRATITUDE) && tokens.length <= 5) {
    return { ...base, intent: "gratitude", confidence: 0.9 };
  }

  // ── 6. CORRECTION (relevante en flow de confirmacion) ────
  if (fuzzyTokenMatch(tokens, P.KEYWORDS_CORRECTION)) {
    return { ...base, intent: "correction", confidence: 0.85 };
  }

  // ── 7. MEAL SIGNALS (Calculamos antes para evitar falsos positivos) ──
  const mealSignals =
    (features.hasMealVerb ? 1 : 0) +
    (features.hasMealTime ? 1 : 0) +
    (features.hasFoodHint ? 1 : 0) +
    (features.hasQuantity ? 1 : 0) +
    (features.grams !== null ? 1 : 0);

  // ── 8. DISRUPTION (chequear ANTES que training_skip
  //                   para que "me lesione no pude" no caiga en skip) ──
  if (fuzzyTokenMatch(tokens, P.KEYWORDS_INJURY) && mealSignals < 2) {
    return { ...base, intent: "disruption_injury", confidence: 0.85 };
  }
  if (fuzzyTokenMatch(tokens, P.KEYWORDS_ILLNESS) && mealSignals < 2) {
    return { ...base, intent: "disruption_illness", confidence: 0.85 };
  }
  // Desliz: contextual
  const deslizResult = classifyDesliz(normalized, features);
  if (deslizResult) return { ...base, ...deslizResult };

  // ── 8. TRAINING ──────────────────────────────────────────
  // a) Completion fuerte (verbos claros)
  if (P.REGEX_TRAINING_COMPLETE_STRONG.test(normalized)) {
    return { ...base, intent: "training_complete", confidence: 0.9 };
  }
  // b) Completion debil ("hice") — solo si hay contexto de training
  if (P.REGEX_TRAINING_COMPLETE_WEAK.test(normalized) && features.hasTrainingNoun) {
    return { ...base, intent: "training_complete", confidence: 0.8 };
  }
  // c) Skip
  if (P.REGEX_TRAINING_SKIP.test(normalized)) {
    return { ...base, intent: "training_skip", confidence: 0.8 };
  }
  // d) Query: "que entreno hoy"
  if (P.REGEX_TRAINING_QUERY.test(normalized)) {
    return { ...base, intent: "training_query", confidence: 0.9 };
  }

  // ── 9. NUTRITION QUERY ───────────────────────────────────
  // "cuanta prote me falta", "cuantas kcal llevo", "macros del dia"
  const askingQty = fuzzyTokenMatch(tokens, P.KEYWORDS_QUERY_VERB);
  if (askingQty && features.hasMacroNoun) {
    return { ...base, intent: "nutrition_query", confidence: 0.9 };
  }
  if (askingQty && /\b(falta|queda|resta|llevo|consumi|hasta ahora)\b/.test(normalized)) {
    return { ...base, intent: "nutrition_query", confidence: 0.75 };
  }
  if (/\bmacros?\b/.test(normalized) && tokens.length <= 4) {
    return { ...base, intent: "nutrition_query", confidence: 0.85 };
  }

  // ── 10. PROGRESS QUERY ───────────────────────────────────
  if (fuzzyTokenMatch(tokens, P.KEYWORDS_PROGRESS)) {
    return { ...base, intent: "progress_query", confidence: 0.85 };
  }
  if (/\bcomo (voy|estoy|vamos)\b/.test(normalized)) {
    return { ...base, intent: "progress_query", confidence: 0.8 };
  }

  // ── 12. MEAL LOG ─────────────────────────────────────────
  // Score: cualquier combo de (verbo de comer | momento del dia) +
  //        (cantidad | comida) es bastante seguro.

  if (mealSignals >= 2) {
    return { ...base, intent: "meal_log", confidence: 0.85 };
  }
  if (mealSignals === 1 && (features.hasMealVerb || features.grams !== null)) {
    // Un verbo de comer solo, o "200g de algo" — confianza media, vamos igual
    return { ...base, intent: "meal_log", confidence: 0.65 };
  }
  // Solo una pista de comida pero sin cantidad ni verbo: AI desambigua
  if (features.hasFoodHint && tokens.length <= 6) {
    return { ...base, intent: "meal_log", confidence: 0.45 };
  }

  // ── 12. FALLBACK ─────────────────────────────────────────
  return { ...base, intent: "unknown", confidence: 0 };
}

/**
 * Decide si un mensaje es desliz usando contexto, no solo keywords.
 *
 *   STRONG (atracon, me pase, fui a comer afuera...) → desliz seguro
 *   TRIGGER (vino, pizza, helado...) → ambiguo:
 *     - 2+ triggers distintos                 → desliz (varias indulgencias)
 *     - 1 trigger + sin meal_verb/quantity    → desliz (mensaje stand-alone)
 *     - 1 trigger + meal_verb + healthy food  → NO desliz, deja pasar a meal_log
 *     - 1 trigger con cantidad >=3            → desliz (mucha cantidad)
 *
 * Devuelve { intent, confidence } o null si no es desliz.
 */
function classifyDesliz(
  normalized: string,
  features: Features,
): { intent: Intent; confidence: number } | null {
  // STRONG: matchea frase tal cual
  if (P.KEYWORDS_DESLIZ_STRONG.some((p) => normalized.includes(p))) {
    return { intent: "disruption_desliz", confidence: 0.9 };
  }

  // TRIGGER: alcohol + junk
  const alcoholHits = P.KEYWORDS_DESLIZ_TRIGGER_ALCOHOL.filter((kw) =>
    new RegExp(`\\b${kw}\\b`).test(normalized),
  );
  const junkHits = P.KEYWORDS_DESLIZ_TRIGGER_JUNK.filter((kw) =>
    new RegExp(`\\b${kw}\\b`).test(normalized),
  );
  const totalTriggers = alcoholHits.length + junkHits.length;
  if (totalTriggers === 0) return null;

  // 2+ triggers distintos → desliz seguro
  if (totalTriggers >= 2) return { intent: "disruption_desliz", confidence: 0.85 };

  // Cantidad alta con el trigger (ej: "6 birras")
  const highQty = /\b([3-9]|\d{2,})\s*(birras?|cervezas?|copas?|tragos?|vasos?|pintas?)\b/.test(normalized);
  if (highQty) return { intent: "disruption_desliz", confidence: 0.85 };

  // Junk food: casi siempre es desliz. Solo excluimos si va con comida sana
  // explicita en el mismo mensaje (ej: "comi ensalada de pollo con papas fritas").
  if (junkHits.length >= 1) {
    const hasHealthyCompanion =
      features.hasFoodHint &&
      /\b(ensalada|verduras|vegetales|pollo|pescado|atun|huevos?|arroz integral|avena|frutas?|yogur|queso magro)\b/.test(normalized);
    if (!hasHealthyCompanion) {
      return { intent: "disruption_desliz", confidence: 0.8 };
    }
    return null;
  }

  // Alcohol solo: contexto manda
  // 1 trigger + meal_verb + comida sana ("comi pollo con 1 copa de vino") → NO desliz
  if (features.hasMealVerb && features.hasFoodHint && features.hasQuantity) {
    return null;
  }

  // 1 trigger solo (sin meal_verb/food) → probablemente desliz stand-alone
  if (!features.hasMealVerb && !features.hasFoodHint) {
    return { intent: "disruption_desliz", confidence: 0.75 };
  }

  return null;
}

function extractFeatures(normalized: string, tokens: string[]): Features {
  return {
    grams: extractGrams(normalized),
    standaloneNumber: extractStandaloneNumber(normalized),
    hasMealVerb:
      fuzzyTokenMatch(tokens, P.KEYWORDS_MEAL_VERB) ||
      P.KEYWORDS_MEAL_VERB.some((kw) => kw.includes(" ") && normalized.includes(kw)),
    hasMealTime: P.KEYWORDS_MEAL_TIME.some((kw) => normalized.includes(kw)),
    hasFoodHint: fuzzyTokenMatch(tokens, P.KEYWORDS_FOOD_HINT),
    hasQuantity:
      P.REGEX_QUANTITY_UNIT.test(normalized) ||
      fuzzyTokenMatch(tokens, P.KEYWORDS_QUANTITY_WORD),
    hasTrainingNoun: fuzzyTokenMatch(tokens, P.KEYWORDS_TRAINING_NOUN),
    hasMacroNoun: fuzzyTokenMatch(tokens, P.KEYWORDS_MACRO_NOUN),
    hasNegation: fuzzyTokenMatch(tokens, P.KEYWORDS_NEGATION),
    isShort: tokens.length <= 3,
  };
}
