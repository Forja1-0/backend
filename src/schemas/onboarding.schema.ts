import { z } from "zod";
import { env } from "../config/env.js";

const AMATEUR = env.FORJA_MODE === "amateur";

// ── Step 1: Datos personales → users ──────────────────────
// Email obligatorio (es identificador unico).
// phone_wa opcional aca; se completa en paso de conexion WA.
export const step1Schema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email().max(200),
  age: z.number().int().min(16).max(100),
  sex: z.enum(["M", "F", "X"]),
  weight_kg: z.number().min(30).max(200),
  height_cm: z.number().min(120).max(230),
  body_fat_pct: z.number().min(1).max(60).nullable().optional(),
  phone_wa: z.string().min(8).max(20).nullable().optional(),
});

// ── Step 2: Historia clínica → medical_history ────────────
const activeInjurySchema = z.object({
  description: z.string().max(300),
  location: z.string().max(100),
  pain_level: z.number().int().min(0).max(10),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  in_treatment: z.boolean(),
});

const pastInjurySchema = z.object({
  description: z.string().max(300),
  type: z.string().max(100).nullable().optional(),
  year: z.number().int().min(1950).max(new Date().getFullYear()),
});

const medicationSchema = z.object({
  name: z.string().max(100),
  dose: z.string().max(100),
  schedule: z.string().max(100),
});

export const step2Schema = z.object({
  active_injuries: z.array(activeInjurySchema).max(10).default([]),
  past_injuries: z.array(pastInjurySchema).max(10).default([]),
  chronic_conditions: z.array(z.string().max(100)).max(20).default([]),
  allergies: z.array(z.string().max(100)).max(20).default([]),
  medications: z.array(medicationSchema).max(20).default([]),
  ecg_file_url: z.string().url().max(500).nullable().optional(),
  xray_file_url: z.string().url().max(500).nullable().optional(),
  blood_work_url: z.string().url().max(500).nullable().optional(),
  medical_clearance_url: z.string().url().max(500).nullable().optional(),
});

// ── Step 3: Objetivo deportivo → goals ────────────────────
// Soporta dos shapes:
//   ELITE → event_type ∈ competition|recomp|performance (event_date obligatorio).
//   AMATEUR → event_type = personal_goal con goal_kind + goal_metric dinamico.
//
// El modo del deployment (FORJA_MODE) decide cual default-ear, pero el
// schema acepta ambos shapes en cualquier modo — eso permite migrar un
// usuario de elite a amateur (o al reves) sin cambiar la API.
const eventDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const goalMetricUnit = z.enum(["kg", "km", "min", "reps", "percent", "custom"]);

export const step3Schema = z.object({
  event_type: z.enum(["competition", "recomp", "performance", "personal_goal"]),
  event_name: z.string().max(200).nullable().optional(),
  event_date: AMATEUR
    ? eventDateSchema.nullable().optional()
    : eventDateSchema.optional(),
  distance: z.string().max(100).nullable().optional(),
  objective_notes: z.string().max(500).nullable().optional(),
  // ── Campos amateur (personal_goal). NULL para metas elite clasicas.
  goal_kind: z
    .enum(["lose_weight", "gain_muscle", "improve_time", "reach_distance", "custom"])
    .nullable()
    .optional(),
  goal_metric_value: z.number().min(0).max(10000).nullable().optional(),
  goal_metric_unit: goalMetricUnit.nullable().optional(),
  goal_metric_label: z.string().max(200).nullable().optional(),
}).superRefine((d, ctx) => {
  if (d.event_type === "competition") {
    if (!d.event_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["event_name"],
        message: "competition requires event_name",
      });
    }
    if (!d.event_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["event_date"],
        message: "competition requires event_date",
      });
    }
  }
  if (d.event_type === "personal_goal") {
    if (!d.goal_kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["goal_kind"],
        message: "personal_goal requires goal_kind",
      });
    }
    if (d.goal_kind === "custom" && !d.goal_metric_label) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["goal_metric_label"],
        message: "custom goal requires goal_metric_label",
      });
    }
  } else if (!AMATEUR && !d.event_date) {
    // Elite + no personal_goal → event_date obligatorio.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["event_date"],
      message: "event_date required in elite mode",
    });
  }
});

// ── Step 4: Plan nutricional → nutrition_plans ────────────
// En amateur, todos los target_* pueden ser 0 (el usuario decide saltar).
const kcalMin = AMATEUR ? 0 : 800;
export const step4Schema = z.object({
  target_kcal: z.number().int().min(kcalMin).max(8000),
  target_protein_g: z.number().int().min(0),
  target_carbs_g: z.number().int().min(0),
  target_fat_g: z.number().int().min(0),
  meal_distribution: z.record(z.string(), z.unknown()).nullable().optional(),
  nutritionist_name: z.string().max(200).nullable().optional(),
  plan_file_url: z.string().url().max(500).nullable().optional(),
});

// ── Step 5: Restricciones alimentarias → dietary_restrictions ──
export const step5Schema = z.object({
  no_beef: z.boolean().default(false),
  no_chicken: z.boolean().default(false),
  no_pork: z.boolean().default(false),
  no_fish: z.boolean().default(false),
  no_dairy: z.boolean().default(false),
  no_eggs: z.boolean().default(false),
  vegan: z.boolean().default(false),
  vegetarian: z.boolean().default(false),
  celiac: z.boolean().default(false),
  lactose_intolerant: z.boolean().default(false),
  other: z.string().max(500).nullable().optional(),
});

// ── Step 6: Plan de entrenamiento semanal → training_plans ──
const exerciseSchema = z.object({
  name: z.string().min(1).max(100),
  aliases: z.array(z.string().min(1).max(50)).max(10).default([]),
  sets: z.number().int().min(1).max(30).nullable().optional(),
  reps: z.string().max(30).nullable().optional(),
  load_kg: z.number().min(0).max(1000).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const trainingDaySchema = z.object({
  day_of_week: z.number().int().min(0).max(6), // 0=domingo
  session_type: z.string().min(1).max(50),
  session_name: z.string().max(200).nullable().optional(),
  approx_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  duration_min: z.number().int().min(1).max(480).nullable().optional(),
  exercises: z.array(exerciseSchema).max(30).nullable().optional(),
});

// En amateur, training_days puede venir vacio (no hay plan estructurado).
const trainingDaysMin = AMATEUR ? 0 : 1;
export const step6Schema = z.object({
  training_days: z.array(trainingDaySchema).min(trainingDaysMin).max(14),
  coach_name: z.string().max(200).nullable().optional(),
});

// ── Parser de plan: input es el texto crudo del coach ──
export const parseTrainingPlanSchema = z.object({
  text: z.string().min(10).max(8000),
});
export type ParseTrainingPlanInput = z.infer<typeof parseTrainingPlanSchema>;

// ── Step 7: Comidas frecuentes → frequent_meals ───────────
const ingredientSchema = z.object({
  food_item_id: z.string().uuid().nullable().optional(),
  name: z.string().max(200),
  grams: z.number().min(1).max(5000),
  kcal: z.number().min(0),
  protein_g: z.number().min(0),
  carbs_g: z.number().min(0),
  fat_g: z.number().min(0),
});

const frequentMealSchema = z.object({
  alias: z.string().min(1).max(100),
  ingredients: z.array(ingredientSchema).min(1).max(20),
  total_kcal: z.number().int().min(0),
  total_protein_g: z.number().min(0),
  total_carbs_g: z.number().min(0),
  total_fat_g: z.number().min(0),
});

// En amateur, comidas frecuentes opcionales (lista vacia ok).
const mealsMin = AMATEUR ? 0 : 1;
export const step7Schema = z.object({
  meals: z.array(frequentMealSchema).min(mealsMin).max(30),
});

// ── Consent → consents ────────────────────────────────────
export const consentSchema = z.object({
  data_processing: z.literal(true, {
    errorMap: () => ({ message: "Must accept data processing consent" }),
  }),
  international_transfer: z.literal(true, {
    errorMap: () => ({ message: "Must accept international transfer consent" }),
  }),
  nutrition_disclaimer: z.literal(true, {
    errorMap: () => ({ message: "Must accept nutrition disclaimer" }),
  }),
});

// ── Types ─────────────────────────────────────────────────
export type Step1Data = z.infer<typeof step1Schema>;
export type Step2Data = z.infer<typeof step2Schema>;
export type Step3Data = z.infer<typeof step3Schema>;
export type Step4Data = z.infer<typeof step4Schema>;
export type Step5Data = z.infer<typeof step5Schema>;
export type Step6Data = z.infer<typeof step6Schema>;
export type Step7Data = z.infer<typeof step7Schema>;
export type ConsentData = z.infer<typeof consentSchema>;

// Validacion dinamica por numero de paso.
export const stepSchemas: Record<number, z.ZodType> = {
  1: step1Schema,
  2: step2Schema,
  3: step3Schema,
  4: step4Schema,
  5: step5Schema,
  6: step6Schema,
  7: step7Schema,
};
