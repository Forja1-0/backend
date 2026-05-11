import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

/**
 * Modelo rápido para el parseo de comidas y respuestas del bot.
 * Temperatura baja para resultados estructurados y consistentes.
 */
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: {
    temperature: 0.2,
    maxOutputTokens: 1024,
  },
});

/**
 * Genera texto libre con Gemini Flash.
 */
export async function generateText(prompt: string): Promise<string> {
  const result = await model.generateContent(prompt);
  return result.response.text();
}

/**
 * Parsea una descripción libre de comida y devuelve una lista estructurada
 * de ítems con sus macros estimados.
 *
 * Retorna null si Gemini no puede parsear el texto.
 */
export interface ParsedFoodItem {
  name: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  is_estimate: boolean;
}

export async function parseMealText(
  rawText: string,
): Promise<ParsedFoodItem[] | null> {
  const prompt = `Sos un nutricionista deportivo argentino. El atleta dijo: "${rawText}"

Extraé cada alimento mencionado y estimá sus macros. Si no se menciona cantidad, usá una porción típica argentina.

Respondé SOLO con JSON válido, sin texto adicional, con este formato exacto:
[
  {
    "name": "nombre del alimento",
    "grams": número,
    "kcal": número,
    "protein_g": número,
    "carbs_g": número,
    "fat_g": número,
    "is_estimate": true
  }
]

Si el texto no describe ninguna comida, respondé con: []`;

  try {
    const raw = await generateText(prompt);
    // Extraemos el JSON aunque venga envuelto en markdown
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as ParsedFoodItem[];
  } catch (err) {
    logger.error("gemini parseMealText failed", { err, rawText });
    return null;
  }
}
