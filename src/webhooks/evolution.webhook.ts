import { Router } from "express";
import { logger } from "../config/logger.js";
import type { EvolutionWebhookEvent } from "../types/evolution.types.js";
import { extractText } from "../types/evolution.types.js";
import { isGroupJid } from "../utils/phone.js";
import { linkOrCreateByJid } from "../repositories/user.repo.js";
import { sendText } from "../services/evolution.service.js";

export const evolutionWebhook = Router();

evolutionWebhook.post("/evolution", async (req, res) => {
  // Responder rapido para que Evolution no reintente.
  res.status(200).json({ ok: true });

  try {
    const payload = req.body as EvolutionWebhookEvent;
    const event = payload?.event;
    const msg = payload?.data;

    if (event !== "messages.upsert" || !msg?.key) return;
    if (msg.key.fromMe) return; // ignorar nuestros propios mensajes
    if (isGroupJid(msg.key.remoteJid)) return; // por ahora ignorar grupos

    const text = extractText(msg);
    const jid = msg.key.remoteJid;

    logger.info(
      "wa incoming",
      { jid, pushName: msg.pushName, type: msg.messageType, text },
    );

    const user = await linkOrCreateByJid(jid, msg.pushName);

    // ECHO de prueba — reemplazar por router de bot en paso 4.
    const reply = text
      ? `Te escuché, ${user.name ?? "che"}: "${text}"`
      : `Recibí un mensaje (${msg.messageType ?? "desconocido"}) pero todavía no proceso ese tipo.`;

    await sendText(jid, reply);
  } catch (err) {
    logger.error("webhook handler failed", { err });
  }
});
