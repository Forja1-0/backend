import type { User } from "../../types/user.types.js";
import { query } from "../../config/db.js";
import { env } from "../../config/env.js";
import { sendText } from "../../services/evolution.service.js";
import { issueWhatsappToken } from "../../services/auth-token.service.js";
import { logEvent, logBotEvent, EventTypes } from "../../services/events.service.js";
import { setSession, clearSession } from "../session.store.js";
import * as T from "../personality/templates.js";

export async function handleHelp(user: User): Promise<void> {
  logBotEvent(user.id, EventTypes.WA_COMMAND_RECEIVED, { command: "help" });
  await sendText(user.wa_chat_id!, T.help(user.name), {
    userId: user.id,
    category: "command_help",
  });
}

export async function handleProfile(user: User): Promise<void> {
  // Emite un token corto unico para este user. invalida los previos no
  // usados (issueWhatsappToken lo hace en tx). El link va al web_profile.
  const { token, expiresAt } = await issueWhatsappToken(user.id);
  const link = `${env.WEB_PROFILE_URL.replace(/\/+$/, "")}/login?t=${token}`;

  await logEvent({
    userId: user.id,
    type: EventTypes.AUTH_TOKEN_ISSUED,
    payload: { source: "wa_command_perfil", expires_at: expiresAt.toISOString() },
  });
  await logEvent({
    userId: user.id,
    type: EventTypes.WA_COMMAND_RECEIVED,
    payload: { command: "perfil" },
  });

  await sendText(user.wa_chat_id!, T.profile(user, link), {
    userId: user.id,
    category: "command_perfil",
  });
}

export async function handleBaja(user: User): Promise<void> {
  logBotEvent(user.id, EventTypes.BAJA_REQUESTED, { jid: user.wa_chat_id });
  setSession(user.wa_chat_id!, { flow: "baja_confirm" });
  await sendText(user.wa_chat_id!, T.bajaConfirm(), {
    userId: user.id,
    category: "baja_confirm",
  });
}

/**
 * Confirma o cancela la baja. Solo se llega aca si hay session.flow === "baja_confirm".
 */
export async function handleBajaConfirm(user: User, normalized: string): Promise<void> {
  const jid = user.wa_chat_id!;
  clearSession(jid);
  if (/^(confirmar baja|confirmo|si confirmo|baja confirmada)$/.test(normalized)) {
    await query(`UPDATE users SET active = false WHERE id = $1`, [user.id]);
    logBotEvent(user.id, EventTypes.BAJA_CONFIRMED, { jid });
    await sendText(jid, T.bajaDone(), { userId: user.id, category: "baja_done" });
    return;
  }
  logBotEvent(user.id, EventTypes.BAJA_CANCELLED, { jid, normalized });
  await sendText(jid, "Cancelado. Seguís activo.", {
    userId: user.id,
    category: "baja_cancelled",
  });
}
