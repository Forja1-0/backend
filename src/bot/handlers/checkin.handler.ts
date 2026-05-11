import type { User } from "../../types/user.types.js";
import { getSession, setSession, clearSession } from "../session.store.js";
import * as dailyRepo from "../../repositories/daily.repo.js";
import { sendText } from "../../services/evolution.service.js";
import { logger } from "../../config/logger.js";

/**
 * Inicia el flujo de check-in nocturno con el usuario.
 * Enviado por el cron de las 21hs.
 */
export async function startCheckin(user: User): Promise<void> {
  const jid = user.wa_chat_id!;
  const name = user.name ? user.name.split(" ")[0] : "che";

  setSession(jid, { flow: "checkin_nutrition", step: 1 });

  await sendText(
    jid,
    `🌙 *Check-in del día, ${name}*\n\n¿Cumpliste con la nutrición hoy? _(respondé *sí* o *no*)_`,
  );
}

/**
 * Maneja las respuestas del flujo de check-in.
 * Retorna true si el mensaje fue consumido por este handler.
 */
export async function handleCheckinResponse(
  user: User,
  text: string,
): Promise<boolean> {
  const jid = user.wa_chat_id!;
  const session = getSession(jid);
  if (!session) return false;
  if (
    session.flow !== "checkin_nutrition" &&
    session.flow !== "checkin_sleep" &&
    session.flow !== "checkin_pain"
  )
    return false;

  const normalized = text.trim().toLowerCase();

  // PASO 1: ¿Nutrición ok?
  if (session.flow === "checkin_nutrition") {
    const ok = /^(si|sí|s|yes|y|ok|dale)$/.test(normalized);
    const no = /^(no|nop|nope|para nada)$/.test(normalized);

    if (!ok && !no) {
      await sendText(jid, `Respondé *sí* o *no* 😊`);
      return true;
    }

    setSession(jid, { flow: "checkin_sleep", step: 2, nutrition_ok: ok });
    await sendText(
      jid,
      `${ok ? "✅ Piola!" : "😅 No pasa nada, mañana es otro día."}\n\n¿Cómo dormiste anoche? Ponele un número del *1 al 5*\n_(1 = muy mal · 5 = perfecto)_`,
    );
    return true;
  }

  // PASO 2: Calidad de sueño
  if (session.flow === "checkin_sleep") {
    const sleep = parseInt(normalized, 10);
    if (isNaN(sleep) || sleep < 1 || sleep > 5) {
      await sendText(jid, `Mandame un número del *1 al 5* para el sueño 😴`);
      return true;
    }

    setSession(jid, {
      flow: "checkin_pain",
      step: 3,
      nutrition_ok: session.nutrition_ok,
      sleep,
    });
    await sendText(
      jid,
      `${getSleepEmoji(sleep)}\n\n¿Tenés algún dolor o molestia física hoy?\nPonele un número del *0 al 10* _(0 = sin dolor · 10 = muy fuerte)_`,
    );
    return true;
  }

  // PASO 3: Dolor / molestia
  if (session.flow === "checkin_pain") {
    const pain = parseInt(normalized, 10);
    if (isNaN(pain) || pain < 0 || pain > 10) {
      await sendText(jid, `Mandame un número del *0 al 10* para el dolor 🤕`);
      return true;
    }

    clearSession(jid);

    // Guardamos el daily_summary
    try {
      await dailyRepo.upsertDailySummary(user.id, {
        nutrition_ok: session.nutrition_ok,
        sleep: session.sleep,
        pain,
      });
    } catch (err) {
      logger.error("checkin upsert failed", { err, userId: user.id });
    }

    const summary = buildSummaryMessage(session.nutrition_ok, session.sleep, pain);
    await sendText(jid, summary);
    return true;
  }

  return false;
}

function getSleepEmoji(sleep: number): string {
  if (sleep >= 4) return "😴 Bien descansado!";
  if (sleep >= 3) return "🥱 Regular, tratá de descansar más.";
  return "😵 Mal sueño. Priorizá el descanso, es parte del entrenamiento.";
}

function buildSummaryMessage(
  nutritionOk: boolean,
  sleep: number,
  pain: number,
): string {
  const lines = ["✅ *Check-in guardado!*\n"];
  lines.push(`🥗 Nutrición: ${nutritionOk ? "cumplida" : "no cumplida"}`);
  lines.push(`😴 Sueño: ${sleep}/5`);
  lines.push(`💊 Dolor/molestia: ${pain}/10`);

  if (pain >= 7) {
    lines.push(
      "\n⚠️ Tenés un nivel de dolor alto. Si persiste, consultá con tu médico o kinesiólogo.",
    );
  } else if (pain >= 4) {
    lines.push("\n💡 Hay algo de molestia. Chequealo con tu coach.");
  }

  lines.push("\n¡Hasta mañana! 💪");
  return lines.join("\n");
}
