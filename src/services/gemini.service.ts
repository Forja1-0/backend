import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { DailySummaryRow } from "../repositories/daily.repo.js";

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

const flash = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
});

const flashWarm = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { temperature: 0.9, maxOutputTokens: 600 },
});

export async function generateText(prompt: string): Promise<string> {
  const r = await flash.generateContent(prompt);
  return r.response.text();
}

// ════════════════════════════════════════════════════════════
// SPLIT DE COMIDA (NLU — fallback del meal-parser)
//
// La AI SOLO separa el texto libre en items con cantidad. NUNCA
// estima macros: la fuente de verdad es food_items (SARA2) +
// food_portions. La AI es un intermediario para buscar mejor.
// ════════════════════════════════════════════════════════════
export interface SplitMealItem {
  /** alimento "crudo" tal como lo dijo el usuario (sin cantidad). */
  food: string;
  /** número detectado, o null si no dijo cantidad. */
  qty: number | null;
  /** 'g' = gramos · 'units' = unidades contables · 'measure' = medida casera · null */
  unit: "g" | "units" | "measure" | null;
  /** solo si unit='measure': "plato" | "feta" | "cucharada" | ... */
  measure: string | null;
  /** estado si el usuario lo dijo, si no null. */
  state: "crudo" | "cocido" | null;
}

export async function splitMealText(rawText: string): Promise<SplitMealItem[] | null> {
  const prompt = `Sos un parser de mensajes de comida de atletas argentinos. Tu ÚNICO trabajo es SEPARAR el texto en alimentos individuales con su cantidad. NO estimes calorías ni macros — eso lo resuelve otra parte del sistema con una base de datos.

Mensaje del atleta: "${rawText}"

Devolvé SOLO JSON válido (sin markdown, sin texto extra), un array donde cada item es:
[
  {
    "food": "nombre simple del alimento, sin cantidad ni verbo (ej: 'milanesa', 'huevo', 'arroz')",
    "qty": número o null si no dijo cantidad,
    "unit": "g" si dijo gramos/kg | "units" si son unidades contables (2 milanesas, 3 huevos) | "measure" si dijo una medida casera (un plato, 2 fetas) | null si no hay cantidad,
    "measure": "plato"|"feta"|"cucharada"|"taza"|"vaso"|"pote"|"rodaja"|"porcion"|null,
    "state": "crudo"|"cocido"|null (solo si lo dijo explícitamente)
  }
]

REGLAS:
- Separá "y", "con", "+", comas en items distintos. "milanesa de vaca" es UN item (no separar "de").
- Conservá la variedad si la dijo: "milanesa de cerdo" → food: "milanesa de cerdo".
- NO inventes alimentos que no mencionó. NO agregues macros.
- "2 milanesas" → qty 2, unit "units". "200g de arroz" → qty 200, unit "g". "un plato de fideos" → qty 1, unit "measure", measure "plato".
- Si no hay ninguna comida, devolvé [].`;

  try {
    const raw = await generateText(prompt);
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as SplitMealItem[];
  } catch (err) {
    logger.error("gemini splitMealText failed", {
      message: (err as any)?.message,
      status: (err as any)?.status,
      statusText: (err as any)?.statusText,
      errorDetails: (err as any)?.errorDetails,
      rawText,
    });
    return null;
  }
}

/**
 * Self-check de Gemini al arrancar el proceso. Loguea OK o el motivo del fallo
 * para detectar key invalida o modelo retirado sin esperar al primer mensaje.
 */
export async function pingGemini(): Promise<boolean> {
  try {
    const r = await flash.generateContent("Respondé con la palabra OK y nada mas.");
    const text = r.response.text().trim();
    logger.info("gemini ping ok", { sample: text.slice(0, 30) });
    return true;
  } catch (err) {
    logger.error("gemini ping failed — la AI no va a funcionar", {
      message: (err as any)?.message,
      status: (err as any)?.status,
      statusText: (err as any)?.statusText,
    });
    return false;
  }
}

// ════════════════════════════════════════════════════════════
// PARSE DE PLAN DE ENTRENAMIENTO (one-shot en onboarding)
// ════════════════════════════════════════════════════════════
export interface ParsedExercise {
  name: string;
  aliases: string[];
  sets: number | null;
  reps: string | null;
  load_kg: number | null;
  notes: string | null;
}

export interface ParsedTrainingDay {
  day_of_week: number;        // 0 = domingo
  session_type: string;       // gym | natacion | bici | corrida | funcional | crossfit | yoga | descanso | otro
  session_name: string | null;
  duration_min: number | null;
  exercises: ParsedExercise[];
}

export interface ParsedTrainingPlan {
  coach_name: string | null;
  days: ParsedTrainingDay[];
}

const MAX_PLAN_INPUT_CHARS = 8000;

export async function parseTrainingPlan(rawText: string): Promise<ParsedTrainingPlan | null> {
  const text = rawText.slice(0, MAX_PLAN_INPUT_CHARS).trim();
  if (text.length < 10) return null;

  const prompt = `Sos un preparador fisico argentino. Te paso el plan de entrenamiento de un atleta tal como se lo paso su coach. Tu trabajo es estructurarlo en JSON.

PLAN:
"""
${text}
"""

Devolve SOLO JSON valido (sin texto antes ni despues, sin markdown fences), con este formato:

{
  "coach_name": "string o null si no se menciona",
  "days": [
    {
      "day_of_week": 0,
      "session_type": "gym",
      "session_name": "Piernas A o null",
      "duration_min": 60,
      "exercises": [
        {
          "name": "Sentadilla",
          "aliases": ["sentadillas", "back squat", "squat"],
          "sets": 4,
          "reps": "8-10",
          "load_kg": null,
          "notes": null
        }
      ]
    }
  ]
}

REGLAS:
- day_of_week: 0=domingo, 1=lunes, 2=martes, 3=miercoles, 4=jueves, 5=viernes, 6=sabado.
- session_type: usa SOLO uno de: gym, natacion, bici, corrida, funcional, crossfit, yoga, movilidad, descanso, otro.
- aliases: variantes en argentino que el atleta pueda usar al hablar (slang, abreviaciones, ingles, sinonimos). Minimo 1 alias, idealmente 2-3.
- sets/reps/load_kg/notes: usa null si no se menciona en el plan.
- Si un dia es descanso, dejar exercises: [].
- Si el plan no especifica que dia de la semana es cada sesion, asume Lunes/Miercoles/Viernes para 3 dias, Lunes/Martes/Jueves/Viernes para 4 dias, etc.
- Si no podes entender nada del plan, devolve {"coach_name": null, "days": []}.`;

  try {
    const raw = await generateText(prompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn("gemini parseTrainingPlan: no JSON in response", { sample: raw.slice(0, 200) });
      return null;
    }
    const parsed = JSON.parse(jsonMatch[0]) as ParsedTrainingPlan;
    if (!Array.isArray(parsed.days)) return null;
    return parsed;
  } catch (err) {
    logger.error("gemini parseTrainingPlan failed", {
      message: (err as any)?.message,
      status: (err as any)?.status,
      statusText: (err as any)?.statusText,
      errorDetails: (err as any)?.errorDetails,
    });
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// RESUMEN NOCTURNO (mensaje warm/personalizado)
// ════════════════════════════════════════════════════════════
export interface NightlySummaryInput {
  name: string | null;
  nutrition_ok: boolean;
  sleep: number;
  pain: number;
  summary: DailySummaryRow;
}

/**
 * Genera el mensaje de cierre del dia. Tono argentino, calido, breve.
 * Distinto cada vez. Tolera datos incompletos (sin plan, sin training).
 */
export async function generateNightlySummary(d: NightlySummaryInput): Promise<string> {
  const firstName = d.name?.split(" ")[0] ?? "atleta";
  const score = d.summary.performance_score;
  const kcal = d.summary.total_kcal;
  const kcalAdh = d.summary.kcal_adherence_pct;
  const proteinAdh = d.summary.protein_adherence_pct;
  const trained = d.summary.training_completed;
  const rpe = d.summary.training_rpe;

  const dataLines = [
    `nombre: ${firstName}`,
    `cumplio plan nutricional: ${d.nutrition_ok ? "si" : "no"}`,
    `sueno (1-5): ${d.sleep}`,
    `dolor (0-10): ${d.pain}`,
    kcal ? `kcal consumidas: ${kcal}` : "kcal: sin registros",
    kcalAdh != null ? `adherencia kcal: ${Math.round(kcalAdh)}%` : null,
    proteinAdh != null ? `adherencia proteina: ${Math.round(proteinAdh)}%` : null,
    trained != null ? `entreno hoy: ${trained ? "si" : "no"}` : null,
    rpe != null ? `RPE: ${rpe}/10` : null,
    score != null ? `performance score del dia: ${score}/100` : null,
  ].filter(Boolean).join("\n");

  const prompt = `Sos Forja, un coach argentino que cierra el dia con sus atletas por WhatsApp. Tono: directo, calido, sin azucar, sin diminutivos infantiles. Hablas en argentino ("vos", "dale", "che"), no en espanol neutro. Mensajes cortos (60-120 palabras max).

Datos del dia del atleta:
${dataLines}

Devolveme UN mensaje de cierre nocturno para mandarle por WhatsApp. Reglas:
- Empezar por su nombre cuando suene natural.
- Mencionar 1 o 2 metricas concretas que importen hoy (no listar todo).
- Si hubo dolor >= 7, sugerir consulta con kine/medico.
- Si durmio mal (<=2), priorizar descanso por sobre rendimiento.
- Si no entreno y no comio bien, sin reto: alentar a manana.
- Si score >= 80, celebrar pero sin exagerar.
- Cerrar con una frase corta de aliento o conexion.
- NO usar bullets ni markdown excesivo. Texto fluido, parrafo o dos.
- Variar el comienzo (NO empezar siempre con "Hola" o el nombre).
- NO inventar datos que no esten arriba.

Mensaje:`;

  try {
    const r = await flashWarm.generateContent(prompt);
    return r.response.text().trim();
  } catch (err) {
    logger.error("gemini nightly summary failed", { err });
    return `Cerramos el día, ${firstName}. ${score != null ? `Score ${score}/100. ` : ""}Mañana seguimos. 💪`;
  }
}
