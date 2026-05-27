import { describe, it, expect } from "vitest";
import { __testing } from "../src/cron/reminders.cron.js";

const { tokenize, matches } = __testing;

describe("reminders cron parser", () => {
  it("expande wildcard de minutos", () => {
    const t = tokenize("* * * * *");
    expect(t).not.toBeNull();
    expect(t!.minute.length).toBe(60);
    expect(t!.hour.length).toBe(24);
    expect(t!.dow.length).toBe(7);
  });

  it("expande lista de minutos", () => {
    const t = tokenize("0,15,30,45 * * * *");
    expect(t!.minute).toEqual([0, 15, 30, 45]);
  });

  it("expande rango de horas", () => {
    const t = tokenize("0 9-17 * * 1-5");
    expect(t!.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(t!.dow).toEqual([1, 2, 3, 4, 5]);
  });

  it("expande step cada N minutos", () => {
    const t = tokenize("*/15 * * * *");
    expect(t!.minute).toEqual([0, 15, 30, 45]);
  });

  it("rechaza expresiones con campos faltantes", () => {
    expect(tokenize("0 9 *")).toBeNull();
  });

  it("matches con hora exacta", () => {
    const t = tokenize("30 14 * * *")!;
    expect(matches(t, { minute: 30, hour: 14, dom: 1, month: 1, dow: 3 })).toBe(true);
    expect(matches(t, { minute: 31, hour: 14, dom: 1, month: 1, dow: 3 })).toBe(false);
    expect(matches(t, { minute: 30, hour: 15, dom: 1, month: 1, dow: 3 })).toBe(false);
  });

  it("matches con dow restringido", () => {
    const t = tokenize("0 8 * * 1,3,5")!; // L, Mi, V
    expect(matches(t, { minute: 0, hour: 8, dom: 10, month: 5, dow: 1 })).toBe(true);
    expect(matches(t, { minute: 0, hour: 8, dom: 10, month: 5, dow: 2 })).toBe(false);
    expect(matches(t, { minute: 0, hour: 8, dom: 10, month: 5, dow: 5 })).toBe(true);
  });

  it("matches con dom y dow ambos restringidos usa OR (cron standard)", () => {
    const t = tokenize("0 8 15 * 1")!; // dia 15 O lunes
    expect(matches(t, { minute: 0, hour: 8, dom: 15, month: 3, dow: 2 })).toBe(true);
    expect(matches(t, { minute: 0, hour: 8, dom: 10, month: 3, dow: 1 })).toBe(true);
    expect(matches(t, { minute: 0, hour: 8, dom: 10, month: 3, dow: 2 })).toBe(false);
  });
});
