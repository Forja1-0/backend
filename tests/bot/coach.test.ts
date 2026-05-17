import { describe, expect, it } from "vitest";
import { assessDay, localHour } from "../../src/bot/personality/coach.js";
import type { DailyRemainingRow } from "../../src/repositories/daily.repo.js";

/** Construye una fila de v_daily_remaining a partir de target + consumido. */
function row(
  target: { kcal: number; protein: number; carbs: number; fat: number },
  consumed: { kcal: number; protein: number; carbs: number; fat: number },
): DailyRemainingRow {
  return {
    target_kcal: target.kcal,
    target_protein_g: target.protein,
    target_carbs_g: target.carbs,
    target_fat_g: target.fat,
    consumed_kcal: consumed.kcal,
    consumed_protein: consumed.protein,
    consumed_carbs: consumed.carbs,
    consumed_fat: consumed.fat,
    remaining_kcal: target.kcal - consumed.kcal,
    remaining_protein: target.protein - consumed.protein,
    remaining_carbs: target.carbs - consumed.carbs,
    remaining_fat: target.fat - consumed.fat,
  };
}

const TARGET = { kcal: 2960, protein: 189, carbs: 365, fat: 83 };

describe("coach.assessDay", () => {
  it("día en línea → headline green, sin alertas", () => {
    const a = assessDay(row(TARGET, { kcal: 800, protein: 50, carbs: 90, fat: 25 }), 10);
    expect(a.headline).toBe("green");
    expect(a.macros.protein.status).toBe("ok");
    expect(a.earlyAlert).toBeNull();
  });

  it("pasarse de un macro → status over, overBy y headline over", () => {
    // 8 huevos kinder del transcript: ~272g grasa vs target 83
    const a = assessDay(row(TARGET, { kcal: 4304, protein: 64, carbs: 400, fat: 272 }), 21);
    expect(a.macros.kcal.status).toBe("over");
    expect(a.macros.fat.status).toBe("over");
    expect(a.macros.fat.overBy).toBe(272 - 83);
    expect(a.headline).toBe("over");
    // restante clampeado a 0, no negativo
    expect(a.macros.kcal.remaining).toBe(0);
  });

  it("queda poco margen (<=15% del target) → status low, headline tight", () => {
    // proteína: quedan 20 de 189 (~10.6%) → low. Resto holgado.
    const a = assessDay(row(TARGET, { kcal: 1500, protein: 169, carbs: 100, fat: 30 }), 13);
    expect(a.macros.protein.status).toBe("low");
    expect(a.macros.protein.remaining).toBe(20);
    expect(a.headline).toBe("tight");
  });

  it("tolerancia +5% no marca pasado", () => {
    const a = assessDay(row(TARGET, { kcal: Math.round(2960 * 1.04), protein: 50, carbs: 90, fat: 25 }), 12);
    expect(a.macros.kcal.status).toBe("ok");
  });

  it("alerta temprana: antes de las 15h con >=60% de kcal consumidas", () => {
    const a = assessDay(row(TARGET, { kcal: 2000, protein: 80, carbs: 200, fat: 50 }), 11);
    expect(a.earlyAlert).not.toBeNull();
    expect(a.earlyAlert!.key).toBe("kcal");
    expect(a.earlyAlert!.hour).toBe(11);
    expect(a.earlyAlert!.pctConsumed).toBeCloseTo(2000 / 2960, 3);
  });

  it("alerta temprana dispara por proteína si es la de mayor %", () => {
    // primera comida con 140g de proteína (transcript), temprano
    const a = assessDay(row(TARGET, { kcal: 900, protein: 140, carbs: 40, fat: 30 }), 9);
    expect(a.earlyAlert).not.toBeNull();
    expect(a.earlyAlert!.key).toBe("protein");
  });

  it("misma sobrecarga pero tarde (>=15h) → sin alerta temprana", () => {
    const a = assessDay(row(TARGET, { kcal: 2000, protein: 80, carbs: 200, fat: 50 }), 16);
    expect(a.earlyAlert).toBeNull();
  });
});

describe("coach.localHour", () => {
  it("devuelve hora 0-23 para tz válida", () => {
    const h = localHour("America/Argentina/Buenos_Aires", new Date("2026-05-16T18:00:00Z"));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(24);
  });

  it("tz inválida → fallback a hora del servidor sin throw", () => {
    const now = new Date();
    expect(localHour("Not/AZone", now)).toBe(now.getHours());
  });
});
