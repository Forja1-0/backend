import { describe, expect, it, vi, beforeEach } from "vitest";

// Mockeamos @google/generative-ai antes de importar el servicio. vi.hoisted
// es necesario porque vi.mock se eleva al top, antes de cualquier const.
const { generateContentMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
}));
vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: vi.fn().mockReturnValue({
      generateContent: generateContentMock,
    }),
  })),
}));

// stub env para no requerir todas las vars en tests
vi.mock("../src/config/env.js", () => ({
  env: {
    GEMINI_API_KEY: "test-key",
    MAX_FILE_SIZE: 10485760,
  },
}));

vi.mock("../src/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  parseNutritionPlanFile,
  parseTrainingPlanFile,
  PdfParseError,
  PARSER_VERSION,
} from "../src/services/plan-pdf-parser.service.js";

describe("plan-pdf-parser", () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it("PARSER_VERSION incluye el modelo (para auditar reproceso)", () => {
    expect(PARSER_VERSION).toMatch(/gemini/);
  });

  it("rechaza mimes no soportados", async () => {
    await expect(
      parseNutritionPlanFile(Buffer.from("fake"), "application/zip"),
    ).rejects.toBeInstanceOf(PdfParseError);
  });

  it("parsea nutricion: completa arrays faltantes y devuelve shape estable", async () => {
    const fakeResponse = {
      athlete_summary: { name: "Pedrito", age: 21, weight_kg: 70, height_cm: 177, goal: "hipertrofia" },
      targets: { kcal: 2960, protein_g: 189, carbs_g: 365, fat_g: 83 },
      nutritionist_name: "Lic. Soledad",
      phase: "Fase 1",
      budget_notes: "$100k-200k/mes",
      diagnosis: "comia 2 veces y estaba en deficit",
      meal_distribution: [
        {
          meal_id: "desayuno", label: "Desayuno", schedule: "6:30-7:00",
          description: "4 huevos + 2 pan + cafe con leche",
          items: [{ name: "huevo", grams: null, units: "unidades" }],
          macros: { kcal: 460, protein_g: 32, carbs_g: 35, fat_g: 22 },
          notes: null,
        },
      ],
      hydration: { daily_l_min: 3, daily_l_double_session: 4, electrolyte_recipe: null, notes: null },
      general_notes: ["DIAAS > 0.9", "creatina 5g/dia"],
      // protein_quality, daily_variants, supplement_alternatives, timing_rules, meal_prep,
      // shopping_list, success_indicators intencionalmente OMITIDOS para chequear defaults.
    };
    generateContentMock.mockResolvedValue({
      response: { text: () => JSON.stringify(fakeResponse) },
    });

    const parsed = await parseNutritionPlanFile(Buffer.from("pretend-pdf"), "application/pdf");

    expect(parsed.targets.kcal).toBe(2960);
    expect(parsed.meal_distribution).toHaveLength(1);
    expect(parsed.meal_distribution[0].meal_id).toBe("desayuno");
    // Defaults aplicados:
    expect(parsed.protein_quality).toEqual([]);
    expect(parsed.daily_variants).toEqual([]);
    expect(parsed.supplement_alternatives).toEqual([]);
    expect(parsed.timing_rules).toEqual([]);
    expect(parsed.meal_prep).toEqual([]);
    expect(parsed.shopping_list).toEqual([]);
    expect(parsed.success_indicators).toEqual([]);
    expect(parsed.general_notes).toEqual(["DIAAS > 0.9", "creatina 5g/dia"]);
  });

  it("parsea entrenamiento: defaults para arrays y aliases por ejercicio", async () => {
    const fakeResponse = {
      athlete_summary: {
        name: "Pedrito", age: 21, weight_kg: 70, height_cm: 177,
        active_injuries: ["Aquiles izq", "Menisco lat der"],
      },
      event: { name: "Ironman 5150", date: "2026-10-30", distance: "5150" },
      period: { label: "Fase 1 - Base", weeks: 16, start_month: "abril", end_month: "agosto" },
      coach_name: "Marcos",
      rehab_rules: ["RIR 2-3 siempre", "Excentrica 2-3 seg", "Dolor = parar"],
      days: [
        {
          day_of_week: 1, session_type: "gym", session_name: "Empuje A pesado",
          duration_min: 75, approx_time: "17:00", rationale: null,
          exercises: [
            {
              name: "Press banca c/ mancuernas",
              aliases: ["press banca", "DB bench"],
              sets: 4, reps: "8-10", load_kg: null, rest: "3 min", tempo: null,
              notes: "Excentrica 2 seg", is_rehab: false,
            },
            // Un ejercicio SIN aliases para validar default
            {
              name: "Vuelos laterales", sets: 3, reps: "12-15",
              load_kg: null, rest: "1:30", tempo: null, notes: null, is_rehab: false,
            },
          ],
          volume_total_sets: 22,
        },
      ],
      rehab_protocols: [
        {
          area: "Tendon de Aquiles izq", status: "fase reactiva",
          current_phase: "Isometricos + excentricos bilaterales",
          exercises_summary: "Isom de gemelo 4x30s + escalones bilaterales",
          progression_criteria: ["dolor 0-1/10 por 2 semanas"],
          contraindications: ["correr"],
          citations: ["Rio et al. 2015"],
        },
      ],
      alerts: { stop_signals: ["dolor agudo >4/10"], reduce_signals: ["fatiga acumulada"] },
    };
    generateContentMock.mockResolvedValue({
      response: { text: () => JSON.stringify(fakeResponse) },
    });

    const parsed = await parseTrainingPlanFile(Buffer.from("pretend-pdf"), "application/pdf");

    expect(parsed.days).toHaveLength(1);
    expect(parsed.days[0].exercises[0].aliases).toEqual(["press banca", "DB bench"]);
    // Default aliases [] cuando falta
    expect(parsed.days[0].exercises[1].aliases).toEqual([]);
    expect(parsed.rehab_protocols[0].area).toBe("Tendon de Aquiles izq");
    expect(parsed.alerts.stop_signals).toContain("dolor agudo >4/10");
    // Defaults
    expect(parsed.weekly_structure).toBeDefined();
    expect(parsed.weekly_structure.normal).toEqual([]);
    expect(parsed.general_notes).toEqual([]);
  });

  it("falla con PdfParseError si la IA devuelve algo sin JSON", async () => {
    generateContentMock.mockResolvedValue({
      response: { text: () => "esto no es JSON" },
    });
    await expect(
      parseNutritionPlanFile(Buffer.from("x"), "application/pdf"),
    ).rejects.toBeInstanceOf(PdfParseError);
  });

  it("falla con PdfParseError si la IA tira un error de red", async () => {
    generateContentMock.mockRejectedValue(new Error("network down"));
    await expect(
      parseTrainingPlanFile(Buffer.from("x"), "application/pdf"),
    ).rejects.toBeInstanceOf(PdfParseError);
  });

  it("detecta truncamiento (finishReason MAX_TOKENS) y rechaza sin intentar JSON.parse", async () => {
    // Salida truncada: el modelo se quedo sin tokens y corto la respuesta a la mitad.
    generateContentMock.mockResolvedValue({
      response: {
        text: () => '{"athlete_summary":{"name":"Pedrito"},"targets":{"kcal":2960,"protei',
        candidates: [{ finishReason: "MAX_TOKENS" }],
      },
    });
    await expect(
      parseNutritionPlanFile(Buffer.from("x"), "application/pdf"),
    ).rejects.toMatchObject({
      name: "PdfParseError",
      message: expect.stringContaining("MAX_TOKENS"),
    });
  });

  it("aplica defaults aun si Gemini omite secciones criticas (targets, athlete_summary)", async () => {
    // Gemini hallucina y omite secciones enteras; el saneamiento las completa.
    generateContentMock.mockResolvedValue({
      response: {
        text: () => '{"diagnosis":"comia 2 veces"}',
        candidates: [{ finishReason: "STOP" }],
      },
    });
    const parsed = await parseNutritionPlanFile(Buffer.from("x"), "application/pdf");
    expect(parsed.targets).toEqual({ kcal: null, protein_g: null, carbs_g: null, fat_g: null });
    expect(parsed.athlete_summary.name).toBeNull();
    expect(parsed.meal_distribution).toEqual([]);
    expect(parsed.hydration.daily_l_min).toBeNull();
  });
});
