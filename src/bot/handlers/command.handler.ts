import type { User } from "../../types/user.types.js";
import { query } from "../../config/db.js";
import { sendText } from "../../services/evolution.service.js";
import { setSession, clearSession, getSession } from "../session.store.js";
import * as T from "../personality/templates.js";

export async function handleHelp(user: User): Promise<void> {
  await sendText(user.wa_chat_id!, T.help(user.name));
}

export async function handleProfile(user: User): Promise<void> {
  await sendText(user.wa_chat_id!, T.profile(user));
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
