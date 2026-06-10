import type { User } from "../../types/user.types.js";
import { parseMeal, applyStateChoice, applyFoodChoice, buildItem, type ParseResult, type ClarifyEntry } from "../parser/meal-parser.js";
import * as mealRepo from "../../repositories/meal.repo.js";
import * as foodRepo from "../../repositories/food.repo.js";
import * as frequentMealRepo from "../../repositories/frequent-meal.repo.js";
import * as dailyRepo from "../../repositories/daily.repo.js";
import { assessDay, localHour } from "../personality/coach.js";
import { buildCoachReco } from "../coach-reco.js";
import { sendText } from "../../services/evolution.service.js";
import {
  setSession,
  clearSession,
  type PendingMeal,
  type MealStateClarify,
  type FoodClarify,
} from "../session.store.js";
import { classify } from "../parser/intent-classifier.js";
import { isAutoTargetUser } from "../../services/nutrition-target.service.js";
import { classifyState } from "../parser/food-resolve.js";
import { normalize } from "../parser/normalize.js";
import * as T from "../personality/templates.js";
import { logger } from "../../config/logger.js";
import { logBotEvent, EventTypes } from "../../services/events.service.js";

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
  aiItems?: import("../../schemas/bot.schema.js").AiMealItem[],
): Promise<boolean> {
  const jid = user.wa_chat_id!;

  let result: ParseResult;
  try {
    result = await parseMeal(user.id, normalized, rawText, { aiItems });
  } catch (err) {
    logger.error("meal parser failed", { err, rawText });
    logBotEvent(user.id, EventTypes.MEAL_FAILED, { stage: "parse", error: String(err) });
    await sendText(jid, T.mealFailed(), { userId: user.id, category: "meal_failed" });
    return true;
  }

  logBotEvent(user.id, EventTypes.MEAL_PARSED, {
    source: result.source,
    confidence: result.confidence,
    is_estimate: result.is_estimate,
    item_count: result.items?.length ?? 0,
    kcal: result.totals?.kcal ?? 0,
  });

  if (result.source === "needs_clarification") {
    setSession(jid, {
      flow: "meal_clarify",
      raw_original: rawText,
      normalized_original: normalized,
      food_hint: result.food_hint ?? normalized,
    });
    logBotEvent(user.id, EventTypes.MEAL_CLARIFY_REQUESTED, { food_hint: result.food_hint ?? normalized });
    await sendText(jid, T.mealClarify(result.food_hint ?? normalized), {
      userId: user.id,
      category: "meal_clarify",
    });
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
    logBotEvent(user.id, EventTypes.MEAL_STATE_CLARIFY, {});
    await sendText(jid, T.mealStateClarify(result.state_clarify), {
      userId: user.id,
      category: "meal_state_clarify",
    });
    return true;
  }

  if (result.source === "needs_food_clarification" && result.food_clarify) {
    const fc = result.food_clarify as FoodClarify;
    const first = fc.queue[0];
    if (first) {
      setSession(jid, { flow: "meal_food_clarify", clarify: fc });
      logBotEvent(user.id, EventTypes.MEAL_FOOD_CLARIFY, {
        food: first.item.food,
        option_count: first.options.length,
      });
      await sendText(jid, T.mealFoodClarify(first.item.food, first.options), {
        userId: user.id,
        category: "meal_food_clarify",
      });
      return true;
    }
  }

  if (result.source === "none" || result.items.length === 0) {
    // No detectamos nada → devolvemos false para que el router decida
    // (mandar a unknown, no a meal failed).
    return false;
  }

  if (result.confidence >= CONFIDENCE_AUTOSAVE) {
    await persistMeal(user, rawText, result);
    logBotEvent(user.id, EventTypes.MEAL_LOGGED, {
      source: result.source,
      auto_saved: true,
      is_estimate: result.is_estimate,
      kcal: result.totals.kcal,
      protein_g: result.totals.protein,
      carbs_g: result.totals.carbs,
      fat_g: result.totals.fat,
      item_count: result.items.length,
    });
    await sendMealResult(user, T.mealRegistered(result.items, result.totals, result.is_estimate));
    return true;
  }

  // ── confidence baja ───────────────────────────────────────
  // Amateur (sin plan manual): NO interrogamos. La gracia del modo amateur es
  // que tira sus comidas desordenadas y el bot trackea — registramos la
  // estimación y le decimos que puede corregir. Elite mantiene el "¿lo guardo?".
  if (await isAutoTargetUser(user.id)) {
    await persistMeal(user, rawText, result);
    logBotEvent(user.id, EventTypes.MEAL_LOGGED, {
      source: result.source,
      auto_saved: true,
      amateur_estimate: true,
      is_estimate: result.is_estimate,
      kcal: result.totals.kcal,
      protein_g: result.totals.protein,
      carbs_g: result.totals.carbs,
      fat_g: result.totals.fat,
      item_count: result.items.length,
    });
    await sendMealResult(user, T.mealRegisteredEstimated(result.items, result.totals));
    return true;
  }

  // ── Elite: confidence baja → confirmacion ─────────────────
  const pending: PendingMeal = {
    parsed_items: result.items,
    totals: result.totals,
    is_estimate: result.is_estimate,
    raw_input: rawText,
  };
  setSession(jid, { flow: "meal_confirm", meal: pending });
  logBotEvent(user.id, EventTypes.MEAL_CONFIRM_REQUESTED, {
    kcal: result.totals.kcal,
    item_count: result.items.length,
  });
  await sendText(jid, T.mealConfirmAsk(result.items, result.totals), {
    userId: user.id,
    category: "meal_confirm_ask",
  });
  return true;
}

/**
 * Flujo "corregir" SIN sesión activa: el usuario ya tenía una comida guardada
 * (típicamente el autosave estimado de amateur) y quiere rehacerla. Antes el
 * bot prometía "piso la anterior" pero NUNCA borraba nada → la corrección
 * entraba como comida nueva y contaba doble. Ahora borramos de verdad el último
 * registro de HOY, refrescamos el día y le pedimos la versión corregida.
 */
export async function handleMealCorrection(user: User): Promise<void> {
  const jid = user.wa_chat_id!;
  const last = await mealRepo.getLastMealToday(user.id);
  if (!last) {
    await sendText(jid, T.correctionNothingToFix(), {
      userId: user.id,
      category: "correction_nothing",
    });
    return;
  }

  await mealRepo.deleteMealLog(user.id, last.id);
  try {
    await dailyRepo.refreshDailySummary(user.id);
  } catch (err) {
    logger.error("refreshDailySummary failed after correction", { err, userId: user.id });
  }
  logBotEvent(user.id, EventTypes.MEAL_CANCELLED, {
    via_correction: true,
    kcal: last.total_kcal,
  });
  await sendText(jid, T.correctionDeleted(last.raw_input, last.total_kcal), {
    userId: user.id,
    category: "correction_deleted",
  });
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
    logBotEvent(user.id, EventTypes.MEAL_CANCELLED, {
      kcal: pending.totals.kcal,
      item_count: pending.parsed_items.length,
    });
    await sendText(jid, T.mealConfirmCancelled(), {
      userId: user.id,
      category: "meal_confirm_cancelled",
    });
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
  logBotEvent(user.id, EventTypes.MEAL_CONFIRMED, {
    is_estimate: pending.is_estimate,
    kcal: pending.totals.kcal,
    protein_g: pending.totals.protein,
    carbs_g: pending.totals.carbs,
    fat_g: pending.totals.fat,
    item_count: pending.parsed_items.length,
  });
  await sendMealResult(user, T.mealRegistered(pending.parsed_items, pending.totals, pending.is_estimate));
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
    logBotEvent(user.id, EventTypes.MEAL_FAILED, { stage: "clarify_parse", error: String(err) });
    await sendText(jid, T.mealFailed(), { userId: user.id, category: "meal_failed" });
    return;
  }

  if (result.source === "none" || result.items.length === 0) {
    logBotEvent(user.id, EventTypes.MEAL_FAILED, { stage: "clarify_no_items" });
    await sendText(jid, T.mealFailed(), { userId: user.id, category: "meal_failed" });
    return;
  }

  await persistMeal(user, combinedRaw, result);
  logBotEvent(user.id, EventTypes.MEAL_LOGGED, {
    source: result.source,
    via_clarify: true,
    is_estimate: result.is_estimate,
    kcal: result.totals.kcal,
    protein_g: result.totals.protein,
    carbs_g: result.totals.carbs,
    fat_g: result.totals.fat,
    item_count: result.items.length,
  });

  // Si la cantidad la estimo la AI (no vino del usuario), avisamos explicitamente.
  const wasEstimated = result.source === "ai" || result.is_estimate;
  const message = wasEstimated
    ? T.mealRegisteredEstimated(result.items, result.totals)
    : T.mealRegistered(result.items, result.totals, result.is_estimate);
  await sendMealResult(user, message);
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
  logBotEvent(user.id, EventTypes.MEAL_LOGGED, {
    source: "quick",
    via_state_clarify: true,
    state_choice: choice,
    is_estimate: session.is_estimate,
    kcal: totals.kcal,
    protein_g: totals.protein,
    carbs_g: totals.carbs,
    fat_g: totals.fat,
    item_count: items.length,
  });
  await sendMealResult(user, T.mealRegistered(items, totals, session.is_estimate));
}

/**
 * Manda el resumen "✅ Registrado" + el bloque de coach (te queda hoy,
 * alertas de pasado/poco, alerta temprana por hora). Si el user no tiene
 * plan nutricional activo, manda solo el resumen (sin coach). Llamar
 * SIEMPRE después de persistMeal — la vista ya incluye la comida nueva.
 */
async function sendMealResult(user: User, baseMessage: string): Promise<void> {
  const jid = user.wa_chat_id!;
  let suffix = "";
  try {
    const row = await dailyRepo.getDailyRemaining(user.id);
    if (row) {
      const assessment = assessDay(row, localHour(user.timezone));
      const reco = await buildCoachReco(assessment);
      suffix = T.coachAfterMeal(assessment, reco);
    }
  } catch (err) {
    logger.error("coach block failed", { err, userId: user.id });
  }
  await sendText(jid, baseMessage + suffix, {
    userId: user.id,
    category: "meal_registered",
  });
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

  // Refrescamos el daily_summary del dia para que el perfil web muestre el
  // historial/adherencia de HOY al instante (antes solo se rellenaba en el
  // checkin nocturno). Best-effort: si falla, la comida ya quedo guardada.
  try {
    await dailyRepo.refreshDailySummary(user.id);
  } catch (err) {
    logger.error("refreshDailySummary failed after meal", { err, userId: user.id });
  }

  if (result.frequent_meal_id) {
    await frequentMealRepo.bumpUseCount(result.frequent_meal_id);
  }
}

/**
 * Procesa la respuesta del usuario al pedir desambiguación de alimento
 * (flow meal_food_clarify). El user responde con un número que
 * corresponde a una de las opciones REALES de la DB.
 */
export async function handleMealFoodClarify(
  user: User,
  answer: string,
  session: { clarify: FoodClarify },
): Promise<void> {
  const jid = user.wa_chat_id!;
  const fc = session.clarify;
  const current = fc.queue[0];

  if (!current) {
    clearSession(jid);
    await sendText(jid, T.mealFailed());
    return;
  }

  // Parsear número
  const num = parseInt(answer.trim(), 10);
  if (isNaN(num) || num < 1 || num > current.options.length) {
    // No entendimos, repetir la pregunta
    logBotEvent(user.id, "meal.food_clarify_invalid", { raw: answer });
    await sendText(jid, T.mealFoodClarify(current.item.food, current.options), {
      userId: user.id,
      category: "meal_food_clarify_retry",
    });
    return;
  }

  const chosen = current.options[num - 1];
  const food = await foodRepo.getFoodById(chosen.food_item_id);

  if (!food) {
    clearSession(jid);
    logBotEvent(user.id, EventTypes.MEAL_FAILED, { stage: "food_clarify_missing_food" });
    await sendText(jid, T.mealFailed(), { userId: user.id, category: "meal_failed" });
    return;
  }

  // Construir el item con macros de SARA2
  const { entry, estimate } = await buildItem(
    current.item as any,
    food,
    classifyState(food.name),
  );
  if (estimate) fc.is_estimate = true;
  fc.resolved.push(entry);

  // Quitar el item procesado de la cola
  fc.queue.shift();

  // ¿Quedan más items por desambiguar?
  if (fc.queue.length > 0) {
    const next = fc.queue[0];
    setSession(jid, { flow: "meal_food_clarify", clarify: fc });
    logBotEvent(user.id, EventTypes.MEAL_FOOD_CLARIFY, {
      food: next.item.food,
      option_count: next.options.length,
      remaining: fc.queue.length,
    });
    await sendText(jid, T.mealFoodClarify(next.item.food, next.options), {
      userId: user.id,
      category: "meal_food_clarify",
    });
    return;
  }

  // Cola vacía → persistir y mostrar resumen
  clearSession(jid);

  const items = fc.resolved;
  const totals = items.reduce(
    (a, it) => ({
      kcal: a.kcal + it.kcal,
      protein: a.protein + it.protein_g,
      carbs: a.carbs + it.carbs_g,
      fat: a.fat + it.fat_g,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  );

  await persistMeal(user, fc.raw_input, {
    items,
    totals,
    is_estimate: fc.is_estimate,
    confidence: 0.9,
    source: "quick",
  });
  logBotEvent(user.id, EventTypes.MEAL_LOGGED, {
    source: "quick",
    via_food_clarify: true,
    is_estimate: fc.is_estimate,
    kcal: totals.kcal,
    protein_g: totals.protein,
    carbs_g: totals.carbs,
    fat_g: totals.fat,
    item_count: items.length,
  });
  await sendMealResult(user, T.mealRegistered(items, totals, fc.is_estimate));
}
