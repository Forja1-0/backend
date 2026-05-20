import { z } from "zod";

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

export const aiNluEntitiesSchema = z.object({
  activity: z.string().min(1).nullable().optional(),
  value: z.number().nullable().optional(),
  raw_food_input: z.string().min(1).nullable().optional(),
  macro_target: z.enum(["kcal", "protein", "carbs", "fat"]).nullable().optional(),
  description: z.string().min(1).nullable().optional(),
});

export const aiNluResponseSchema = z.object({
  intent: aiNluIntentSchema,
  standardized_text: z.string().min(1),
  entities: aiNluEntitiesSchema.default({}),
});

export type AiNluIntent = z.infer<typeof aiNluIntentSchema>;
export type AiNluEntities = z.infer<typeof aiNluEntitiesSchema>;
export type AiNluResponse = z.infer<typeof aiNluResponseSchema>;
