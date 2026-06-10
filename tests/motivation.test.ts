import { describe, it, expect } from "vitest";
import { generateSlots, mondayOfWeek } from "../src/cron/motivation.cron.js";
import { registrationMotivationLine } from "../src/bot/personality/templates.js";

const TZ = "America/Argentina/Buenos_Aires";
function artHour(d: Date): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(d),
    10,
  ) % 24;
}

describe("motivation slot planner", () => {
  const now = new Date("2026-06-09T12:00:00-03:00"); // martes mediodía ART
  const weekStart = mondayOfWeek(now);

  it("ancla la semana al lunes ART", () => {
    expect(weekStart).toBe("2026-06-08");
  });

  it("genera una cantidad dentro de la banda y siempre a futuro", () => {
    for (let i = 0; i < 40; i++) {
      const slots = generateSlots(weekStart, now);
      expect(slots.length).toBeGreaterThanOrEqual(0);
      expect(slots.length).toBeLessThanOrEqual(6);
      for (const s of slots) {
        expect(s.scheduled_for.getTime()).toBeGreaterThan(now.getTime());
      }
    }
  });

  it("respeta la ventana horaria de cada kind", () => {
    const windows: Record<string, [number, number]> = {
      morning: [6, 9], midday: [12, 15], night: [20, 22],
    };
    for (let i = 0; i < 40; i++) {
      for (const s of generateSlots(weekStart, now)) {
        const [lo, hi] = windows[s.kind];
        const h = artHour(s.scheduled_for);
        expect(h).toBeGreaterThanOrEqual(lo);
        expect(h).toBeLessThan(hi);
      }
    }
  });

  it("no duplica (día, kind)", () => {
    for (let i = 0; i < 40; i++) {
      const slots = generateSlots(weekStart, now);
      const keys = slots.map((s) => `${new Date(s.scheduled_for).toDateString()}:${s.kind}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("registrationMotivationLine", () => {
  const goal = { goal_kind: "gain_muscle", goal_metric_value: 80, goal_metric_unit: "kg", goal_metric_label: null };

  it("celebra hitos de racha con prioridad", () => {
    const line = registrationMotivationLine(goal, 2);
    expect(line).toContain("2 días seguidos");
  });

  it("conecta con la meta cuando hay número y no es hito", () => {
    const line = registrationMotivationLine(goal, 4);
    expect(line).toContain("80kg");
  });

  it("usa el label libre cuando no hay número de meta", () => {
    const line = registrationMotivationLine(
      { goal_kind: "custom", goal_metric_value: null, goal_metric_unit: null, goal_metric_label: "correr 10k" },
      4,
    );
    expect(line).toContain("correr 10k");
  });

  it("devuelve null sin meta ni racha relevante", () => {
    expect(registrationMotivationLine(null, 4)).toBeNull();
  });
});
