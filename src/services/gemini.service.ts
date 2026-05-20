import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { DailySummaryRow } from "../repositories/daily.repo.js";
import { aiNluResponseSchema, type AiNluResponse } from "../schemas/bot.schema.js";
import { canUseAiNlu, recordAiNluUse } from "./ai-budget.service.js";

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

const flash = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
});

const flashWarm = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { temperature: 0.9, maxOutputTokens: 600 },
});

// Adaptador NLU: temperature 0 para determinismo, JSON forzado, budget chico
// porque corre en cada mensaje de baja confianza del classifier.
const flashNlu = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0,
    maxOutputTokens: 256,
    responseMimeType: "application/json",
  },
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
// NLU ADAPTER — traductor "mensaje sucio del user" → intent + entities
//
// Corre cuando el classifier local quedo con confidence < 0.7. Su unico
// trabajo es estructurar el texto en un JSON predecible que el router
// pueda despachar igual que si lo hubiera resuelto el classifier local.
// NUNCA inventa entidades ni intents fuera del catalogo.
// ════════════════════════════════════════════════════════════

const NLU_TIMEOUT_MS = 8000;
const NLU_MAX_INPUT_CHARS = 500;

function nluPrompt(rawText: string): string {
  return `Sos el motor de NLU de Forja, un asistente argentino para atletas por WhatsApp. Recibis el mensaje del atleta (con typos, abreviaciones, modismos rioplatenses, sin puntuacion) y lo traducis a un JSON estructurado para que el backend lo procese de forma determinista.

INTENTS PERMITIDOS (elegi UNO):
- command_help: pide ayuda / menu / "que podes hacer"
- command_baja: pide darse de baja / cancelar cuenta
- command_perfil: pide ver su perfil / sus datos
- greeting: saluda ("hola", "buenas", "que onda")
- gratitude: agradece ("gracias", "grcs")
- affirmation: confirma ("si", "dale", "joya", "perfecto")
- negation: niega ("no", "negativo")
- correction: pide corregir algo previo ("esta mal", "cambialo", "borra")
- numeric: respuesta numerica suelta (RPE, sueño, dolor de 0 a 10)
- training_complete: dice que termino un entrenamiento ("hice piernas", "termine el running")
- training_skip: dice que NO entrena hoy
- training_query: pregunta que entrenamiento le toca
- meal_log: registra una comida ("comi 200g de pollo")
- nutrition_query: pregunta sobre macros consumidos / faltantes
- progress_query: pregunta como va su semana / score
- disruption_injury: reporta una lesion
- disruption_illness: reporta enfermedad
- disruption_desliz: reporta atracon / desliz alimentario
- unknown: no se entiende o no encaja en lo anterior

REGLAS:
1. standardized_text: el mensaje normalizado en español argentino estandar, sin emojis, sin abreviaciones de WhatsApp, sin typos. Corto y canonico.
2. entities.activity: SOLO si intent=training_complete, extrae el nombre del entrenamiento (ej "piernas", "pecho", "running"). Si no lo dice, null.
3. entities.value: SOLO si intent=numeric, el numero entero detectado. Si no, null.
4. entities.raw_food_input: SOLO si intent=meal_log, la version limpia del texto de comida (cantidades + alimentos), sin verbos ni saludos. Si no, null.
5. entities.macro_target: SOLO si intent=nutrition_query y se identifica un macro, uno de: "kcal", "protein", "carbs", "fat". Si pregunta general, null.
6. entities.description: SOLO si intent es disruption_*, resumen corto de la situacion (lesion/enfermedad/desliz). Si no, null.
7. Si no entendes el mensaje, intent="unknown" y standardized_text es el input original recortado.
8. NO inventes informacion. NO uses intents que no estan en la lista.

Mensaje del atleta:
"""
${rawText}
"""

Devolve SOLO un objeto JSON con esta forma exacta (sin markdown, sin texto extra):
{
  "intent": "<uno de los intents>",
  "standardized_text": "<texto normalizado>",
  "entities": {
    "activity": <string o null>,
    "value": <number o null>,
    "raw_food_input": <string o null>,
    "macro_target": <"kcal"|"protein"|"carbs"|"fat" o null>,
    "description": <string o null>
  }
}`;
}

/**
 * Adaptador NLU del bot. Devuelve null si:
 *   - el user agoto su budget diario de NLU
 *   - el input es vacio o demasiado largo
 *   - Gemini timeout (>2s) o error de red
 *   - la respuesta no parsea / no valida contra el schema
 *
 * En cualquiera de esos casos el caller (router) debe caer al classifier
 * local sin reportar nada al usuario.
 */
export async function parseUserMessage(
  rawText: string,
  userId: string,
): Promise<AiNluResponse | null> {
  const text = rawText.trim();
  if (!text || text.length > NLU_MAX_INPUT_CHARS) return null;
  if (!canUseAiNlu(userId)) {
    logger.debug("nlu budget exhausted, skipping", { userId });
    return null;
  }

  recordAiNluUse(userId);

  const started = Date.now();
  try {
    const raw = await Promise.race([
      flashNlu.generateContent(nluPrompt(text)).then((r) => r.response.text()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("nlu_timeout")), NLU_TIMEOUT_MS),
      ),
    ]);

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("no json in nlu response");
      json = JSON.parse(m[0]);
    }

    const parsed = aiNluResponseSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("nlu response failed zod validation", {
        userId,
        issues: parsed.error.issues.slice(0, 3),
        sample: raw.slice(0, 200),
      });
      return null;
    }

    logger.debug("nlu ok", {
      userId,
      intent: parsed.data.intent,
      latency_ms: Date.now() - started,
    });
    return parsed.data;
  } catch (err) {
    const msg = (err as Error)?.message ?? "unknown";
    logger.warn("nlu failed, falling back to local classifier", {
      userId,
      latency_ms: Date.now() - started,
      reason: msg,
    });
    return null;
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
