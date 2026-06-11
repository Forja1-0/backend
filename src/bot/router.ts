import type { User } from "../types/user.types.js";
import { getSession } from "./session.store.js";
import { classify, type Intent } from "./parser/intent-classifier.js";
import { matchTraining } from "./parser/training-matcher.js";
import { logger } from "../config/logger.js";
import { sendText } from "../services/evolution.service.js";
import { logBotEvent, EventTypes } from "../services/events.service.js";
import { interpretMessage } from "../services/gemini.service.js";
import type { AiInterpretation } from "../schemas/bot.schema.js";
import { normalize } from "./parser/normalize.js";

import { handleComplete, handleRpeResponse, handleSkip, handleQuery as handleTrainingQuery } from "./handlers/training.handler.js";
import { handleCheckinResponse } from "./handlers/checkin.handler.js";
import { handleMealLog, handleMealConfirm, handleMealClarify, handleMealStateClarify, handleMealFoodClarify, handleMealCorrection } from "./handlers/meal.handler.js";
import { handleWeightLog, handleWeightCapture } from "./handlers/weight.handler.js";
import { handleNutritionQuery, handleProgressQuery } from "./handlers/query.handler.js";
import { handleHelp, handleProfile, handleBaja, handleBajaConfirm } from "./handlers/command.handler.js";
import { handleInjury, handleIllness, handleDesliz } from "./handlers/disruption.handler.js";
import { handleGreeting, handleGratitude, handleUnknown, handleNonText } from "./handlers/greeting.handler.js";

/**
 * Dispatcher principal del bot.
 *
 * Orden de decision (NLU-first):
 *   1. SESION ACTIVA — flujo multi-paso (RPE, checkin, confirmacion).
 *      No tocamos AI, la sesion ya sabe que espera.
 *   2. SLASH COMMANDS exactos — bypass por velocidad (/ayuda, /perfil, /baja).
 *   3. NLU ADAPTER (Gemini) — corre en CADA mensaje. Devuelve intent
 *      canonico + standardized_text + entities. Si NLU resuelve con
 *      intent != unknown, dispatch directo.
 *   4. CLASSIFIER LOCAL (rescate) — solo si NLU fallo (timeout, error,
 *      budget agotado) o devolvio unknown. Aca corre el pipeline legacy
 *      (classify + training matcher + meal fallback).
 *
 * Por que NLU primero: el classifier local tiene falsos positivos confiados
 * (ej: "unos" matchea fuzzy con "puntos" → progress_query con 0.85), que
 * mandan comidas al handler equivocado y desvirtuan el score del user.
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
    // Si el handler de sesion no consumio el mensaje, caemos al pipeline normal.
  }

  // ── 2. SLASH COMMANDS exactos — bypass AI ────────────────
  // Cubre los comandos donde la intencion es 100% inequivoca y no vale
  // la pena gastar tokens ni latencia.
  if (SLASH_COMMAND.test(rawText.trim())) {
    const c = classify(rawText);
    logBotEvent(user.id, EventTypes.WA_INTENT_CLASSIFIED, {
      jid,
      intent: c.intent,
      confidence: c.confidence,
      via: "slash_bypass",
    });
    await dispatchByIntent(user, rawText, c.normalized, c.intent);
    return;
  }

  // ── 3. INTERPRETER (AI) — entra TODO el trafico restante ───
  // Una sola call a Gemini flash-lite. Devuelve intent + (si es meal_log)
  // items estructurados con slug de receta o food simple. El meal-parser
  // hidrata directo, sin tocar mas la AI.
  const nlu = await interpretMessage(rawText, user.id);
  if (nlu && nlu.intent !== "unknown") {
    logBotEvent(user.id, "wa.nlu_classified", {
      jid,
      nlu_intent: nlu.intent,
      item_count: nlu.items.length,
      training_session: nlu.training_session ?? null,
      off_plan: nlu.off_plan ?? null,
    });
    await dispatchByIntent(
      user,
      rawText,
      normalize(rawText),
      nlu.intent as Intent,
      nlu,
    );
    return;
  }

  // ── 4. RESCATE: classifier local ─────────────────────────
  // La AI fallo (timeout / red / budget) o devolvio unknown. Probamos con
  // las reglas locales — peor que adivinar es no responder.
  const c = classify(rawText);
  logger.debug("classified (nlu fallback)", { jid, intent: c.intent, confidence: c.confidence, normalized: c.normalized });
  logBotEvent(user.id, EventTypes.WA_INTENT_CLASSIFIED, {
    jid,
    intent: c.intent,
    confidence: c.confidence,
    token_count: c.tokens.length,
    via: "nlu_fallback",
    nlu_returned: nlu?.intent ?? null,
  });

  if (c.confidence >= 0.7) {
    await dispatchByIntent(user, rawText, c.normalized, c.intent);
    return;
  }

  // ── 5. TRAINING MATCHER — busca en el plan del user si hay
  //      "hice/termine X" donde X es un ejercicio del plan. ──
  if (HAS_COMPLETION_VERB.test(c.normalized)) {
    const todayDow = todayDowFor(user.timezone);
    const match = await matchTraining(user.id, c.normalized, todayDow);
    if (match) {
      logger.debug("training matcher hit on weak intent", { jid, match });
      await dispatchByIntent(user, rawText, c.normalized, "training_complete");
      return;
    }
  }

  // ── 6. MEAL FALLBACK ──────────────────────────────────────
  if (c.intent === "meal_log" || (c.intent === "unknown" && c.tokens.length >= 3)) {
    const handled = await handleMealLog(user, rawText, c.normalized);
    if (handled) return;
  }

  // ── 7. FALLBACK FINAL ────────────────────────────────────
  await handleUnknown(user);
}

const SLASH_COMMAND = /^\/(ayuda|help|menu|perfil|baja|info|datos|start|empezar)$/i;

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
    case "weight_capture":
      await handleWeightCapture(user, rawText);
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
  // Solo se setea cuando el dispatch viene del interpreter (rama 3 del
  // router). meal_log consume items; training_complete consume
  // training_session/off_plan; desliz consume items. El resto lo ignora.
  nlu?: AiInterpretation,
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

    case "weight_log":        return handleWeightLog(user, rawText);

    case "training_complete":
      return handleComplete(
        user,
        normalized,
        nlu
          ? { sessionText: nlu.training_session ?? null, offPlan: nlu.off_plan ?? false }
          : undefined,
      );
    case "training_skip":     return handleSkip(user);
    case "training_query":    return handleTrainingQuery(user);

    case "nutrition_query":   return handleNutritionQuery(user);
    case "progress_query":    return handleProgressQuery(user);

    case "disruption_injury":  return handleInjury(user, rawText);
    case "disruption_illness": return handleIllness(user, rawText);
    case "disruption_desliz":  return handleDesliz(user, rawText, nlu?.items);

    case "meal_log": {
      const handled = await handleMealLog(user, rawText, normalized, nlu?.items);
      if (!handled) await handleUnknown(user);
      return;
    }

    case "correction":
      logBotEvent(user.id, "wa.correction_requested", { jid: user.wa_chat_id });
      await handleMealCorrection(user);
      return;

    case "unknown":
    default:
      return handleUnknown(user);
  }
}
