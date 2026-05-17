/**
 * Lógica de coach nutricional — pura, sin DB ni strings de cara al user.
 * Toma los macros target/consumidos del día + la hora local y devuelve una
 * evaluación estructurada. El render vive en templates.ts (coachAfterMeal /
 * coachStatus). Determinístico y testeable.
 */

import type { DailyRemainingRow } from "../../repositories/daily.repo.js";

// ── Umbrales ───────────────────────────────────────────────
/** Se considera "pasado" si lo consumido supera el target por más de esto. */
export const OVER_TOLERANCE = 0.05; // +5%
/** Se considera "queda poco" si el restante es <= este % del target. */
export const LOW_REMAINING_PCT = 0.15; // 15%
/** Antes de esta hora local el día se considera "temprano". */
export const EARLY_HOUR_CUTOFF = 15; // 15:00
/** Temprano + este % de kcal/proteína ya consumido → alerta de moderar. */
export const EARLY_CONSUMED_PCT = 0.6; // 60%

export type MacroKey = "kcal" | "protein" | "carbs" | "fat";
export type MacroStatus = "ok" | "low" | "over";

export interface MacroAssessment {
  key: MacroKey;
  target: number;
  consumed: number;
  /** Restante, clampeado a >= 0 para mostrar. */
  remaining: number;
  /** Cuánto se pasó del target (g/kcal), 0 si no se pasó. */
  overBy: number;
  /** Fracción consumida del target (puede ser > 1). */
  pctConsumed: number;
  status: MacroStatus;
}

export type DayHeadline = "green" | "tight" | "over";

export interface EarlyAlert {
  /** Macro que disparó la alerta (la de mayor % consumido). */
  key: "kcal" | "protein";
  pctConsumed: number;
  hour: number;
}

export interface CoachAssessment {
  headline: DayHeadline;
  macros: Record<MacroKey, MacroAssessment>;
  /** null si no es temprano o si el consumo aún es moderado. */
  earlyAlert: EarlyAlert | null;
}

function assessMacro(
  key: MacroKey,
  target: number,
  consumed: number,
): MacroAssessment {
  const rawRemaining = target - consumed;
  const pctConsumed = target > 0 ? consumed / target : 0;
  const overBy = consumed > target ? consumed - target : 0;

  let status: MacroStatus = "ok";
  if (target > 0 && consumed > target * (1 + OVER_TOLERANCE)) {
    status = "over";
  } else if (target > 0 && rawRemaining > 0 && rawRemaining <= target * LOW_REMAINING_PCT) {
    status = "low";
  }

  return {
    key,
    target,
    consumed,
    remaining: Math.max(0, rawRemaining),
    overBy,
    pctConsumed,
    status,
  };
}

/**
 * Hora local (0-23) según la timezone del usuario. Fallback a la hora del
 * servidor si la tz es inválida.
 */
export function localHour(timezone: string, now: Date = new Date()): number {
  try {
    const h = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(now);
    // "24" en algunos runtimes para medianoche → normalizamos
    const n = parseInt(h, 10);
    return Number.isFinite(n) ? n % 24 : now.getHours();
  } catch {
    return now.getHours();
  }
}

/**
 * Evalúa el día a partir de la fila de v_daily_remaining y la hora local.
 */
export function assessDay(
  row: DailyRemainingRow,
  hour: number,
): CoachAssessment {
  const macros: Record<MacroKey, MacroAssessment> = {
    kcal: assessMacro("kcal", row.target_kcal, row.consumed_kcal),
    protein: assessMacro("protein", row.target_protein_g, row.consumed_protein),
    carbs: assessMacro("carbs", row.target_carbs_g, row.consumed_carbs),
    fat: assessMacro("fat", row.target_fat_g, row.consumed_fat),
  };

  const anyOver = Object.values(macros).some((m) => m.status === "over");
  const anyLow = Object.values(macros).some((m) => m.status === "low");
  const headline: DayHeadline = anyOver ? "over" : anyLow ? "tight" : "green";

  // Alerta temprana: si todavía es temprano y ya se consumió mucho de
  // kcal o proteína, avisar que modere el resto del día. Reportamos la de
  // mayor % consumido entre las dos.
  let earlyAlert: EarlyAlert | null = null;
  if (hour < EARLY_HOUR_CUTOFF) {
    const candidates: { key: "kcal" | "protein"; pct: number }[] = [
      { key: "kcal", pct: macros.kcal.pctConsumed },
      { key: "protein", pct: macros.protein.pctConsumed },
    ];
    candidates.sort((a, b) => b.pct - a.pct);
    const top = candidates[0];
    if (top.pct >= EARLY_CONSUMED_PCT) {
      earlyAlert = { key: top.key, pctConsumed: top.pct, hour };
    }
  }

  return { headline, macros, earlyAlert };
}
