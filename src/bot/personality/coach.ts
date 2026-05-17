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

// ════════════════════════════════════════════════════════════
// RECOMENDADOR DE COMIDAS (v2) — "con X comida completás lo que falta"
// ════════════════════════════════════════════════════════════

export type RecoMacro = "protein" | "carbs" | "fat";

/** Mínimo restante (g) para que valga la pena recomendar ese macro. */
export const RECO_MIN_REMAINING: Record<RecoMacro, number> = {
  protein: 15,
  carbs: 25,
  fat: 10,
};

/**
 * Decide para qué macro recomendar comida. Prioriza la proteína; si está
 * cubierta, va por el macro más atrasado (menor % consumido) que tenga
 * margen suficiente. Devuelve null si no hay nada útil que recomendar o si
 * ya te pasaste de kcal (no tiene sentido decirte que comas más).
 */
export function chooseRecoMacro(a: CoachAssessment): RecoMacro | null {
  // Si ya te pasaste de calorías, no recomendamos comer más; el aviso de
  // "te pasaste" ya cubre el caso.
  if (a.macros.kcal.status === "over") return null;

  const eligible = (["protein", "carbs", "fat"] as RecoMacro[]).filter((k) => {
    const m = a.macros[k];
    return m.status !== "over" && m.remaining >= RECO_MIN_REMAINING[k];
  });
  if (eligible.length === 0) return null;

  // Proteína primero si está entre las elegibles.
  if (eligible.includes("protein")) return "protein";

  // Si no, la más atrasada por % consumido.
  eligible.sort((x, y) => a.macros[x].pctConsumed - a.macros[y].pctConsumed);
  return eligible[0];
}

/** Alimento candidato (viene de food.repo.getMacroRichFoods). */
export interface RecoFood {
  name: string;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  /** Porción casera default, si existe ("unidad", "feta", "plato"...). */
  default_portion_name: string | null;
  default_portion_grams: number | null;
}

export interface FoodSuggestion {
  name: string;
  /** Gramos sugeridos, redondeados a múltiplo de 5. */
  grams: number;
  /** "≈ 5 unidad" si hay porción casera y el conteo es entero útil. */
  portionHint: string | null;
  /** Cuánto del macro objetivo aporta esa cantidad (g, redondeado). */
  addsMacro: number;
  /** true si cierra >= 85% del faltante (si no, "te acerca"). */
  closesGap: boolean;
}

const MACRO_DENSITY: Record<RecoMacro, keyof RecoFood> = {
  protein: "protein_per_100g",
  carbs: "carbs_per_100g",
  fat: "fat_per_100g",
};

/**
 * A partir del faltante de un macro y una lista de alimentos ricos en él,
 * calcula 1-2 sugerencias concretas con gramos y porción casera. Pura.
 *
 * - Cantidad = faltante / (densidad/100), redondeada a 5g.
 * - Si esa cantidad costaría más kcal de las que quedan, se recorta al
 *   tope calórico (la sugerencia "te acerca" en vez de "lo cerrás").
 * - Descarta alimentos que requieran cantidades irreales (>500g) o con
 *   densidad despreciable.
 */
export function buildFoodSuggestions(
  macro: RecoMacro,
  remainingGrams: number,
  kcalRemaining: number,
  foods: RecoFood[],
  max = 2,
): FoodSuggestion[] {
  const densKey = MACRO_DENSITY[macro];
  const out: FoodSuggestion[] = [];

  for (const f of foods) {
    const density = f[densKey] as number; // g de macro por 100g
    if (!density || density < 1) continue;

    let grams = (remainingGrams / density) * 100;
    let capped = false;

    // Tope calórico: no sugerir algo que te haga pasar de kcal.
    if (kcalRemaining > 0 && f.kcal_per_100g > 0) {
      const maxGramsByKcal = (kcalRemaining / f.kcal_per_100g) * 100;
      if (grams > maxGramsByKcal) {
        grams = maxGramsByKcal;
        capped = true;
      }
    }

    grams = Math.round(grams / 5) * 5;
    if (grams < 20 || grams > 500) continue;

    const addsMacro = Math.round((grams * density) / 100);
    if (addsMacro < 1) continue;

    let portionHint: string | null = null;
    if (f.default_portion_name && f.default_portion_grams && f.default_portion_grams > 0) {
      const count = Math.round(grams / f.default_portion_grams);
      if (count >= 1 && count <= 20) {
        portionHint = `≈ ${count} ${f.default_portion_name}`;
      }
    }

    out.push({
      name: f.name,
      grams,
      portionHint,
      addsMacro,
      closesGap: !capped && addsMacro >= remainingGrams * 0.85,
    });
    if (out.length >= max) break;
  }

  return out;
}
