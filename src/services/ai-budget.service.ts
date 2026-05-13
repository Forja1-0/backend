/**
 * Rate-limit del uso de AI por user/dia para evitar runaway costs.
 *
 * Solo aplica al hot path (parseMealText). Las llamadas one-shot (parser de
 * plan de entrenamiento, resumen nocturno) no pasan por aca.
 *
 * Almacenamiento en memoria: el contador se resetea al restart del proceso.
 * Es aceptable para MVP — el limite es un techo de seguridad, no contable.
 */

import { logger } from "../config/logger.js";

const DAILY_LIMIT = 5;
const counters = new Map<string, { count: number; date: string }>();

function todayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

export function canUseAi(userId: string): boolean {
  const today = todayKey();
  const c = counters.get(userId);
  if (!c || c.date !== today) return true;
  return c.count < DAILY_LIMIT;
}

export function recordAiUse(userId: string): void {
  const today = todayKey();
  const c = counters.get(userId);
  if (!c || c.date !== today) {
    counters.set(userId, { count: 1, date: today });
    return;
  }
  c.count += 1;
  if (c.count === DAILY_LIMIT) {
    logger.warn("ai budget hit for user", { userId, count: c.count });
  }
}

export function getAiUsage(userId: string): { count: number; limit: number } {
  const today = todayKey();
  const c = counters.get(userId);
  if (!c || c.date !== today) return { count: 0, limit: DAILY_LIMIT };
  return { count: c.count, limit: DAILY_LIMIT };
}
