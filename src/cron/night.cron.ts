import { logger } from "../config/logger.js";
import * as dailyRepo from "../repositories/daily.repo.js";
import { startCheckin } from "../bot/handlers/checkin.handler.js";

/**
 * Check-in nocturno automatizado.
 * Inicia la conversación de 3 preguntas con cada usuario activo.
 *
 * Programado: todos los días a las 21:00 (Argentina).
 */
export async function runNightCheckin(): Promise<void> {
  logger.info("cron night checkin: starting");

  let users: Awaited<ReturnType<typeof dailyRepo.getActiveUsersForCheckin>>;
  try {
    users = await dailyRepo.getActiveUsersForCheckin();
  } catch (err) {
    logger.error("cron night checkin: failed to fetch users", { err });
    return;
  }

  logger.info("cron night checkin: active users", { count: users.length });

  for (const u of users) {
    try {
      // startCheckin espera un User-like, adaptamos
      await startCheckin({
        id: u.id,
        name: u.name,
        wa_chat_id: u.wa_chat_id,
        timezone: u.timezone,
        // Los campos opcionales no son necesarios para el check-in
        age: null,
        sex: null,
        weight_kg: null,
        height_cm: null,
        body_fat_pct: null,
        email: null,
        phone_wa: null,
        active: true,
        onboarding_step: 7,
        created_at: new Date(),
        updated_at: new Date(),
      });
      logger.info("cron night checkin: sent", { userId: u.id });
    } catch (err) {
      logger.error("cron night checkin: failed to send", { err, userId: u.id });
    }
  }

  logger.info("cron night checkin: done");
}
