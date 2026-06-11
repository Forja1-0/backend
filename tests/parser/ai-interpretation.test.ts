import { describe, it, expect } from "vitest";
import { aiInterpretationSchema } from "../../src/schemas/bot.schema.js";

describe("aiInterpretationSchema", () => {
  it("acepta weight_log (regresión: faltaba en el enum zod y tiraba la respuesta de la AI)", () => {
    const r = aiInterpretationSchema.safeParse({ intent: "weight_log", items: [] });
    expect(r.success).toBe(true);
  });

  it("acepta training_complete con training_session y off_plan", () => {
    const r = aiInterpretationSchema.safeParse({
      intent: "training_complete",
      items: [],
      training_session: "brazos",
      off_plan: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.training_session).toBe("brazos");
      expect(r.data.off_plan).toBe(true);
    }
  });

  it("training_session y off_plan son opcionales/nullables (respuestas viejas siguen válidas)", () => {
    expect(aiInterpretationSchema.safeParse({ intent: "training_complete", items: [] }).success).toBe(true);
    expect(
      aiInterpretationSchema.safeParse({
        intent: "training_complete",
        items: [],
        training_session: null,
        off_plan: null,
      }).success,
    ).toBe(true);
  });

  it("desliz con items de comida (pizza + birras) parsea bien", () => {
    const r = aiInterpretationSchema.safeParse({
      intent: "disruption_desliz",
      items: [
        { slug: null, food: "pizza", qty: 1, unit: "units", measure: null, state: null },
        { slug: null, food: "cerveza", qty: 6, unit: "units", measure: null, state: null },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.items).toHaveLength(2);
  });

  it("rechaza intents que no existen", () => {
    expect(aiInterpretationSchema.safeParse({ intent: "hacer_magia", items: [] }).success).toBe(false);
  });

  it("rechaza items sin slug ni food", () => {
    const r = aiInterpretationSchema.safeParse({
      intent: "meal_log",
      items: [{ slug: null, food: null, qty: 2 }],
    });
    expect(r.success).toBe(false);
  });
});
