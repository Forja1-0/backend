import { logger } from "../config/logger.js";
import * as trainingRepo from "../repositories/training.repo.js";
import { setSession } from "../bot/session.store.js";
import { sendText } from "../services/evolution.service.js";
import * as T from "../bot/personality/templates.js";
import { logBotEvent, EventTypes } from "../services/events.service.js";

/**
 * Mensaje de "inicio del día": apenas se levanta el usuario sabe qué le toca
 * hoy y registra cómo durmió. Va a TODOS los usuarios activos (entrenen o no),
 * porque el sueño se carga acá. Tras enviarlo deja abierta la sesión
 * `morning_sleep` para capturar el número 1-10.
 *
 * Programado: todos los días a las 06:00 (Argentina).
 */
export async function runMorningReminder(): Promise<void> {
  logger.info("cron morning reminder: starting");
  logBotEvent(null, EventTypes.CRON_MORNING_TICK, {});

  let users: Awaited<ReturnType<typeof trainingRepo.getActiveUsersForMorning>>;
  try {
    users = await trainingRepo.getActiveUsersForMorning();
  } catch (err) {
    logger.error("cron morning reminder: failed to fetch users", { err });
    logBotEvent(null, "cron.morning_query_failed", { error: String(err) });
    return;
  }

  logger.info("cron morning reminder: active users", { count: users.length });

  for (const u of users) {
    try {
      const msg = buildMorningMessage(u);
      await sendText(u.wa_chat_id, msg, {
        userId: u.user_id,
        category: "morning_reminder",
        extra: { session_type: u.session_type, session_name: u.session_name ?? null },
      });
      // Sesión abierta para capturar la respuesta de sueño (1-10). Best-effort:
      // si el user contesta otra cosa, el handler la suelta (ver checkin.handler).
      setSession(u.wa_chat_id, { flow: "morning_sleep", step: 1 });
      logBotEvent(u.user_id, EventTypes.CRON_MORNING_REMINDER, {
        session_type: u.session_type,
        session_name: u.session_name ?? null,
      });
      logger.info("cron morning reminder: sent", {
        userId: u.user_id,
        session: u.session_type,
      });
    } catch (err) {
      logger.error("cron morning reminder: failed to send", {
        err,
        userId: u.user_id,
      });
      logBotEvent(u.user_id, "cron.morning_reminder_failed", { error: String(err) });
    }
  }

  logger.info("cron morning reminder: done");
}

function buildMorningMessage(u: {
  name: string | null;
  session_type: string | null;
  session_name: string | null;
  approx_time: string | null;
  duration_min: number | null;
}): string {
  const name = u.name ? u.name.split(" ")[0] : "atleta";
  const parts: string[] = [`🌅 *Buenos días, ${name}!*\n`];

  const isRest = !u.session_type || u.session_type === "rest";
  if (isRest) {
    parts.push("Hoy *descansás* — sin sesión pautada. Recuperá bien. 💤");
  } else {
    const session = u.session_name ?? u.session_type;
    parts.push(`Hoy toca: *${session}*`);

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
  }

  // Registro de sueño: va siempre, entrene o descanse.
  parts.push(`\n${T.morningAskSleep()}`);

  return parts.join("\n");
}
