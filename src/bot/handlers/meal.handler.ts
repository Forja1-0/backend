import type { User } from "../../types/user.types.js";
import { parseMeal, applyStateChoice, type ParseResult } from "../parser/meal-parser.js";
import * as mealRepo from "../../repositories/meal.repo.js";
import * as frequentMealRepo from "../../repositories/frequent-meal.repo.js";
import { sendText } from "../../services/evolution.service.js";
import {
  setSession,
  clearSession,
  type PendingMeal,
  type MealStateClarify,
} from "../session.store.js";
import { classify } from "../parser/intent-classifier.js";
import { normalize } from "../parser/normalize.js";
import * as T from "../personality/templates.js";
import { logger } from "../../config/logger.js";

const CONFIDENCE_AUTOSAVE = 0.7;

/**
 * Loguea una comida.
 *
 * Flow A (decidido): confirmacion solo si confidence < 0.7.
 *   - alias / quick / ai con SARA matches    → autosave + resumen
 *   - ai con solo estimaciones / dudoso      → resumen + pregunta "lo guardo?"
 */
export async function handleMealLog(
  user: User,
  rawText: string,
  normalized: string,
): Promise<boolean> {
  const jid = user.wa_chat_id!;

  let result: ParseResult;
  try {
    result = await parseMeal(user.id, normalized, rawText);
  } catch (err) {
    logger.error("meal parser failed", { err, rawText });
    await sendText(jid, T.mealFailed());
    return true;
  }

  if (result.source === "needs_clarification") {
    setSession(jid, {
      flow: "meal_clarify",
      raw_original: rawText,
      normalized_original: normalized,
      food_hint: result.food_hint ?? normalized,
    });
    await sendText(jid, T.mealClarify(result.food_hint ?? normalized));
    return true;
  }

  if (result.source === "needs_state_clarification" && result.state_clarify) {
    setSession(jid, {
      flow: "meal_state_clarify",
      items: result.items,
      clarify: result.state_clarify as MealStateClarify,
      is_estimate: result.is_estimate,
      raw_input: result.raw_input ?? rawText,
    });
    await sendText(jid, T.mealStateClarify(result.state_clarify));
    return true;
  }

  if (result.source === "none" || result.items.length === 0) {
    // No detectamos nada → devolvemos false para que el router decida
    // (mandar a unknown, no a meal failed).
    return false;
  }

  if (result.confidence >= CONFIDENCE_AUTOSAVE) {
    await persistMeal(user, rawText, result);
    await sendText(jid, T.mealRegistered(result.items, result.totals, result.is_estimate));
    return true;
  }

  // ── confidence baja → confirmacion ───────────────────────
  const pending: PendingMeal = {
    parsed_items: result.items,
    totals: result.totals,
    is_estimate: result.is_estimate,
    raw_input: rawText,
  };
  setSession(jid, { flow: "meal_confirm", meal: pending });
  await sendText(jid, T.mealConfirmAsk(result.items, result.totals));
  return true;
}

/**
 * Procesa la respuesta del usuario al "¿lo guardo?" (flow meal_confirm).
 * Llamado por el router cuando hay session activa.
 */
export async function handleMealConfirm(
  user: User,
  decision: "confirm" | "cancel",
  pending: PendingMeal,
): Promise<void> {
  const jid = user.wa_chat_id!;
  clearSession(jid);

  if (decision === "cancel") {
    await sendText(jid, T.mealConfirmCancelled());
    return;
  }

  // Reconstruimos un ParseResult-like para persistir
  await persistMeal(user, pending.raw_input, {
    items: pending.parsed_items,
    totals: pending.totals,
    is_estimate: pending.is_estimate,
    confidence: 1,
    source: "descriptive",
  });
  await sendText(jid, T.mealRegistered(pending.parsed_items, pending.totals, pending.is_estimate));
}

/**
 * Procesa la respuesta del usuario al pedido de aclaracion (flow meal_clarify).
 * Combina el texto original + la nueva info y re-parsea SIN volver a preguntar
 * (skipClarification). Si quick/alias resuelven → save directo, sin AI.
 * Si sigue sin cantidad → AI estima y avisamos explicitamente que es estimacion.
 */
export async function handleMealClarify(
  user: User,
  newText: string,
  session: { raw_original: string; normalized_original: string; food_hint: string },
): Promise<void> {
  const jid = user.wa_chat_id!;
  clearSession(jid);

  const combinedRaw = `${session.raw_original} ${newText}`.trim();
  const combinedNormalized = classify(combinedRaw).normalized;

  let result: ParseResult;
  try {
    result = await parseMeal(user.id, combinedNormalized, combinedRaw, { skipClarification: true });
  } catch (err) {
    logger.error("meal parser failed on clarify", { err, combinedRaw });
    await sendText(jid, T.mealFailed());
    return;
  }

  if (result.source === "none" || result.items.length === 0) {
    await sendText(jid, T.mealFailed());
    return;
  }

  await persistMeal(user, combinedRaw, result);

  // Si la cantidad la estimo la AI (no vino del usuario), avisamos explicitamente.
  const wasEstimated = result.source === "ai" || result.is_estimate;
  const message = wasEstimated
    ? T.mealRegisteredEstimated(result.items, result.totals)
    : T.mealRegistered(result.items, result.totals, result.is_estimate);
  await sendText(jid, message);
}

/**
 * Respuesta del usuario al "¿crudo o cocido?" (flow meal_state_clarify).
 * Recalcula el item ambiguo con la variante elegida y guarda.
 */
export async function handleMealStateClarify(
  user: User,
  answer: string,
  session: {
    items: PendingMeal["parsed_items"];
    clarify: MealStateClarify;
    is_estimate: boolean;
    raw_input: string;
  },
): Promise<void> {
  const jid = user.wa_chat_id!;
  clearSession(jid);

  const norm = normalize(answer);
  const choice: "crudo" | "cocido" =
    /\b(cocid|hervid|cocinad)/.test(norm) ? "cocido" :
    /\bcrud/.test(norm) ? "crudo" :
    "cocido"; // ambiguo → cocido (lo más frecuente al reportar comida hecha)

  const { items, totals } = await applyStateChoice(
    session.items,
    session.clarify,
    choice,
  );
  await persistMeal(user, session.raw_input, {
    items,
    totals,
    is_estimate: session.is_estimate,
    confidence: 1,
    source: "quick",
  });
  await sendText(jid, T.mealRegistered(items, totals, session.is_estimate));
}

async function persistMeal(user: User, rawText: string, result: ParseResult): Promise<void> {
  const inputMode =
    result.source === "alias" ? "quick" :
    result.source === "quick" ? "precise" :
    "descriptive";

  await mealRepo.saveMealLog({
    user_id: user.id,
    input_mode: inputMode,
    raw_input: rawText,
    parsed_items: result.items,
    total_kcal: result.totals.kcal,
    total_protein_g: result.totals.protein,
    total_carbs_g: result.totals.carbs,
    total_fat_g: result.totals.fat,
    is_estimate: result.is_estimate,
    confirmed: true,
  });

  if (result.frequent_meal_id) {
    await frequentMealRepo.bumpUseCount(result.frequent_meal_id);
  }
}
