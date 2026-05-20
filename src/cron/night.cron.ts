import { logger } from "../config/logger.js";
import * as dailyRepo from "../repositories/daily.repo.js";
import { startCheckin } from "../bot/handlers/checkin.handler.js";
import { logBotEvent, EventTypes } from "../services/events.service.js";

/**
 * Check-in nocturno. Solo manda a usuarios que NO hayan respondido hoy
 * (la query getCheckinCandidates ya filtra por daily_summaries faltante).
 *
 * Programado: 21:00 ART todos los dias.
 */
export async function runNightCheckin(): Promise<void> {
  logger.info("cron night checkin: starting");
  logBotEvent(null, EventTypes.CRON_NIGHT_TICK, {});

  let users: Awaited<ReturnType<typeof dailyRepo.getCheckinCandidates>>;
  try {
    users = await dailyRepo.getCheckinCandidates();
  } catch (err) {
    logger.error("cron night checkin: failed to fetch users", { err });
    logBotEvent(null, "cron.night_query_failed", { error: String(err) });
    return;
  }

  logger.info("cron night checkin: pending users", { count: users.length });

  for (const u of users) {
    try {
      await startCheckin(u);
      logBotEvent(u.id, EventTypes.CRON_NIGHT_CHECKIN_SENT, {});
      logger.info("cron night checkin: sent", { userId: u.id });
    } catch (err) {
      logger.error("cron night checkin: send failed", { err, userId: u.id });
      logBotEvent(u.id, "cron.night_checkin_failed", { error: String(err) });
    }
  }

  logger.info("cron night checkin: done");
}
