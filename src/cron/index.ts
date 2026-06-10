import cron from "node-cron";
import { logger } from "../config/logger.js";
import { runMorningReminder } from "./morning.cron.js";
import { runNightCheckin } from "./night.cron.js";
import { scheduleRemindersCron } from "./reminders.cron.js";
import { runWeightAsk } from "./weight.cron.js";
import { env } from "../config/env.js";

/**
 * Registra todos los cron jobs de la aplicación.
 * Se llama una sola vez desde server.ts al arrancar.
 *
 * Todos los horarios son en la timezone de Argentina.
 */
export function registerCronJobs(): void {
  if (env.NODE_ENV === "test") {
    logger.info("cron: skipped in test env");
    return;
  }

  // Recordatorio matutino: lunes a sábado a las 06:00
  // Cron: "0 6 * * 1-6"
  cron.schedule(
    "0 6 * * 1-6",
    () => {
      runMorningReminder().catch((err) =>
        logger.error("cron morning uncaught", { err }),
      );
    },
    { timezone: "America/Argentina/Buenos_Aires" },
  );

  // Check-in nocturno: todos los días a las 21:00
  // Cron: "0 21 * * *"
  cron.schedule(
    "0 21 * * *",
    () => {
      runNightCheckin().catch((err) =>
        logger.error("cron night uncaught", { err }),
      );
    },
    { timezone: "America/Argentina/Buenos_Aires" },
  );

  // Pedido semanal de peso (amateur): domingos 10:00.
  // Cron: "0 10 * * 0"
  cron.schedule(
    "0 10 * * 0",
    () => {
      runWeightAsk().catch((err) =>
        logger.error("cron weight ask uncaught", { err }),
      );
    },
    { timezone: "America/Argentina/Buenos_Aires" },
  );

  // Recordatorios configurables del usuario (modo amateur principalmente,
  // pero quedan habilitados en elite tambien — son opt-in via DB).
  scheduleRemindersCron();

  logger.info("cron: jobs registered (morning 06:00, night 21:00, weight Sun 10:00, reminders */1 ART)");
}
