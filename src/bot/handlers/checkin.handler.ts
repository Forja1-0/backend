import { getSession, setSession, clearSession } from "../session.store.js";
import * as dailyRepo from "../../repositories/daily.repo.js";
import { sendText } from "../../services/evolution.service.js";
import { generateNightlySummary } from "../../services/gemini.service.js";
import * as T from "../personality/templates.js";
import { logger } from "../../config/logger.js";

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
  await sendText(user.wa_chat_id, T.checkinStart(user.name));
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
      await sendText(jid, T.checkinNeedYesNo());
      return true;
    }
    setSession(jid, { flow: "checkin_sleep", step: 2, nutrition_ok: ok });
    await sendText(jid, T.checkinAskSleep(ok));
    return true;
  }

  if (session.flow === "checkin_sleep") {
    const sleep = parseInt(normalized, 10);
    if (isNaN(sleep) || sleep < 1 || sleep > 5) {
      await sendText(jid, T.checkinNeedNumberRange(1, 5));
      return true;
    }
    setSession(jid, {
      flow: "checkin_pain",
      step: 3,
      nutrition_ok: session.nutrition_ok,
      sleep,
    });
    await sendText(jid, T.checkinAskPain());
    return true;
  }

  if (session.flow === "checkin_pain") {
    const pain = parseInt(normalized, 10);
    if (isNaN(pain) || pain < 0 || pain > 10) {
      await sendText(jid, T.checkinNeedNumberRange(0, 10));
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
      await sendText(jid, T.checkinFallback());
      return true;
    }

    // ── Mensaje warm/AI siempre ──────────────────────────────
    try {
      const message = await generateNightlySummary({
        name: user.name,
        nutrition_ok: session.nutrition_ok,
        sleep: session.sleep,
        pain,
        summary,
      });
      await sendText(jid, message);
    } catch (err) {
      logger.error("nightly summary AI failed", { err, userId: user.id });
      await sendText(jid, T.checkinFallback());
    }
    return true;
  }

  return false;
}
