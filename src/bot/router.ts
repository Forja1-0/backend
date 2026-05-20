import type { User } from "../types/user.types.js";
import { getSession } from "./session.store.js";
import { classify, type Intent } from "./parser/intent-classifier.js";
import { matchTraining } from "./parser/training-matcher.js";
import { logger } from "../config/logger.js";
import { sendText } from "../services/evolution.service.js";
import { logBotEvent, EventTypes } from "../services/events.service.js";
import { parseUserMessage } from "../services/gemini.service.js";
import type { AiNluEntities } from "../schemas/bot.schema.js";
import { normalize } from "./parser/normalize.js";

import { handleComplete, handleRpeResponse, handleSkip, handleQuery as handleTrainingQuery } from "./handlers/training.handler.js";
import { handleCheckinResponse } from "./handlers/checkin.handler.js";
import { handleMealLog, handleMealConfirm, handleMealClarify, handleMealStateClarify, handleMealFoodClarify } from "./handlers/meal.handler.js";
import { handleNutritionQuery, handleProgressQuery } from "./handlers/query.handler.js";
import { handleHelp, handleProfile, handleBaja, handleBajaConfirm } from "./handlers/command.handler.js";
import { handleInjury, handleIllness, handleDesliz } from "./handlers/disruption.handler.js";
import { handleGreeting, handleGratitude, handleUnknown, handleNonText } from "./handlers/greeting.handler.js";

/**
 * Dispatcher principal del bot.
 *
 * Orden de decision:
 *   1. SESION ACTIVA — el router despacha directo al handler de esa sesion.
 *      Esto cubre flujos multi-paso (RPE, checkin, confirmacion de comida).
 *   2. CLASSIFY — clasificador sync (regex + keywords + fuzzy).
 *      Si confidence >= 0.7 → dispatch directo. Sin AI.
 *   3. NLU ADAPTER (Gemini) — solo si confidence local < 0.7. Devuelve
 *      intent canonico + standardized_text + entities. Si resuelve con
 *      intent != unknown, se despacha con ESE intent (no el local).
 *   4. TRAINING MATCHER — si el NLU no resolvio, intentamos cazar
 *      ejercicios del plan del user contra el texto normalizado local.
 *   5. MEAL FALLBACK — el caso mas frecuente que pasa por aca.
 */
export async function routeMessage(user: User, rawText: string | null): Promise<void> {
  const jid = user.wa_chat_id!;

  if (!rawText) {
    await handleNonText(user);
    return;
  }

  const session = getSession(jid);

  // ── 1. SESION ACTIVA ──────────────────────────────────────
  if (session) {
    logBotEvent(user.id, "wa.session_dispatch", {
      jid,
      flow: session.flow,
    });
    if (await dispatchSession(user, rawText, session)) return;
    // Si el handler de sesion no consumio el mensaje, caemos al classifier.
  }

  // ── 2. CLASSIFY ──────────────────────────────────────────
  const c = classify(rawText);
  logger.debug("classified", { jid, intent: c.intent, confidence: c.confidence, normalized: c.normalized });
  logBotEvent(user.id, EventTypes.WA_INTENT_CLASSIFIED, {
    jid,
    intent: c.intent,
    confidence: c.confidence,
    token_count: c.tokens.length,
    has_active_session: session != null,
  });

  // Confianza alta: dispatch directo.
  if (c.confidence >= 0.7) {
    await dispatchByIntent(user, rawText, c.normalized, c.intent);
    return;
  }

  // ── 3. NLU ADAPTER (AI) — solo cuando el classifier local quedo dudoso.
  //      Si Gemini resuelve con intent != unknown, lo usamos. Si devuelve
  //      null o unknown, caemos al pipeline legacy (training matcher + meal).
  const nlu = await parseUserMessage(rawText, user.id);
  if (nlu && nlu.intent !== "unknown") {
    logBotEvent(user.id, "wa.nlu_classified", {
      jid,
      nlu_intent: nlu.intent,
      local_intent: c.intent,
      local_confidence: c.confidence,
      has_entities: Object.values(nlu.entities ?? {}).some((v) => v != null),
    });
    // Para meal_log: si el NLU extrajo raw_food_input limpio, lo usamos como
    // input al meal-parser. Reemplaza el normalize() local porque el NLU
    // ya corrigio typos/abreviaciones que el normalize regex no toca.
    const dispatchNormalized =
      nlu.intent === "meal_log" && nlu.entities?.raw_food_input
        ? normalize(nlu.entities.raw_food_input)
        : nlu.standardized_text;
    await dispatchByIntent(
      user,
      rawText,
      dispatchNormalized,
      nlu.intent as Intent,
      nlu.entities,
    );
    return;
  }

  // ── 4. MATCHER DE TRAINING — busca en el plan del user si hay
  //      "hice/termine X" donde X es un ejercicio/sesion del plan
  //      que el classifier no conoce ("hice pecfly"). ─────────────────
  if (HAS_COMPLETION_VERB.test(c.normalized)) {
    const todayDow = todayDowFor(user.timezone);
    const match = await matchTraining(user.id, c.normalized, todayDow);
    if (match) {
      logger.debug("training matcher hit on weak intent", { jid, match });
      await dispatchByIntent(user, rawText, c.normalized, "training_complete");
      return;
    }
  }

  // ── 5. CONFIANZA MEDIA — intentamos meal (caso mas frecuente
  //                         que pasa por AI fallback) ──────────────────
  if (c.intent === "meal_log" || (c.intent === "unknown" && c.tokens.length >= 3)) {
    const handled = await handleMealLog(user, rawText, c.normalized);
    if (handled) return;
  }

  // ── 6. FALLBACK ──────────────────────────────────────────
  await handleUnknown(user);
}

const HAS_COMPLETION_VERB = /\b(hice|hicimos|termine|terminamos|complete|completamos|cumpli|finalice|acabe|listo)\b/;

function todayDowFor(timezone: string | null | undefined): number {
  const tz = timezone || "America/Argentina/Buenos_Aires";
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date());
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? new Date().getDay();
}

async function dispatchSession(
  user: User,
  rawText: string,
  session: NonNullable<ReturnType<typeof getSession>>,
): Promise<boolean> {
  switch (session.flow) {
    case "rpe_capture":
      await handleRpeResponse(user, rawText);
      return true;
    case "checkin_nutrition":
    case "checkin_sleep":
    case "checkin_pain":
      return await handleCheckinResponse(
        {
          id: user.id,
          name: user.name,
          wa_chat_id: user.wa_chat_id!,
          timezone: user.timezone,
        },
        rawText,
      );
    case "meal_clarify":
      await handleMealClarify(user, rawText, session);
      return true;
    case "meal_state_clarify":
      await handleMealStateClarify(user, rawText, session);
      return true;
    case "meal_food_clarify":
      await handleMealFoodClarify(user, rawText, session);
      return true;
    case "meal_confirm": {
      const c = classify(rawText);
      const decision: "confirm" | "cancel" =
        c.intent === "affirmation" ? "confirm" :
        c.intent === "negation" || c.intent === "correction" ? "cancel" :
        "cancel"; // ambiguo → seguridad
      await handleMealConfirm(user, decision, session.meal);
      return true;
    }
    case "baja_confirm":
      await handleBajaConfirm(user, classify(rawText).normalized);
      return true;
  }
}

async function dispatchByIntent(
  user: User,
  rawText: string,
  normalized: string,
  intent: Intent,
  // Solo se setea cuando el dispatch viene del NLU adapter (rama 3 del router).
  // Los handlers que se benefician (training_complete, meal_log, disruptions,
  // numeric, nutrition_query) las consumen; el resto las ignora.
  _entities?: AiNluEntities,
): Promise<void> {
  switch (intent) {
    case "command_help":   return handleHelp(user);
    case "command_perfil": return handleProfile(user);
    case "command_baja":   return handleBaja(user);

    case "greeting":       return handleGreeting(user);
    case "gratitude":      return handleGratitude(user);
    case "affirmation":
    case "negation":
    case "numeric":
      // Sin sesion estos no tienen contexto. Tratamos como unknown educadamente.
      return handleUnknown(user);

    case "training_complete": return handleComplete(user, normalized);
    case "training_skip":     return handleSkip(user);
    case "training_query":    return handleTrainingQuery(user);

    case "nutrition_query":   return handleNutritionQuery(user);
    case "progress_query":    return handleProgressQuery(user);

    case "disruption_injury":  return handleInjury(user, rawText);
    case "disruption_illness": return handleIllness(user, rawText);
    case "disruption_desliz":  return handleDesliz(user, rawText);

    case "meal_log": {
      const handled = await handleMealLog(user, rawText, normalized);
      if (!handled) await handleUnknown(user);
      return;
    }

    case "correction":
      logBotEvent(user.id, "wa.correction_requested", { jid: user.wa_chat_id });
      await sendText(
        user.wa_chat_id!,
        "Mandame de nuevo la comida con las cantidades correctas y piso la anterior, o decime qué querés cambiar.",
        { userId: user.id, category: "correction_hint" },
      );
      return;

    case "unknown":
    default:
      return handleUnknown(user);
  }
}
