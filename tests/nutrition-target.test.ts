import { describe, expect, it } from "vitest";
import {
  activityFactorFromSessions,
  computeNutritionTarget,
  KCAL_FLOOR,
  type TargetInput,
} from "../src/services/nutrition-target.js";

/** El tipo del audio: varón, vago con el entreno (~2 sesiones), quiere bajar. */
const AUDIO_GUY: TargetInput = {
  sex: "M",
  age: 30,
  weightKg: 95,
  heightCm: 178,
  sessionsPerWeek: 2,
  goalKind: "lose_weight",
};

/** Suma de kcal a partir de los macros (Atwater). */
const kcalFromMacros = (t: { protein_g: number; carbs_g: number; fat_g: number }) =>
  t.protein_g * 4 + t.carbs_g * 4 + t.fat_g * 9;

describe("activityFactorFromSessions", () => {
  it("mapea sesiones/semana a la escala clásica", () => {
    expect(activityFactorFromSessions(0)).toBe(1.2);
    expect(activityFactorFromSessions(1)).toBe(1.375);
    expect(activityFactorFromSessions(2)).toBe(1.375);
    expect(activityFactorFromSessions(3)).toBe(1.55);
    expect(activityFactorFromSessions(4)).toBe(1.55);
    expect(activityFactorFromSessions(6)).toBe(1.725);
    expect(activityFactorFromSessions(7)).toBe(1.9);
  });

  it("sesiones negativas (dato corrupto) caen a sedentario", () => {
    expect(activityFactorFromSessions(-3)).toBe(1.2);
  });
});

describe("computeNutritionTarget", () => {
  it("bajar de peso → déficit: target por debajo del TDEE", () => {
    const t = computeNutritionTarget(AUDIO_GUY);
    expect(t.basis.strategy).toBe("deficit");
    expect(t.kcal).toBeLessThan(t.basis.tdee);
    // -20% nominal (antes del piso de seguridad, que acá no muerde).
    expect(t.kcal).toBeCloseTo(Math.round(t.basis.tdee * 0.8), -1);
  });

  it("ganar masa → superávit por encima del TDEE", () => {
    const t = computeNutritionTarget({ ...AUDIO_GUY, goalKind: "gain_muscle" });
    expect(t.basis.strategy).toBe("surplus");
    expect(t.kcal).toBeGreaterThan(t.basis.tdee);
  });

  it("metas no-peso (improve_time/custom/null) → mantenimiento = TDEE", () => {
    for (const goalKind of ["improve_time", "reach_distance", "custom", null] as const) {
      const t = computeNutritionTarget({ ...AUDIO_GUY, goalKind });
      expect(t.basis.strategy).toBe("maintenance");
      expect(t.kcal).toBe(t.basis.tdee);
    }
  });

  it("los macros suman ~kcal del target (±2% por redondeo)", () => {
    const t = computeNutritionTarget(AUDIO_GUY);
    const sum = kcalFromMacros(t);
    expect(Math.abs(sum - t.kcal)).toBeLessThanOrEqual(t.kcal * 0.02);
  });

  it("proteína ≈ 1.8 g/kg cuando no la capa el límite de %", () => {
    const t = computeNutritionTarget(AUDIO_GUY);
    expect(t.protein_g).toBe(Math.round(95 * 1.8)); // 171
  });

  it("piso de seguridad: déficit nunca baja del BMR ni del piso por sexo", () => {
    // Mujer chica y mayor con déficit agresivo → el piso debe morder.
    const t = computeNutritionTarget({
      sex: "F",
      age: 65,
      weightKg: 48,
      heightCm: 150,
      sessionsPerWeek: 0,
      goalKind: "lose_weight",
    });
    expect(t.kcal).toBeGreaterThanOrEqual(t.basis.bmr);
    expect(t.kcal).toBeGreaterThanOrEqual(1200); // SEX_KCAL_FLOOR.F
    expect(t.kcal).toBeGreaterThanOrEqual(KCAL_FLOOR);
  });

  it("sexo X cae entre el target masculino y el femenino (mismos datos)", () => {
    const base = { age: 30, weightKg: 80, heightCm: 175, sessionsPerWeek: 3, goalKind: null } as const;
    const m = computeNutritionTarget({ ...base, sex: "M" });
    const f = computeNutritionTarget({ ...base, sex: "F" });
    const x = computeNutritionTarget({ ...base, sex: "X" });
    expect(x.kcal).toBeLessThan(m.kcal);
    expect(x.kcal).toBeGreaterThan(f.kcal);
  });

  it("nunca devuelve un target fuera de los límites de la DB (800-8000)", () => {
    const huge = computeNutritionTarget({
      sex: "M",
      age: 16,
      weightKg: 200,
      heightCm: 210,
      sessionsPerWeek: 7,
      goalKind: "gain_muscle",
    });
    expect(huge.kcal).toBeLessThanOrEqual(8000);
    expect(huge.kcal).toBeGreaterThanOrEqual(KCAL_FLOOR);
    // carbos nunca negativos
    expect(huge.carbs_g).toBeGreaterThanOrEqual(0);
  });
});
