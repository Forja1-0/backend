import { logger } from "../config/logger.js";
import * as weightRepo from "../repositories/weight.repo.js";
import { startWeightCapture } from "../bot/handlers/weight.handler.js";
import { logBotEvent, EventTypes } from "../services/events.service.js";

/**
 * Pedido semanal de peso (modo amateur). Le pregunta el peso a los usuarios
 * con meta de peso que no se pesaron en los últimos 5 días, y deja la sesión
 * en flow=weight_capture para interpretar la respuesta.
 *
 * Programado: domingos 10:00 ART.
 */
export async function runWeightAsk(): Promise<void> {
  logger.info("cron weight ask: starting");
  logBotEvent(null, EventTypes.CRON_WEIGHT_TICK, {});

  let users: Awaited<ReturnType<typeof weightRepo.getWeightAskCandidates>>;
  try {
    users = await weightRepo.getWeightAskCandidates();
  } catch (err) {
    logger.error("cron weight ask: failed to fetch users", { err });
    logBotEvent(null, "cron.weight_query_failed", { error: String(err) });
    return;
  }

  logger.info("cron weight ask: pending users", { count: users.length });

  for (const u of users) {
    try {
      await startWeightCapture(u);
      logBotEvent(u.id, EventTypes.CRON_WEIGHT_ASK_SENT, {});
    } catch (err) {
      logger.error("cron weight ask: send failed", { err, userId: u.id });
      logBotEvent(u.id, "cron.weight_ask_failed", { error: String(err) });
    }
  }

  logger.info("cron weight ask: done");
}
