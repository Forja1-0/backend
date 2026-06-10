/**
 * Motor de target nutricional auto-calculado — modo amateur.
 *
 * El amateur NO trae plan de un nutricionista: Forja le estima un target
 * diario a partir de sus datos reales (sexo/edad/peso/altura) + su nivel de
 * actividad (sesiones/semana) + su meta. Es el reemplazo del `nutrition_plans`
 * que en elite sube el coach.
 *
 * IMPORTANTE — honestidad de números (cultura del proyecto): esto NO es un
 * número fabricado, es un cálculo transparente sobre datos reales del usuario.
 * Pero SIEMPRE se comunica como ESTIMACIÓN, no como prescripción de nutri.
 *
 * Determinístico y puro (sin DB, sin strings de cara al user). Testeable.
 * El wiring (leer user/training, persistir como nutrition_plans source=forja_auto)
 * vive aparte.
 */

export type Sex = "M" | "F" | "X";

/**
 * Tipo de meta amateur (goals.goal_kind). Solo `lose_weight` y `gain_muscle`
 * mueven las kcal; el resto va a mantenimiento (la meta no es de peso).
 */
export type AmateurGoalKind =
  | "lose_weight"
  | "gain_muscle"
  | "improve_time"
  | "reach_distance"
  | "custom"
  | null;

export type TargetStrategy = "deficit" | "surplus" | "maintenance";

export interface TargetInput {
  sex: Sex;
  age: number;
  weightKg: number;
  heightCm: number;
  /** Días no-descanso del plan de entrenamiento. 0 si no hay plan. */
  sessionsPerWeek: number;
  goalKind: AmateurGoalKind;
}

export interface NutritionTarget {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  /** Trazabilidad del cálculo — para "cómo lo calculamos" y debug. */
  basis: {
    bmr: number;
    activityFactor: number;
    tdee: number;
    strategy: TargetStrategy;
  };
}

// ── Constantes (límites de la DB) ───────────────────────────
/** CHECK de nutrition_plans.target_kcal: BETWEEN 800 AND 8000. */
export const KCAL_FLOOR = 800;
export const KCAL_CEIL = 8000;

// ── Parámetros del modelo ───────────────────────────────────
/** Déficit para bajar de peso: -20% del TDEE (sostenible, ~0.5kg/sem). */
const DEFICIT_MULTIPLIER = 0.8;
/** Superávit para ganar masa: +10% del TDEE (limpio, sin engorde innecesario). */
const SURPLUS_MULTIPLIER = 1.1;

/** Proteína por kg de peso corporal. 1.8 preserva masa en déficit. */
const PROTEIN_G_PER_KG = 1.8;
/** La proteína nunca supera este % de las kcal (evita absurdos en obesidad). */
const PROTEIN_KCAL_CAP_PCT = 0.4;
/** Fracción de las kcal asignada a grasa. El resto va a carbos. */
const FAT_KCAL_PCT = 0.25;

/**
 * Piso de seguridad por sexo: nunca recomendar comer por debajo de esto,
 * aunque el déficit lo empuje más abajo. Junto con el BMR (ver abajo).
 */
const SEX_KCAL_FLOOR: Record<Sex, number> = { M: 1500, F: 1200, X: 1350 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Factor de actividad a partir de sesiones de entrenamiento por semana.
 * Escala clásica de Harris-Benedict/Mifflin.
 */
export function activityFactorFromSessions(sessionsPerWeek: number): number {
  if (sessionsPerWeek <= 0) return 1.2; // sedentario
  if (sessionsPerWeek <= 2) return 1.375; // ligero
  if (sessionsPerWeek <= 4) return 1.55; // moderado
  if (sessionsPerWeek <= 6) return 1.725; // alto
  return 1.9; // muy alto (7+)
}

/**
 * BMR por Mifflin-St Jeor. Para sexo "X" usamos el promedio de las constantes
 * masculina (+5) y femenina (-161) → -78, en vez de inventar una tercera.
 */
function mifflinBmr(sex: Sex, weightKg: number, heightCm: number, age: number): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  const sexConstant = sex === "M" ? 5 : sex === "F" ? -161 : -78;
  return base + sexConstant;
}

function strategyForGoal(goalKind: AmateurGoalKind): TargetStrategy {
  if (goalKind === "lose_weight") return "deficit";
  if (goalKind === "gain_muscle") return "surplus";
  return "maintenance";
}

/**
 * Calcula el target diario estimado. Pura.
 *
 * Pipeline: BMR (Mifflin) → ×factor actividad = TDEE → ajuste por meta →
 * piso de seguridad → clamp a límites de DB → reparto de macros
 * (proteína por peso, grasa 25%, carbos el resto).
 */
export function computeNutritionTarget(input: TargetInput): NutritionTarget {
  const { sex, age, weightKg, heightCm, sessionsPerWeek, goalKind } = input;

  const bmr = mifflinBmr(sex, weightKg, heightCm, age);
  const activityFactor = activityFactorFromSessions(sessionsPerWeek);
  const tdee = bmr * activityFactor;
  const strategy = strategyForGoal(goalKind);

  let kcal =
    strategy === "deficit"
      ? tdee * DEFICIT_MULTIPLIER
      : strategy === "surplus"
        ? tdee * SURPLUS_MULTIPLIER
        : tdee;

  // Piso de seguridad: nunca por debajo del BMR ni del piso por sexo.
  // Solo muerde en déficit; en mantenimiento/superávit ya estamos arriba.
  const floor = Math.max(bmr, SEX_KCAL_FLOOR[sex]);
  if (kcal < floor) kcal = floor;

  // Clamp duro a los límites del CHECK de la DB.
  kcal = clamp(Math.round(kcal), KCAL_FLOOR, KCAL_CEIL);

  // Proteína: 1.8 g/kg, capada para no superar el % de kcal permitido.
  const maxProteinG = Math.floor((kcal * PROTEIN_KCAL_CAP_PCT) / 4);
  const proteinG = Math.min(Math.round(weightKg * PROTEIN_G_PER_KG), maxProteinG);

  // Grasa: 25% de las kcal.
  const fatG = Math.round((kcal * FAT_KCAL_PCT) / 9);

  // Carbos: lo que sobra tras proteína y grasa (nunca negativo).
  const remainingKcal = kcal - proteinG * 4 - fatG * 9;
  const carbsG = Math.max(0, Math.round(remainingKcal / 4));

  return {
    kcal,
    protein_g: proteinG,
    carbs_g: carbsG,
    fat_g: fatG,
    basis: {
      bmr: Math.round(bmr),
      activityFactor,
      tdee: Math.round(tdee),
      strategy,
    },
  };
}
