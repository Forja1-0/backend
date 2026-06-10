import { logger } from "../config/logger.js";
import * as motivationRepo from "../repositories/motivation.repo.js";
import { getActiveGoal } from "../repositories/onboarding.repo.js";
import { generateMotivationNudge } from "../services/gemini.service.js";
import { sendText } from "../services/evolution.service.js";
import { logEvent } from "../services/events.service.js";

const TZ = "America/Argentina/Buenos_Aires";

// ── Frecuencia dinámica ───────────────────────────────────
// Cada semana el planificador tira un dado entre estos dos valores. Subí
// MAX_PER_WEEK (hasta ~10) si querés semanas más intensas. La gracia es que
// varíe: una semana 2, otra 5, otra 3.
const MIN_PER_WEEK = 2;
const MAX_PER_WEEK = 6;

// Ventanas horarias por tipo (hora local ART). El minuto se randomiza dentro.
const KIND_WINDOWS: Record<motivationRepo.NudgeKind, [number, number]> = {
  morning: [6, 9],
  midday: [12, 15],
  night: [20, 22],
};
const KINDS: motivationRepo.NudgeKind[] = ["morning", "midday", "night"];

// Si un nudge quedó vencido hace más de esto, no lo mandamos (un "buenos días"
// no puede llegar a la tarde). Lo marcamos skipped.
const STALE_MS = 2 * 60 * 60 * 1000;

function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── ART date helpers ──────────────────────────────────────
function artParts(date: Date): { y: number; m: number; d: number; dow: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: parseInt(get("year"), 10),
    m: parseInt(get("month"), 10),
    d: parseInt(get("day"), 10),
    dow: dowMap[get("weekday")] ?? 0,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" del lunes de la semana ART que contiene `date`. */
export function mondayOfWeek(date: Date): string {
  const { y, m, d, dow } = artParts(date);
  const back = dow === 0 ? 6 : dow - 1; // domingo cuenta como fin de semana
  // Aritmética de fecha en UTC-noon para no cruzar límites de día por TZ.
  const base = new Date(Date.UTC(y, m - 1, d, 12));
  base.setUTCDate(base.getUTCDate() - back);
  return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
}

/** Instante UTC para una hora local ART en `weekStart + dayOffset`. */
function artInstant(weekStart: string, dayOffset: number, hour: number, minute: number): Date {
  const [y, m, d] = weekStart.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12));
  base.setUTCDate(base.getUTCDate() + dayOffset);
  const yy = base.getUTCFullYear();
  const mm = pad(base.getUTCMonth() + 1);
  const dd = pad(base.getUTCDate());
  // ART es UTC-03:00 (sin DST). Construimos el instante con offset explícito.
  return new Date(`${yy}-${mm}-${dd}T${pad(hour)}:${pad(minute)}:00-03:00`);
}

/** Genera N slots aleatorios (día+kind+hora) en el futuro para la semana. */
export function generateSlots(weekStart: string, now: Date): motivationRepo.NudgeSlot[] {
  const count = randInt(MIN_PER_WEEK, MAX_PER_WEEK);
  const seen = new Set<string>();
  const slots: motivationRepo.NudgeSlot[] = [];
  let guard = 0;
  while (slots.length < count && guard++ < count * 6) {
    const dayOffset = randInt(0, 6);
    const kind = pick(KINDS);
    const key = `${dayOffset}:${kind}`;
    if (seen.has(key)) continue; // un solo nudge por (día, momento)
    const [lo, hi] = KIND_WINDOWS[kind];
    const when = artInstant(weekStart, dayOffset, randInt(lo, hi - 1), randInt(0, 59));
    if (when.getTime() <= now.getTime()) continue; // solo futuro
    seen.add(key);
    slots.push({ scheduled_for: when, kind });
  }
  return slots.sort((a, b) => a.scheduled_for.getTime() - b.scheduled_for.getTime());
}

/**
 * Planifica la semana actual para todos los usuarios elegibles que no la tengan
 * planeada. Idempotente por (user, week_start). Corre semanal + al boot (para
 * que un deploy nuevo tenga nudges esta misma semana).
 */
export async function planMotivationWeek(): Promise<void> {
  const now = new Date();
  const weekStart = mondayOfWeek(now);
  let users: Awaited<ReturnType<typeof motivationRepo.getEligibleUsers>>;
  try {
    users = await motivationRepo.getEligibleUsers();
  } catch (err) {
    logger.error("motivation planner: fetch users failed", { err });
    return;
  }

  let planned = 0;
  for (const u of users) {
    try {
      if (await motivationRepo.isWeekPlanned(u.id, weekStart)) continue;
      const slots = generateSlots(weekStart, now);
      if (slots.length === 0) continue;
      await motivationRepo.insertNudges(u.id, weekStart, slots);
      planned++;
      void logEvent({
        userId: u.id,
        type: "motivation.week_planned",
        payload: { week_start: weekStart, count: slots.length },
      });
    } catch (err) {
      logger.error("motivation planner: user failed", { err, userId: u.id });
    }
  }
  logger.info("motivation planner: done", { weekStart, users: users.length, planned });
}

/**
 * Tick: dispara los nudges vencidos. Genera el mensaje con AI en el momento
 * (fresco, con el progreso del día) y lo manda. Salta los muy viejos.
 */
export async function runMotivationTick(): Promise<void> {
  let due: Awaited<ReturnType<typeof motivationRepo.getDueNudges>>;
  try {
    due = await motivationRepo.getDueNudges();
  } catch (err) {
    logger.error("motivation tick: query failed", { err });
    return;
  }
  if (due.length === 0) return;

  const nowMs = Date.now();
  for (const n of due) {
    try {
      if (nowMs - new Date(n.scheduled_for).getTime() > STALE_MS) {
        await motivationRepo.markSkipped(n.id);
        void logEvent({ userId: n.user_id, type: "motivation.nudge_skipped_stale", payload: { kind: n.kind } });
        continue;
      }
      const [goal, progress] = await Promise.all([
        getActiveGoal(n.user_id).catch(() => null),
        motivationRepo.getProgressSnapshot(n.user_id),
      ]);
      const message = await generateMotivationNudge({
        name: n.name,
        kind: n.kind,
        goal,
        progress,
      });
      await sendText(n.wa_chat_id, message, {
        userId: n.user_id,
        category: "motivation_nudge",
        extra: { kind: n.kind },
      });
      await motivationRepo.markSent(n.id);
      void logEvent({
        userId: n.user_id,
        type: "motivation.nudge_sent",
        payload: { kind: n.kind, day_streak: progress.dayStreak },
      });
      logger.info("motivation nudge sent", { userId: n.user_id, kind: n.kind });
    } catch (err) {
      logger.error("motivation nudge send failed", { err, nudgeId: n.id });
    }
  }
}
