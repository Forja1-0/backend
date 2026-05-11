import { logger } from "../config/logger.js";
import * as dailyRepo from "../repositories/daily.repo.js";
import { startCheckin } from "../bot/handlers/checkin.handler.js";

/**
 * Check-in nocturno. Solo manda a usuarios que NO hayan respondido hoy
 * (la query getCheckinCandidates ya filtra por daily_summaries faltante).
 *
 * Programado: 21:00 ART todos los dias.
 */
export async function runNightCheckin(): Promise<void> {
  logger.info("cron night checkin: starting");

  let users: Awaited<ReturnType<typeof dailyRepo.getCheckinCandidates>>;
  try {
    users = await dailyRepo.getCheckinCandidates();
  } catch (err) {
    logger.error("cron night checkin: failed to fetch users", { err });
    return;
  }

  logger.info("cron night checkin: pending users", { count: users.length });

  for (const u of users) {
    try {
      await startCheckin(u);
      logger.info("cron night checkin: sent", { userId: u.id });
    } catch (err) {
      logger.error("cron night checkin: send failed", { err, userId: u.id });
    }
  }

  logger.info("cron night checkin: done");
}
