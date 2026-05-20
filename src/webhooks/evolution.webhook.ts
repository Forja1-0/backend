import { Router } from "express";
import { logger } from "../config/logger.js";
import type { EvolutionWebhookEvent } from "../types/evolution.types.js";
import { extractText } from "../types/evolution.types.js";
import { isGroupJid } from "../utils/phone.js";
import { linkOrCreateByJid } from "../repositories/user.repo.js";
import { routeMessage } from "../bot/router.js";
import { logBotEvent, EventTypes } from "../services/events.service.js";

export const evolutionWebhook = Router();

evolutionWebhook.post("/evolution", async (req, res) => {
  // Responder rapido para que Evolution no reintente.
  res.status(200).json({ ok: true });

  try {
    const payload = req.body as EvolutionWebhookEvent;
    const event = payload?.event;
    const msg = payload?.data;

    // Todo webhook entra al log, aun los que ignoramos. Sirve para detectar
    // spikes de grupo / messages.update / typing / etc.
    logBotEvent(null, EventTypes.WA_WEBHOOK_RECEIVED, {
      event,
      from_me: msg?.key?.fromMe ?? null,
      remote_jid: msg?.key?.remoteJid ?? null,
      message_type: msg?.messageType ?? null,
    });

    if (event !== "messages.upsert" || !msg?.key) {
      logBotEvent(null, EventTypes.WA_MESSAGE_IGNORED, { reason: "non_upsert", event });
      return;
    }
    if (msg.key.fromMe) {
      logBotEvent(null, EventTypes.WA_MESSAGE_IGNORED, { reason: "from_me" });
      return;
    }
    if (isGroupJid(msg.key.remoteJid)) {
      logBotEvent(null, EventTypes.WA_MESSAGE_IGNORED, {
        reason: "group",
        jid: msg.key.remoteJid,
      });
      return;
    }

    const text = extractText(msg);
    const jid = msg.key.remoteJid;

    logger.info(
      "wa incoming",
      { jid, pushName: msg.pushName, type: msg.messageType, text },
    );

    const user = await linkOrCreateByJid(jid, msg.pushName);

    logBotEvent(user.id, EventTypes.WA_MESSAGE_RECEIVED, {
      jid,
      push_name: msg.pushName ?? null,
      message_type: msg.messageType ?? null,
      has_text: text != null,
      text_length: text?.length ?? 0,
    });

    await routeMessage(user, text);
  } catch (err) {
    logger.error("webhook handler failed", { err });
  }
});

