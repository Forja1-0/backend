import type { User } from "../types/user.types.js";
import { getSession } from "./session.store.js";
import { sendText } from "../services/evolution.service.js";
import {
  isCompleteCommand,
  handleComplete,
  handleRpeResponse,
} from "./handlers/training.handler.js";
import { handleCheckinResponse } from "./handlers/checkin.handler.js";
import { handleMealLog } from "./handlers/meal.handler.js";
import { logger } from "../config/logger.js";

/**
 * Router principal del bot.
 * Recibe el usuario y el texto del mensaje, y delega al handler correcto.
 *
 * Orden de prioridad:
 * 1. Sesión activa (conversación multi-paso en curso)
 * 2. Comandos explícitos
 * 3. Fallback / ayuda
 */
export async function routeMessage(user: User, text: string | null): Promise<void> {
  const jid = user.wa_chat_id!;

  if (!text) {
    // Mensaje no textual (audio, imagen, sticker, etc.)
    await sendText(
      jid,
      `Solo proceso mensajes de texto por ahora 😅\n\nEscribí *ayuda* para ver qué puedo hacer.`,
    );
    return;
  }

  const session = getSession(jid);

  // ── 1. Sesión activa ──────────────────────────────────────────────────
  if (session) {
    if (session.flow === "rpe_capture") {
      await handleRpeResponse(user, text);
      return;
    }
    if (
      session.flow === "checkin_nutrition" ||
      session.flow === "checkin_sleep" ||
      session.flow === "checkin_pain"
    ) {
      await handleCheckinResponse(user, text);
      return;
    }
  }

  // ── 2. Comandos explícitos ────────────────────────────────────────────
  const lower = text.trim().toLowerCase();

  // "completé", "listo", "hice X", "terminé", etc.
  if (isCompleteCommand(text)) {
    await handleComplete(user, text);
    return;
  }

  // Ayuda
  if (/^(ayuda|help|\?)$/.test(lower)) {
    await sendHelp(jid, user.name);
    return;
  }

  // Saludo
  if (/^(hola|buenas|hey|hi|buen día|buendia|buen dia)/.test(lower)) {
    const name = user.name ? user.name.split(" ")[0] : "atleta";
    await sendText(jid, `¡Hola ${name}! 👋 Escribí *ayuda* para ver qué puedo hacer.`);
    return;
  }

  // ── 3. Comidas (fallback inteligente con Gemini) ─────────────────────
  // Si no es un comando explícito, intentamos parsearlo como comida.
  if (text.length > 5) {
    const isMeal = await handleMealLog(user, text);
    if (isMeal) return;
  }

  // ── 4. Fallback genérico ──────────────────────────────────────────────
  logger.info("unhandled bot message", { jid, text: text.slice(0, 100) });
  await sendText(
    jid,
    `No entendí ese mensaje 🤔\n\nEscribí *ayuda* para ver los comandos disponibles.`,
  );
}

async function sendHelp(jid: string, name: string | null): Promise<void> {
  const n = name ? name.split(" ")[0] : "atleta";
  await sendText(
    jid,
    `*Comandos disponibles, ${n}:*\n\n` +
      `✅ *completé* / *listo* — Registrar entrenamiento completado\n` +
      `   _Ej: "completé piernas", "listo", "terminé"_\n\n` +
      `🥗 *Registro de comidas* — Escribí lo que comiste y yo me encargo\n` +
      `   _Ej: "Me comí 200g de pollo con arroz", "desayuné 2 huevos"_\n`,
  );
}
