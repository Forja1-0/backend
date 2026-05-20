import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
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

// Adaptador NLU: temperature 0 para determinismo, JSON forzado via schema
// (el SDK valida la estructura), corre en CADA mensaje del bot — el
// classifier local quedo de rescate cuando la AI falla o devuelve unknown.
//
// El responseSchema replica aiNluResponseSchema (Zod) en formato JSON-Schema
// del SDK. Si cambia el Zod, hay que cambiar este tambien.
const NLU_INTENTS = [
  "command_help", "command_baja", "command_perfil",
  "greeting", "gratitude", "affirmation", "negation", "correction",
  "numeric",
  "training_complete", "training_skip", "training_query",
  "meal_log", "nutrition_query", "progress_query",
  "disruption_injury", "disruption_illness", "disruption_desliz",
  "unknown",
];

const flashNlu = genAI.getGenerativeModel({
  // gemini-2.5-flash con thinking deshabilitado (thinkingBudget: 0). El
  // thinking por default consume tokens y agrega 5-8s de latencia —
  // intolerable para un dispatcher que corre en cada mensaje.
  //
  // 2.5-flash-lite seria mas barato pero al momento de implementar esto
  // estaba saturado (503 frecuentes). 2.5-flash es mas estable.
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0,
    maxOutputTokens: 512,
    // thinkingConfig no esta en los types del SDK 0.21 pero el endpoint
    // lo acepta y devuelve respuesta sin thinking. Casteo para pasarlo.
    ...({ thinkingConfig: { thinkingBudget: 0 } } as object),
    responseMimeType: "application/json",
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        intent: { type: SchemaType.STRING, enum: NLU_INTENTS },
        standardized_text: { type: SchemaType.STRING },
        entities: {
          type: SchemaType.OBJECT,
          properties: {
            activity: { type: SchemaType.STRING, nullable: true },
            value: { type: SchemaType.NUMBER, nullable: true },
            raw_food_input: { type: SchemaType.STRING, nullable: true },
            // No usamos enum en macro_target porque combinarlo con nullable
            // a veces hace que Gemini ignore el responseSchema entero y
            // devuelva texto libre. El Zod en el caller valida los valores.
            macro_target: { type: SchemaType.STRING, nullable: true },
            description: { type: SchemaType.STRING, nullable: true },
          },
        },
      },
      required: ["intent", "standardized_text", "entities"],
    },
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
 *
 * Tambien hace un warmup del modelo NLU: el primer hit del proceso suele
 * tardar 6-8s por cold start del HTTP pool, lo que dispara timeouts en el
 * primer mensaje real del user. Llamarlo aca lo paga el server, no el atleta.
 */
export async function pingGemini(): Promise<boolean> {
  try {
    const r = await flash.generateContent("Respondé con la palabra OK y nada mas.");
    const text = r.response.text().trim();
    logger.info("gemini ping ok", { sample: text.slice(0, 30) });

    // Warmup del NLU. fire-and-forget: si falla, el primer mensaje del user
    // paga el cold start; si va bien, queda caliente.
    void flashNlu
      .generateContent(nluPrompt("hola"))
      .then(() => logger.info("gemini nlu warmup ok"))
      .catch((err) => logger.warn("gemini nlu warmup failed", { err: (err as Error).message }));

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

/**
 * Extrae el primer objeto JSON balanceado de un string. Tolera preambles
 * ("Here is the JSON:") y fences markdown (\`\`\`json ... \`\`\`) que Gemini
 * mete a veces aunque tenga responseMimeType=application/json.
 * Devuelve el objeto parseado o null si no hay JSON valido.
 */
function extractJsonObject(raw: string): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* sigue */ }
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function nluPrompt(rawText: string): string {
  // Prompt deliberadamente corto: los intents validos vienen forzados por
  // responseSchema (enum), no hace falta listarlos en texto. Solo damos
  // las reglas que no se infieren del schema.
  return `Clasifica el mensaje de un atleta argentino de WhatsApp (puede tener typos/modismos/abreviaciones) segun el schema.

Reglas:
- standardized_text: version canonica en español argentino sin typos ni emojis.
- entities.activity: solo si training_complete (ej "piernas", "pecho", "running"), si no null.
- entities.value: solo si numeric, si no null.
- entities.raw_food_input: solo si meal_log, texto limpio de los alimentos con cantidades sin verbos ("200g pollo y un plato arroz"), si no null.
- entities.macro_target: solo si nutrition_query y se menciona un macro especifico: "kcal"|"protein"|"carbs"|"fat", si no null.
- entities.description: solo si disruption_*, resumen corto, si no null.
- Si no entendes nada, intent="unknown".

Mensaje: "${rawText}"`;
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
  let raw = "";
  try {
    raw = await Promise.race([
      flashNlu.generateContent(nluPrompt(text)).then((r) => r.response.text()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("nlu_timeout")), NLU_TIMEOUT_MS),
      ),
    ]);

    // Gemini 2.5-flash a veces ignora responseMimeType y antepone basura
    // tipo "Here is the JSON:\n" o envuelve en ```json ... ```. Extraemos
    // el primer objeto JSON balanceado del raw.
    const json = extractJsonObject(raw);
    if (!json) throw new Error("no json in nlu response");

    const parsed = aiNluResponseSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("nlu response failed zod validation", {
        userId,
        issues: parsed.error.issues.slice(0, 3),
        sample: raw.slice(0, 300),
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
      raw_sample: raw ? raw.slice(0, 300) : null,
      input: text.slice(0, 120),
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
