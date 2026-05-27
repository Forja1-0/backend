import { getSession, setSession, clearSession } from "../session.store.js";
import * as dailyRepo from "../../repositories/daily.repo.js";
import * as onboardingRepo from "../../repositories/onboarding.repo.js";
import { sendText } from "../../services/evolution.service.js";
import { generateNightlySummary } from "../../services/gemini.service.js";
import * as T from "../personality/templates.js";
import { logger } from "../../config/logger.js";
import { logBotEvent, EventTypes } from "../../services/events.service.js";

/** Subset minimo necesario para todos los flujos de checkin. */
export interface CheckinUser {
  id: string;
  name: string | null;
  wa_chat_id: string;
  timezone: string;
}

/**
 * Arranca el checkin nocturno con un usuario.
 * Llamado por el cron 21:00.
 */
export async function startCheckin(user: CheckinUser): Promise<void> {
  setSession(user.wa_chat_id, { flow: "checkin_nutrition", step: 1 });
  logBotEvent(user.id, EventTypes.CHECKIN_STARTED, { jid: user.wa_chat_id });
  await sendText(user.wa_chat_id, T.checkinStart(user.name), {
    userId: user.id,
    category: "checkin_start",
  });
}

/**
 * Procesa respuestas al flujo de checkin (3 pasos).
 * Devuelve true si consumio el mensaje.
 */
export async function handleCheckinResponse(
  user: CheckinUser,
  text: string,
): Promise<boolean> {
  const session = getSession(user.wa_chat_id);
  if (!session) return false;

  const jid = user.wa_chat_id;
  const normalized = text.trim().toLowerCase();

  if (session.flow === "checkin_nutrition") {
    const ok = /^(si|sii|sip|s|yes|y|ok|dale|claro|obvio|joya|confirmo)$/.test(normalized);
    const no = /^(no|nop|nope|para nada|negativo|ni ahi|obvio no)$/.test(normalized);
    if (!ok && !no) {
      logBotEvent(user.id, EventTypes.CHECKIN_VALIDATION_FAIL, { step: "nutrition", raw: normalized });
      await sendText(jid, T.checkinNeedYesNo(), {
        userId: user.id,
        category: "checkin_need_yes_no",
      });
      return true;
    }
    setSession(jid, { flow: "checkin_sleep", step: 2, nutrition_ok: ok });
    logBotEvent(user.id, EventTypes.CHECKIN_STEP, { step: "nutrition", nutrition_ok: ok });
    await sendText(jid, T.checkinAskSleep(ok), {
      userId: user.id,
      category: "checkin_ask_sleep",
    });
    return true;
  }

  if (session.flow === "checkin_sleep") {
    const sleep = parseInt(normalized, 10);
    if (isNaN(sleep) || sleep < 1 || sleep > 5) {
      logBotEvent(user.id, EventTypes.CHECKIN_VALIDATION_FAIL, { step: "sleep", raw: normalized });
      await sendText(jid, T.checkinNeedNumberRange(1, 5), {
        userId: user.id,
        category: "checkin_need_number",
      });
      return true;
    }
    setSession(jid, {
      flow: "checkin_pain",
      step: 3,
      nutrition_ok: session.nutrition_ok,
      sleep,
    });
    logBotEvent(user.id, EventTypes.CHECKIN_STEP, { step: "sleep", sleep });
    await sendText(jid, T.checkinAskPain(), {
      userId: user.id,
      category: "checkin_ask_pain",
    });
    return true;
  }

  if (session.flow === "checkin_pain") {
    const pain = parseInt(normalized, 10);
    if (isNaN(pain) || pain < 0 || pain > 10) {
      logBotEvent(user.id, EventTypes.CHECKIN_VALIDATION_FAIL, { step: "pain", raw: normalized });
      await sendText(jid, T.checkinNeedNumberRange(0, 10), {
        userId: user.id,
        category: "checkin_need_number",
      });
      return true;
    }
    clearSession(jid);

    let summary: Awaited<ReturnType<typeof dailyRepo.upsertDailySummary>>;
    try {
      summary = await dailyRepo.upsertDailySummary(user.id, {
        nutrition_ok: session.nutrition_ok,
        sleep: session.sleep,
        pain,
      });
    } catch (err) {
      logger.error("checkin upsert failed", { err, userId: user.id });
      logBotEvent(user.id, "checkin.upsert_failed", { error: String(err) });
      await sendText(jid, T.checkinFallback(), {
        userId: user.id,
        category: "checkin_fallback",
      });
      return true;
    }

    logBotEvent(user.id, EventTypes.CHECKIN_COMPLETED, {
      nutrition_ok: session.nutrition_ok,
      sleep: session.sleep,
      pain,
      performance_score: summary.performance_score ?? null,
    });

    // Goal activo: pasamos como contexto al prompt para que el cierre
    // empuje hacia la meta del usuario (especialmente en modo amateur).
    let goal: Awaited<ReturnType<typeof onboardingRepo.getActiveGoal>> = null;
    try {
      goal = await onboardingRepo.getActiveGoal(user.id);
    } catch (err) {
      logger.warn("nightly goal lookup failed", { err, userId: user.id });
    }

    // ── Mensaje warm/AI siempre ──────────────────────────────
    try {
      const message = await generateNightlySummary({
        name: user.name,
        nutrition_ok: session.nutrition_ok,
        sleep: session.sleep,
        pain,
        summary,
        goal,
      });
      await sendText(jid, message, {
        userId: user.id,
        category: "checkin_summary_ai",
      });
    } catch (err) {
      logger.error("nightly summary AI failed", { err, userId: user.id });
      logBotEvent(user.id, "checkin.ai_summary_failed", { error: String(err) });
      await sendText(jid, T.checkinFallback(), {
        userId: user.id,
        category: "checkin_fallback",
      });
    }
    return true;
  }

  return false;
}
