import type { User } from "../../types/user.types.js";
import { query } from "../../config/db.js";
import { env } from "../../config/env.js";
import { sendText } from "../../services/evolution.service.js";
import { issueWhatsappToken } from "../../services/auth-token.service.js";
import { logEvent } from "../../services/events.service.js";
import { setSession, clearSession, getSession } from "../session.store.js";
import * as T from "../personality/templates.js";

export async function handleHelp(user: User): Promise<void> {
  await sendText(user.wa_chat_id!, T.help(user.name));
}

export async function handleProfile(user: User): Promise<void> {
  // Emite un token corto unico para este user. invalida los previos no
  // usados (issueWhatsappToken lo hace en tx). El link va al web_profile.
  const { token, expiresAt } = await issueWhatsappToken(user.id);
  const link = `${env.WEB_PROFILE_URL.replace(/\/+$/, "")}/login?t=${token}`;

  await logEvent({
    userId: user.id,
    type: "auth.token_issued",
    payload: { source: "wa_command_perfil", expires_at: expiresAt.toISOString() },
  });
  await logEvent({
    userId: user.id,
    type: "wa.command_received",
    payload: { command: "perfil" },
  });

  await sendText(user.wa_chat_id!, T.profile(user, link));
}

export async function handleBaja(user: User): Promise<void> {
  setSession(user.wa_chat_id!, { flow: "baja_confirm" });
  await sendText(user.wa_chat_id!, T.bajaConfirm());
}

/**
 * Confirma o cancela la baja. Solo se llega aca si hay session.flow === "baja_confirm".
 */
export async function handleBajaConfirm(user: User, normalized: string): Promise<void> {
  const jid = user.wa_chat_id!;
  clearSession(jid);
  if (/^(confirmar baja|confirmo|si confirmo|baja confirmada)$/.test(normalized)) {
    await query(`UPDATE users SET active = false WHERE id = $1`, [user.id]);
    await sendText(jid, T.bajaDone());
    return;
  }
  await sendText(jid, "Cancelado. Seguís activo.");
}
