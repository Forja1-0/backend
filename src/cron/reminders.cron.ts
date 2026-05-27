import cron from "node-cron";
import * as reminderRepo from "../repositories/reminder.repo.js";
import { sendText } from "../services/evolution.service.js";
import { logger } from "../config/logger.js";
import { logEvent, EventTypes } from "../services/events.service.js";

/**
 * Tick por minuto: evalua todos los recordatorios activos y dispara
 * los que matchean la hora actual.
 *
 * node-cron expone `cron.validate(expr)` pero no un "matchea ahora?".
 * Lo aproximamos con un cron.schedule efimero por cada recordatorio,
 * pero eso es caro. Alternativa simple: parsear minutos+horas+dow
 * manualmente y comparar contra la fecha del tick. Implementamos lo
 * minimo necesario (5-field cron sin steps complejos); los formatos
 * con step (ej cada N minutos) los soportamos via tablas de coincidencia.
 *
 * Si la complejidad sube, conviene migrar a cron-parser. Por ahora
 * mantenemos la dependencia minima.
 */

const TZ = "America/Argentina/Buenos_Aires";

interface Tokens {
  minute: number[]; // 0-59
  hour: number[];   // 0-23
  dom: number[];    // 1-31
  month: number[];  // 1-12
  dow: number[];    // 0-6 (0=domingo)
}

const MINUTE = { min: 0, max: 59 };
const HOUR = { min: 0, max: 23 };
const DOM = { min: 1, max: 31 };
const MONTH = { min: 1, max: 12 };
const DOW = { min: 0, max: 6 };

function expand(field: string, range: { min: number; max: number }): number[] {
  const out: number[] = [];
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = range.min; i <= range.max; i++) out.push(i);
      continue;
    }
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const base = stepMatch[1];
      const step = parseInt(stepMatch[2], 10);
      const baseValues = base === "*"
        ? rangeOf(range.min, range.max)
        : expandRange(base, range);
      for (const v of baseValues) {
        if ((v - range.min) % step === 0) out.push(v);
      }
      continue;
    }
    if (part.includes("-")) {
      for (const v of expandRange(part, range)) out.push(v);
      continue;
    }
    const n = parseInt(part, 10);
    if (!Number.isNaN(n)) out.push(n);
  }
  return Array.from(new Set(out)).filter((v) => v >= range.min && v <= range.max);
}

function expandRange(part: string, range: { min: number; max: number }): number[] {
  const [a, b] = part.split("-").map((s) => parseInt(s, 10));
  if (Number.isNaN(a) || Number.isNaN(b)) return [];
  const lo = Math.max(range.min, Math.min(a, b));
  const hi = Math.min(range.max, Math.max(a, b));
  return rangeOf(lo, hi);
}

function rangeOf(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

function tokenize(expr: string): Tokens | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return {
    minute: expand(parts[0], MINUTE),
    hour: expand(parts[1], HOUR),
    dom: expand(parts[2], DOM),
    month: expand(parts[3], MONTH),
    dow: expand(parts[4], DOW),
  };
}

interface NowParts {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
}

function nowInTz(tz: string): NowParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    minute: parseInt(get("minute"), 10),
    hour: parseInt(get("hour"), 10) % 24,
    dom: parseInt(get("day"), 10),
    month: parseInt(get("month"), 10),
    dow: dowMap[get("weekday")] ?? 0,
  };
}

function matches(tokens: Tokens, now: NowParts): boolean {
  if (!tokens.minute.includes(now.minute)) return false;
  if (!tokens.hour.includes(now.hour)) return false;
  if (!tokens.month.includes(now.month)) return false;
  // Cron classico: si tanto dom como dow estan restringidos (no full *),
  // basta con que UNO matchee. Si solo uno esta restringido, ese gobierna.
  const domFull = tokens.dom.length === 31;
  const dowFull = tokens.dow.length === 7;
  const domOk = tokens.dom.includes(now.dom);
  const dowOk = tokens.dow.includes(now.dow);
  if (domFull && dowFull) return true;
  if (domFull) return dowOk;
  if (dowFull) return domOk;
  return domOk || dowOk;
}

const FIRE_COOLDOWN_MS = 55_000;
// Si el tick corre dos veces en el mismo minuto (clock drift, restart),
// no disparamos dos veces el mismo recordatorio.

async function runRemindersTick(): Promise<void> {
  void logEvent({ type: EventTypes.CRON_REMINDER_TICK });

  let reminders: Awaited<ReturnType<typeof reminderRepo.getActiveForTick>>;
  try {
    reminders = await reminderRepo.getActiveForTick();
  } catch (err) {
    logger.error("reminders tick: query failed", { err });
    return;
  }

  if (reminders.length === 0) return;

  const now = nowInTz(TZ);
  const nowMs = Date.now();

  for (const r of reminders) {
    const tokens = tokenize(r.cron_expr);
    if (!tokens) {
      logger.warn("invalid cron_expr in user_reminders", {
        id: r.id, expr: r.cron_expr,
      });
      continue;
    }
    if (!matches(tokens, now)) continue;

    if (r.last_fired_at) {
      const elapsed = nowMs - new Date(r.last_fired_at).getTime();
      if (elapsed < FIRE_COOLDOWN_MS) continue;
    }

    const dest = r.wa_chat_id ?? r.phone_wa;
    if (!dest) continue;

    try {
      await sendText(dest, r.message, {
        userId: r.user_id,
        category: "user_reminder",
      });
      await reminderRepo.markFired(r.id);
      void logEvent({
        userId: r.user_id,
        type: EventTypes.CRON_REMINDER_FIRED,
        payload: { reminder_id: r.id, label: r.label },
      });
    } catch (err) {
      logger.error("user reminder send failed", {
        reminder_id: r.id, err,
      });
    }
  }
}

export function scheduleRemindersCron(): void {
  // Cada minuto. La logica fina de horas/dias vive en runRemindersTick.
  cron.schedule(
    "* * * * *",
    () => {
      runRemindersTick().catch((err) =>
        logger.error("reminders tick uncaught", { err }),
      );
    },
    { timezone: TZ },
  );
  logger.info("cron: user reminders tick registered (every minute, ART)");
}

// Export interno para testing manual.
export const __testing = { tokenize, matches, nowInTz };
