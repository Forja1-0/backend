import { z } from "zod";
import { RECIPE_SLUGS } from "../bot/constants/recipe-slugs.js";

// Espejo exacto del Intent canonico declarado en bot/parser/intent-classifier.ts.
// Si agregas un intent alla, agregalo aca tambien.
export const aiNluIntentSchema = z.enum([
  "command_help",
  "command_baja",
  "command_perfil",
  "greeting",
  "gratitude",
  "affirmation",
  "negation",
  "correction",
  "numeric",
  "training_complete",
  "training_skip",
  "training_query",
  "meal_log",
  "nutrition_query",
  "progress_query",
  "disruption_injury",
  "disruption_illness",
  "disruption_desliz",
  "unknown",
]);

// ── INTERPRETER UNIFICADO (un solo round-trip a Gemini) ─────
//
// La AI es PARSER PURO: parte el mensaje, identifica items, hidrata el
// resto el backend. Output minimo: sin texto libre, sin reasoning, sin
// standardized_text, sin entities ricas.
//
// Cada item es UNO de:
//   - recipe:  slug de RECIPE_SLUGS → backend expande recipe_components
//   - food:    alimento simple → backend lo resuelve contra SARA2

export const aiMealItemSchema = z.object({
  // slug ∈ RECIPE_SLUGS si la AI reconoce el plato como receta compuesta;
  // null si es un alimento simple (entonces `food` debe venir poblado).
  slug: z.string().nullable().optional(),
  food: z.string().nullable().optional(),
  qty: z.number().positive().nullable().optional(),
  unit: z.enum(["g", "units", "measure", "portion"]).nullable().optional(),
  measure: z.string().nullable().optional(),
  state: z.enum(["crudo", "cocido"]).nullable().optional(),
}).refine((it) => Boolean(it.slug || it.food), {
  message: "item debe traer slug o food",
});

export const aiInterpretationSchema = z.object({
  intent: aiNluIntentSchema,
  // Poblado SOLO si intent='meal_log'. Para otros intents la AI puede
  // devolver array vacio.
  items: z.array(aiMealItemSchema).default([]),
});

export type AiNluIntent = z.infer<typeof aiNluIntentSchema>;
export type AiMealItem = z.infer<typeof aiMealItemSchema>;
export type AiInterpretation = z.infer<typeof aiInterpretationSchema>;

// Re-export para que el responseSchema del SDK use el mismo enum.
export const RECIPE_SLUG_ENUM = RECIPE_SLUGS as readonly string[];
