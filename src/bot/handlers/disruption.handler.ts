import type { User } from "../../types/user.types.js";
import { query } from "../../config/db.js";
import { sendText } from "../../services/evolution.service.js";
import * as T from "../personality/templates.js";
import { logger } from "../../config/logger.js";

type Kind = "desliz" | "illness" | "injury";

/**
 * Registra una disruption en la tabla events. El plan de accion AI es
 * fase Audi — por ahora guardamos description y ack.
 */
async function logEvent(userId: string, kind: Kind, description: string): Promise<void> {
  try {
    await query(
      `INSERT INTO events (user_id, event_type, description) VALUES ($1, $2, $3)`,
      [userId, kind, description.slice(0, 1000)],
    );
  } catch (err) {
    logger.error("disruption log failed", { err, userId, kind });
  }
}

export async function handleInjury(user: User, text: string): Promise<void> {
  await logEvent(user.id, "injury", text);
  await sendText(user.wa_chat_id!, T.disruptionInjuryAck());
}

export async function handleIllness(user: User, text: string): Promise<void> {
  await logEvent(user.id, "illness", text);
  await sendText(user.wa_chat_id!, T.disruptionIllnessAck());
}

export async function handleDesliz(user: User, text: string): Promise<void> {
  await logEvent(user.id, "desliz", text);
  await sendText(user.wa_chat_id!, T.disruptionDeslizAck());
}
