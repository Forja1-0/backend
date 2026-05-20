import type { User } from "../../types/user.types.js";
import { query } from "../../config/db.js";
import { sendText } from "../../services/evolution.service.js";
import * as T from "../personality/templates.js";
import { logger } from "../../config/logger.js";
import { logBotEvent, EventTypes } from "../../services/events.service.js";

type Kind = "desliz" | "illness" | "injury";

/**
 * Registra una disruption en la tabla legacy `events`. Ademas se appendea
 * un `disruption.logged` en `system_events` para que las queries de BI
 * vean cada disruption sin tener que joinear.
 */
async function persistDisruption(userId: string, kind: Kind, description: string): Promise<void> {
  try {
    await query(
      `INSERT INTO events (user_id, event_type, description) VALUES ($1, $2, $3)`,
      [userId, kind, description.slice(0, 1000)],
    );
  } catch (err) {
    logger.error("disruption log failed", { err, userId, kind });
  }
  logBotEvent(userId, EventTypes.DISRUPTION_LOGGED, {
    kind,
    description_length: description.length,
  });
}

export async function handleInjury(user: User, text: string): Promise<void> {
  await persistDisruption(user.id, "injury", text);
  await sendText(user.wa_chat_id!, T.disruptionInjuryAck(), {
    userId: user.id,
    category: "disruption_injury_ack",
  });
}

export async function handleIllness(user: User, text: string): Promise<void> {
  await persistDisruption(user.id, "illness", text);
  await sendText(user.wa_chat_id!, T.disruptionIllnessAck(), {
    userId: user.id,
    category: "disruption_illness_ack",
  });
}

export async function handleDesliz(user: User, text: string): Promise<void> {
  await persistDisruption(user.id, "desliz", text);
  await sendText(user.wa_chat_id!, T.disruptionDeslizAck(), {
    userId: user.id,
    category: "disruption_desliz_ack",
  });
}
