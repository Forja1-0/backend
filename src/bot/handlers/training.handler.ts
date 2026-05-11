import type { User } from "../../types/user.types.js";
import * as trainingRepo from "../../repositories/training.repo.js";
import { getSession, setSession, clearSession } from "../session.store.js";
import { sendText } from "../../services/evolution.service.js";
import { logger } from "../../config/logger.js";

/**
 * Detecta si el mensaje es un comando "complete" / "listo" / "hice".
 * Retorna true si debe manejar este mensaje.
 */
export function isCompleteCommand(text: string): boolean {
  return /^(complet[eé]|listo|hice|terminé|termine|entrenam|lo hice)/i.test(
    text.trim(),
  );
}

/**
 * Maneja el comando "complete [sesión]" del usuario.
 * Paso 1: Registra el training_log y pide RPE.
 */
export async function handleComplete(user: User, text: string): Promise<void> {
  const jid = user.wa_chat_id!;

  // Intentamos detectar el plan de hoy automáticamente
  const todayPlan = await trainingRepo.getTodayPlan(user.id, user.timezone);

  // Si el texto incluye un nombre de sesión explícito, lo usamos; si no, el plan del día
  const sessionName =
    extractSessionName(text) ??
    todayPlan?.session_name ??
    todayPlan?.session_type ??
    "Entrenamiento";

  const log = await trainingRepo.logTrainingComplete(
    user,
    sessionName,
    todayPlan?.id,
  );

  // Guardamos sesión esperando RPE
  setSession(jid, { flow: "rpe_capture", training_log_id: log.id });

  await sendText(
    jid,
    `🔥 *${sessionName}* registrado como completado!\n\n¿Cómo fue el esfuerzo? Mandame un número del *1 al 10*\n_(1 = muy fácil · 10 = al límite)_`,
  );
}

/**
 * Maneja la respuesta de RPE (número 1-10).
 * Solo se llama cuando hay una sesión activa de tipo "rpe_capture".
 */
export async function handleRpeResponse(
  user: User,
  text: string,
): Promise<void> {
  const jid = user.wa_chat_id!;
  const session = getSession(jid);
  if (!session || session.flow !== "rpe_capture") return;

  const rpe = parseInt(text.trim(), 10);
  if (isNaN(rpe) || rpe < 1 || rpe > 10) {
    await sendText(
      jid,
      `Mandame un número entre *1 y 10* para el esfuerzo percibido 💪`,
    );
    return;
  }

  await trainingRepo.setRpe(session.training_log_id, rpe);
  clearSession(jid);

  const emoji = rpe >= 8 ? "🔴" : rpe >= 5 ? "🟡" : "🟢";
  await sendText(
    jid,
    `${emoji} RPE *${rpe}/10* guardado. ¡Gran trabajo hoy! 💪\n\nEsta noche te voy a preguntar cómo fue el día completo.`,
  );
}

/** Extrae nombre de sesión del texto: "completé piernas" → "piernas" */
function extractSessionName(text: string): string | null {
  const match = text
    .trim()
    .match(
      /^(?:complet[eé]|listo|hice|terminé|termine|lo hice)\s+(.+)/i,
    );
  return match?.[1]?.trim() ?? null;
}
