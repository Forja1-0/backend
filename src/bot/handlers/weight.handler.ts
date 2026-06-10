import type { User } from "../../types/user.types.js";
import { parseWeightKg } from "../parser/weight-parse.js";
import * as weightRepo from "../../repositories/weight.repo.js";
import { recomputeAutoTargetSafe } from "../../services/nutrition-target.service.js";
import { sendText } from "../../services/evolution.service.js";
import { clearSession, setSession } from "../session.store.js";
import * as T from "../personality/templates.js";
import { logger } from "../../config/logger.js";
import { logBotEvent, EventTypes } from "../../services/events.service.js";

/**
 * Registra un peso reportado libremente ("peso 82", "me pesé 79.5").
 * Guarda en weight_logs, sincroniza users.weight_kg, recalcula el target
 * estimado (no-op si el user tiene plan manual) y responde con la tendencia.
 */
export async function handleWeightLog(user: User, rawText: string): Promise<void> {
  const jid = user.wa_chat_id!;
  const kg = parseWeightKg(rawText);
  if (kg == null) {
    logBotEvent(user.id, EventTypes.WEIGHT_INVALID, { raw: rawText.slice(0, 40) });
    await sendText(jid, T.weightNeedNumber(), { userId: user.id, category: "weight_need_number" });
    return;
  }
  await persistWeight(user, kg);
}

/**
 * Respuesta del usuario a la pregunta semanal del cron (flow weight_capture).
 * Si el número no se entiende, mantiene la sesión y re-pregunta.
 */
export async function handleWeightCapture(user: User, rawText: string): Promise<void> {
  const jid = user.wa_chat_id!;
  const kg = parseWeightKg(rawText);
  if (kg == null) {
    logBotEvent(user.id, EventTypes.WEIGHT_INVALID, { raw: rawText.slice(0, 40), in_capture: true });
    // No limpiamos la sesión: el próximo número se interpreta como peso.
    await sendText(jid, T.weightNeedNumber(), { userId: user.id, category: "weight_need_number" });
    return;
  }
  clearSession(jid);
  await persistWeight(user, kg);
}

async function persistWeight(user: User, kg: number): Promise<void> {
  const jid = user.wa_chat_id!;
  try {
    await weightRepo.saveWeight(user.id, kg, "whatsapp");
  } catch (err) {
    logger.error("saveWeight failed", { err, userId: user.id, kg });
    await sendText(jid, "Uf, no pude guardar el peso ahora. Probá de nuevo en un toque.", {
      userId: user.id,
      category: "weight_save_failed",
    });
    return;
  }

  // El peso cambió → recalcular el target estimado (no-op si plan manual).
  // Best-effort: el peso ya quedó guardado pase lo que pase.
  await recomputeAutoTargetSafe(user.id);

  let trend: Awaited<ReturnType<typeof weightRepo.getWeightTrend>> = null;
  try {
    trend = await weightRepo.getWeightTrend(user.id);
  } catch (err) {
    logger.warn("getWeightTrend failed", { err, userId: user.id });
  }

  logBotEvent(user.id, EventTypes.WEIGHT_LOGGED, {
    kg,
    count: trend?.count ?? null,
    delta_from_first: trend?.deltaFromFirst ?? null,
  });

  const message = trend
    ? T.weightRegistered(kg, trend)
    : `Anotado: *${kg} kg*. 💪`;
  await sendText(jid, message, { userId: user.id, category: "weight_registered" });
}

/** Arranca la captura semanal de peso (la dispara el cron). */
export async function startWeightCapture(user: {
  id: string;
  name: string | null;
  wa_chat_id: string;
}): Promise<void> {
  setSession(user.wa_chat_id, { flow: "weight_capture" });
  await sendText(user.wa_chat_id, T.weightAsk(user.name), {
    userId: user.id,
    category: "weight_ask",
  });
}
