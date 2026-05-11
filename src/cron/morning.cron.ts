import { logger } from "../config/logger.js";
import * as trainingRepo from "../repositories/training.repo.js";
import { sendText } from "../services/evolution.service.js";

/**
 * Recordatorio matutino de entrenamiento.
 * Consulta v_today_training y manda un mensaje a cada usuario activo.
 *
 * Programado: lunes a sábado a las 06:00 (Argentina).
 */
export async function runMorningReminder(): Promise<void> {
  logger.info("cron morning reminder: starting");

  let users: Awaited<ReturnType<typeof trainingRepo.getAllUsersWithTodayTraining>>;
  try {
    users = await trainingRepo.getAllUsersWithTodayTraining();
  } catch (err) {
    logger.error("cron morning reminder: failed to fetch users", { err });
    return;
  }

  logger.info("cron morning reminder: users with training today", {
    count: users.length,
  });

  for (const u of users) {
    try {
      const msg = buildMorningMessage(u);
      await sendText(u.wa_chat_id, msg);
      logger.info("cron morning reminder: sent", {
        userId: u.user_id,
        session: u.session_type,
      });
    } catch (err) {
      logger.error("cron morning reminder: failed to send", {
        err,
        userId: u.user_id,
      });
    }
  }

  logger.info("cron morning reminder: done");
}

function buildMorningMessage(u: {
  name: string | null;
  session_type: string;
  session_name: string | null;
  approx_time: string | null;
  duration_min: number | null;
}): string {
  const name = u.name ? u.name.split(" ")[0] : "atleta";
  const session = u.session_name ?? u.session_type;
  const parts: string[] = [
    `🌅 *Buenos días, ${name}!*\n`,
    `Hoy toca: *${session}*`,
  ];

  if (u.approx_time) {
    // approx_time viene como "HH:MM:SS" de Postgres
    const [hh, mm] = u.approx_time.split(":");
    parts.push(`⏰ Hora: *${hh}:${mm}*`);
  }
  if (u.duration_min) {
    parts.push(`⏱ Duración aprox: *${u.duration_min} min*`);
  }

  parts.push(
    "\nCuando termines, mandame *completé* y registramos la sesión 💪",
  );

  return parts.join("\n");
}
