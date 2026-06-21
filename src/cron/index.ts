import cron from "node-cron";
import { logger } from "../config/logger.js";
import { runMorningReminder } from "./morning.cron.js";
import { runNightCheckin } from "./night.cron.js";
import { scheduleRemindersCron } from "./reminders.cron.js";
import { runWeightAsk } from "./weight.cron.js";
import { runMotivationTick, planMotivationWeek } from "./motivation.cron.js";
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

  // Registro nocturno del día: todos los días a las 22:30.
  // NO es un "cierre" que bloquee el día — el día sigue siendo el día
  // calendario (00:00–23:59) y se puede seguir cargando comidas/entrenos
  // después de esta hora (van a CURRENT_DATE igual). Es solo el prompt de
  // registro diario.
  // Cron: "30 22 * * *"
  cron.schedule(
    "30 22 * * *",
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

  // Motor de motivación (amateur): mensajes espontáneos con frecuencia dinámica.
  // Tick cada 5 min dispara los nudges vencidos; el planificador semanal (lunes
  // 00:30) tira el dado de cuántos mensajes manda esa semana. Bootstrap al boot
  // para que un deploy nuevo planee la semana en curso de una.
  if (env.FORJA_MODE === "amateur") {
    cron.schedule(
      "*/5 * * * *",
      () => {
        runMotivationTick().catch((err) =>
          logger.error("cron motivation tick uncaught", { err }),
        );
      },
      { timezone: "America/Argentina/Buenos_Aires" },
    );
    cron.schedule(
      "30 0 * * 1",
      () => {
        planMotivationWeek().catch((err) =>
          logger.error("cron motivation planner uncaught", { err }),
        );
      },
      { timezone: "America/Argentina/Buenos_Aires" },
    );
    // Bootstrap diferido (no bloquea el boot).
    setTimeout(() => {
      planMotivationWeek().catch((err) =>
        logger.error("motivation planner bootstrap failed", { err }),
      );
    }, 10_000);
    logger.info("cron: motivation engine registered (tick */5, planner Mon 00:30 ART)");
  }

  logger.info("cron: jobs registered (morning 06:00, night 22:30, weight Sun 10:00, reminders */1 ART)");
}
