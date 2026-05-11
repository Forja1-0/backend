import { z } from 'zod';

// ── Step 1: Datos personales ──────────────────────────────
export const step1Schema = z.object({
  name: z.string().min(2).max(100),
  age: z.number().int().min(16).max(80),
  sex: z.enum(['male', 'female', 'other']),
  weight_kg: z.number().min(30).max(200),
  height_cm: z.number().min(120).max(230),
  body_fat_pct: z.number().min(3).max(60).nullable().optional(),
});

// ── Step 2: Historia clínica ──────────────────────────────
const injurySchema = z.object({
  description: z.string().max(300),
  location: z.string().max(100),
  pain_level: z.number().int().min(0).max(10),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  in_treatment: z.boolean(),
});

const prevInjurySchema = z.object({
  description: z.string().max(300),
  year: z.number().int().min(2020).max(2030),
});

const medicationSchema = z.object({
  name: z.string().max(100),
  dose: z.string().max(100),
  schedule: z.string().max(100),
});

export const step2Schema = z.object({
  active_injuries: z.array(injurySchema).max(10).default([]),
  previous_injuries: z.array(prevInjurySchema).max(10).default([]),
  chronic_conditions: z.array(z.string().max(100)).max(10).default([]),
  food_allergies: z.array(z.string().max(100)).max(10).default([]),
  medications: z.array(medicationSchema).max(10).default([]),
});

// ── Step 3: Objetivo deportivo ────────────────────────────
export const step3Schema = z.object({
  goal_type: z.enum(['race', 'recomp', 'performance']),
  event_name: z.string().max(200).nullable().optional(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  distance: z.string().max(100).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
}).refine(
  (d) => d.goal_type !== 'race' || (d.event_name && d.event_date),
  { message: 'Race goals require event_name and event_date' }
);

// ── Step 4: Plan nutricional ──────────────────────────────
export const step4Schema = z.object({
  target_kcal: z.number().int().min(800).max(8000),
  target_protein_g: z.number().int().min(20).max(500),
  target_carbs_g: z.number().int().min(20).max(800),
  target_fat_g: z.number().int().min(10).max(300),
  meal_distribution: z.record(z.string(), z.number()).nullable().optional(),
  nutritionist_name: z.string().max(200).nullable().optional(),
});

// ── Step 5: Restricciones alimentarias ────────────────────
export const step5Schema = z.object({
  no_beef: z.boolean().default(false),
  no_chicken: z.boolean().default(false),
  no_pork: z.boolean().default(false),
  no_fish: z.boolean().default(false),
  no_dairy: z.boolean().default(false),
  no_egg: z.boolean().default(false),
  vegan: z.boolean().default(false),
  vegetarian: z.boolean().default(false),
  celiac: z.boolean().default(false),
  lactose_intolerant: z.boolean().default(false),
  other: z.string().max(500).nullable().optional(),
});

// ── Step 6: Plan de entrenamiento semanal ─────────────────
const trainingDaySchema = z.object({
  day_of_week: z.number().int().min(0).max(6), // 0=domingo
  session_type: z.enum(['gym', 'swim', 'bike', 'run', 'rest', 'cross', 'other']),
  session_name: z.string().max(200),
  approx_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  duration_min: z.number().int().min(0).max(480).nullable().optional(),
});

export const step6Schema = z.object({
  training_days: z.array(trainingDaySchema).min(1).max(14),
  coach_name: z.string().max(200).nullable().optional(),
});

// ── Step 7: Comidas frecuentes ────────────────────────────
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
  total_protein_g: z.number().int().min(0),
  total_carbs_g: z.number().int().min(0),
  total_fat_g: z.number().int().min(0),
});

export const step7Schema = z.object({
  meals: z.array(frequentMealSchema).min(1).max(30),
});

// ── Consent ───────────────────────────────────────────────
export const consentSchema = z.object({
  data_processing: z.literal(true, {
    errorMap: () => ({ message: 'Must accept data processing consent' }),
  }),
  international_transfer: z.literal(true, {
    errorMap: () => ({ message: 'Must accept international transfer consent' }),
  }),
  nutrition_disclaimer: z.literal(true, {
    errorMap: () => ({ message: 'Must accept nutrition disclaimer' }),
  }),
});

// ── Type exports ──────────────────────────────────────────
export type Step1Data = z.infer<typeof step1Schema>;
export type Step2Data = z.infer<typeof step2Schema>;
export type Step3Data = z.infer<typeof step3Schema>;
export type Step4Data = z.infer<typeof step4Schema>;
export type Step5Data = z.infer<typeof step5Schema>;
export type Step6Data = z.infer<typeof step6Schema>;
export type Step7Data = z.infer<typeof step7Schema>;
export type ConsentData = z.infer<typeof consentSchema>;

// Schema map for dynamic validation in the route
export const stepSchemas: Record<number, z.ZodType> = {
  1: step1Schema,
  2: step2Schema,
  3: step3Schema,
  4: step4Schema,
  5: step5Schema,
  6: step6Schema,
  7: step7Schema,
};
