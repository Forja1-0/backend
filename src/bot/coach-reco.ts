/**
 * Orquesta el recomendador de comidas (coach v2): combina la lógica pura
 * (coach.ts) con el acceso a food_items (food.repo). Lo usan meal.handler
 * y query.handler para no duplicar el armado.
 */

import {
  buildFoodSuggestions,
  chooseRecoMacro,
  type CoachAssessment,
} from "./personality/coach.js";
import type { CoachReco } from "./personality/templates.js";
import * as foodRepo from "../repositories/food.repo.js";
import { logger } from "../config/logger.js";

/**
 * Dada la evaluación del día, devuelve la recomendación de comida para el
 * macro más atrasado, o null si no hay nada útil que sugerir (o si ya te
 * pasaste de kcal). No tira: ante error de DB devuelve null y loguea.
 */
export async function buildCoachReco(
  assessment: CoachAssessment,
): Promise<CoachReco | null> {
  const macro = chooseRecoMacro(assessment);
  if (!macro) return null;

  try {
    const foods = await foodRepo.getMacroRichFoods(macro);
    const suggestions = buildFoodSuggestions(
      macro,
      assessment.macros[macro].remaining,
      assessment.macros.kcal.remaining,
      foods,
    );
    if (suggestions.length === 0) return null;
    return { macro, remaining: assessment.macros[macro].remaining, suggestions };
  } catch (err) {
    logger.error("coach reco failed", { err, macro });
    return null;
  }
}
