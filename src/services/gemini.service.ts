import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { DailySummaryRow } from "../repositories/daily.repo.js";
import {
  aiInterpretationSchema,
  RECIPE_SLUG_ENUM,
  type AiInterpretation,
} from "../schemas/bot.schema.js";
import { canUseAiNlu, recordAiNluUse } from "./ai-budget.service.js";

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

// Modelo "creativo" para el resumen nocturno (varia cada dia).
const flashWarm = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { temperature: 0.9, maxOutputTokens: 600 },
});

// Modelo barato para parser de plan one-shot (no afecta cost del runtime).
const flashStd = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
});

// ════════════════════════════════════════════════════════════
// INTERPRETER — parser puro, una sola call por mensaje del bot.
//
// Estrategia de costo:
//   - Modelo: gemini-2.5-flash-lite (el mas barato de 2.5, sin thinking).
//   - Sin reasoning: thinkingBudget: 0.
//   - Output minimo: solo {intent, items[]}. SIN standardized_text, SIN
//     entities ricas. Los handlers consumen rawText cuando necesitan texto.
//   - Input minimo: prompt de 2 lineas. El responseSchema (enum de intents
//     + enum de slugs) hace el trabajo pesado, no el texto.
//   - maxOutputTokens: 256 (un meal_log con 6 items entra holgado).
//
// La AI es el UNICO intérprete: identifica si el mensaje es comida y, si
// lo es, separa en items (recetas conocidas por slug, o alimentos sueltos).
// El backend hidrata (recipe_components, SARA2). Cero adivinanza de macros.
// ════════════════════════════════════════════════════════════

const INTENT_ENUM = [
  "command_help", "command_baja", "command_perfil",
  "greeting", "gratitude", "affirmation", "negation", "correction",
  "numeric", "weight_log",
  "training_complete", "training_skip", "training_query",
  "meal_log", "nutrition_query", "progress_query",
  "disruption_injury", "disruption_illness", "disruption_desliz",
  "unknown",
];

const flashLite = genAI.getGenerativeModel({
  model: "gemini-2.5-flash-lite",
  generationConfig: {
    temperature: 0,
    maxOutputTokens: 256,
    ...({ thinkingConfig: { thinkingBudget: 0 } } as object),
    responseMimeType: "application/json",
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        intent: { type: SchemaType.STRING, enum: INTENT_ENUM },
        items: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              // slug ∈ RECIPE_SLUG_ENUM si la AI reconoce el plato como
              // receta compuesta; null si es alimento simple.
              slug: { type: SchemaType.STRING, enum: [...RECIPE_SLUG_ENUM], nullable: true },
              food: { type: SchemaType.STRING, nullable: true },
              qty: { type: SchemaType.NUMBER, nullable: true },
              unit: { type: SchemaType.STRING, enum: ["g", "units", "measure", "portion"], nullable: true },
              measure: { type: SchemaType.STRING, nullable: true },
              state: { type: SchemaType.STRING, enum: ["crudo", "cocido"], nullable: true },
            },
          },
        },
      },
      required: ["intent", "items"],
    },
  },
});

const NLU_TIMEOUT_MS = 6000;
const NLU_MAX_INPUT_CHARS = 500;

/**
 * Extrae el primer objeto JSON balanceado de un string. Tolera preambles
 * y fences markdown que el modelo a veces mete aunque tenga responseMimeType.
 */
function extractJsonObject(raw: string): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* sigue */ }
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inString = false, escape = false;
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

// Prompt minimo. El schema (enums de intent y slug) hace cumplir todo lo
// importante; no hace falta repetir reglas en texto.
function interpretPrompt(rawText: string): string {
  return `Mensaje WhatsApp de un atleta argentino: "${rawText}"

Clasifica intent. Si reporta su PESO CORPORAL (ej: "peso 82", "me pesé 79.5", "81 kg"), intent = weight_log (sin items). Si es meal_log, separa en items:
- slug: ID de la receta si el plato compuesto esta en el enum.
- food: nombre simple del alimento si no es receta del enum.
- qty/unit/measure/state: solo si el usuario los dijo.

REGLA CRITICA: Si el usuario menciona un plato y una guarnición, o dos cosas separadas (ej: "fideos con tuco", "pollo con arroz"), DEBES separarlos en MULTIPLES items distintos en el array. NO mezcles dos alimentos en un solo item.`;
}

/**
 * Interprete unico del bot. Llama UNA vez a Gemini y devuelve intent +
 * items. Si falla (timeout, error, budget, JSON invalido), devuelve null
 * y el caller cae al classifier local.
 */
export async function interpretMessage(
  rawText: string,
  userId: string,
): Promise<AiInterpretation | null> {
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
      flashLite.generateContent(interpretPrompt(text)).then((r) => r.response.text()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("nlu_timeout")), NLU_TIMEOUT_MS),
      ),
    ]);
    const json = extractJsonObject(raw);
    if (!json) throw new Error("no json in interpreter response");

    // Limpieza: el SDK no soporta valores nullable + enum bien, asi que
    // mandamos "" como placeholder en los enums. Normalizamos a null.
    if (typeof json === "object" && json !== null && Array.isArray((json as any).items)) {
      for (const it of (json as any).items) {
        for (const k of ["slug", "food", "unit", "measure", "state"]) {
          if (it[k] === "") it[k] = null;
        }
      }
    }

    const parsed = aiInterpretationSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("interpreter response failed zod validation", {
        userId,
        issues: parsed.error.issues.slice(0, 3),
        sample: raw.slice(0, 300),
      });
      return null;
    }
    logger.debug("interpreter ok", {
      userId,
      intent: parsed.data.intent,
      item_count: parsed.data.items.length,
      latency_ms: Date.now() - started,
    });
    return parsed.data;
  } catch (err) {
    logger.warn("interpreter failed, falling back to local classifier", {
      userId,
      latency_ms: Date.now() - started,
      reason: (err as Error)?.message ?? "unknown",
      raw_sample: raw ? raw.slice(0, 300) : null,
      input: text.slice(0, 120),
    });
    return null;
  }
}

/**
 * Self-check + warmup al boot. Llama una vez al interpreter con un mensaje
 * trivial para que el HTTP pool quede caliente y el primer mensaje real
 * del user no pague el cold start de 6-8s.
 */
export async function pingGemini(): Promise<boolean> {
  try {
    const r = await flashStd.generateContent("Respondé con la palabra OK y nada mas.");
    logger.info("gemini ping ok", { sample: r.response.text().trim().slice(0, 30) });
    void flashLite
      .generateContent(interpretPrompt("hola"))
      .then(() => logger.info("gemini interpreter warmup ok"))
      .catch((err) => logger.warn("gemini interpreter warmup failed", { err: (err as Error).message }));
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
  day_of_week: number;
  session_type: string;
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
    const r = await flashStd.generateContent(prompt);
    const raw = r.response.text();
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
export interface NightlySummaryGoal {
  event_type: string;
  event_name?: string | null;
  event_date?: string | null;
  goal_kind?: string | null;
  goal_metric_value?: number | null;
  goal_metric_unit?: string | null;
  goal_metric_label?: string | null;
  objective_notes?: string | null;
}

export interface NightlySummaryInput {
  name: string | null;
  nutrition_ok: boolean;
  sleep: number;
  pain: number;
  summary: DailySummaryRow;
  /** Goal activo del usuario. Null = sin meta (elite legacy). */
  goal?: NightlySummaryGoal | null;
}

function formatGoal(g: NightlySummaryGoal | null | undefined): string | null {
  if (!g) return null;
  if (g.event_type === "personal_goal") {
    if (g.goal_kind === "custom" && g.goal_metric_label) {
      const date = g.event_date ? ` para ${g.event_date}` : "";
      return `meta del usuario: ${g.goal_metric_label}${date}`;
    }
    const kindLabel: Record<string, string> = {
      lose_weight: "perder",
      gain_muscle: "ganar masa muscular",
      improve_time: "mejorar tiempo",
      reach_distance: "alcanzar distancia",
    };
    const action = g.goal_kind ? (kindLabel[g.goal_kind] ?? g.goal_kind) : "objetivo libre";
    const metric = g.goal_metric_value != null && g.goal_metric_unit
      ? ` ${g.goal_metric_value}${g.goal_metric_unit}`
      : "";
    const date = g.event_date ? ` para ${g.event_date}` : "";
    return `meta del usuario: ${action}${metric}${date}`;
  }
  // Elite legacy: competition / recomp / performance.
  if (g.event_name && g.event_date) {
    return `meta del usuario: ${g.event_name} el ${g.event_date}`;
  }
  return g.objective_notes ? `meta del usuario: ${g.objective_notes}` : null;
}

// ════════════════════════════════════════════════════════════
// NUDGE MOTIVADOR ESPONTÁNEO (mensaje suelto, sin que el user escriba)
// ════════════════════════════════════════════════════════════
export interface MotivationNudgeInput {
  name: string | null;
  kind: "morning" | "midday" | "night";
  goal?: NightlySummaryGoal | null;
  progress: {
    dayStreak: number;
    mealsThisWeek: number;
    trainingsThisWeek: number;
    weightLatest: number | null;
    weightDelta: number | null;
    weightCount: number;
  };
}

const NUDGE_KIND_BRIEF: Record<MotivationNudgeInput["kind"], string> = {
  morning:
    'momento: ARRANQUE DEL DÍA (mañana temprano). Energía, intención, "de vos depende cómo arranca hoy". Corto.',
  midday:
    'momento: MITAD DEL DÍA. Recordarle el PORQUÉ de lo que hace, reconectar con la meta. Reflexivo pero breve.',
  night:
    'momento: NOCHE. Cierre cálido, reconocer el esfuerzo del día, "descansá, buen trabajo". Tranquilo.',
};

/**
 * Genera un mensaje motivador espontáneo para mandar por WhatsApp SIN que el
 * usuario haya escrito nada. El color lo da `kind` (mañana/mediodía/noche); el
 * contenido se ancla en la meta + el progreso real (racha, peso). Fallback
 * templated si la AI falla — nunca dejamos al cron sin mensaje.
 */
export async function generateMotivationNudge(d: MotivationNudgeInput): Promise<string> {
  const firstName = d.name?.split(" ")[0] ?? "crack";
  const goalLine = formatGoal(d.goal);
  const p = d.progress;

  const dataLines = [
    `nombre: ${firstName}`,
    goalLine,
    p.dayStreak > 0 ? `racha actual: ${p.dayStreak} días seguidos reportando` : "racha: sin racha activa",
    `comidas reportadas esta semana: ${p.mealsThisWeek}`,
    `entrenos esta semana: ${p.trainingsThisWeek}`,
    p.weightLatest != null ? `peso actual: ${p.weightLatest}kg` : null,
    p.weightDelta != null && p.weightCount >= 2
      ? `cambio de peso desde que arrancó: ${p.weightDelta > 0 ? "+" : ""}${p.weightDelta}kg`
      : null,
  ].filter(Boolean).join("\n");

  const goalRule = goalLine
    ? "- HAY META ACTIVA: conectá el mensaje con esa meta (ej. acercarse al peso objetivo). Empuje suave, nunca sermón."
    : "- Sin meta explícita: motivar el hábito y la constancia.";

  const prompt = `Sos Forja, un coach argentino que motiva a sus atletas por WhatsApp. Le escribís SIN que te hayan escrito: un mensaje espontáneo, como un amigo que sabe del tema y se acuerda de vos. Tono argentino ("vos", "dale", "che"), cálido, directo, sin diminutivos infantiles, sin clichés de superación baratos.

${NUDGE_KIND_BRIEF[d.kind]}

Datos reales del atleta (NO inventes otros):
${dataLines}

Devolveme UN mensaje muy corto (máx 1-3 frases, ~40 palabras) para WhatsApp. Reglas:
- Que se sienta personal y espontáneo, no un broadcast genérico.
- Usá 1 dato concreto de arriba si suma (racha, peso, meta). No los listes todos.
${goalRule}
- Variá el arranque, NO empieces siempre con el nombre ni con "Hola".
- Sin bullets, sin markdown pesado. 0-1 emoji como mucho.
- NO inventes métricas que no estén arriba.

Mensaje:`;

  try {
    const r = await flashWarm.generateContent(prompt);
    const text = r.response.text().trim();
    if (text) return text;
  } catch (err) {
    logger.error("gemini motivation nudge failed", { err, kind: d.kind });
  }
  // Fallback templated por kind (nunca dejamos el cron sin mensaje).
  const fallback: Record<MotivationNudgeInput["kind"], string> = {
    morning: `Arrancá con todo hoy, ${firstName}. Un día más sumando. 💪`,
    midday: `Acordate por qué empezaste, ${firstName}. Cada registro cuenta.`,
    night: `Buen trabajo hoy, ${firstName}. Descansá que mañana seguimos.`,
  };
  return fallback[d.kind];
}

export async function generateNightlySummary(d: NightlySummaryInput): Promise<string> {
  const firstName = d.name?.split(" ")[0] ?? "atleta";
  const score = d.summary.performance_score;
  const kcal = d.summary.total_kcal;
  const kcalAdh = d.summary.kcal_adherence_pct;
  const proteinAdh = d.summary.protein_adherence_pct;
  const trained = d.summary.training_completed;
  const rpe = d.summary.training_rpe;
  const goalLine = formatGoal(d.goal);

  const dataLines = [
    `nombre: ${firstName}`,
    goalLine,
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

  const goalRule = goalLine
    ? `- HAY UNA META ACTIVA. Tu mensaje debe conectar 1 metrica del dia con esa meta (empuje suave, no sermon).`
    : `- No hay meta explicita: alentar habito/consistencia.`;

  const prompt = `Sos Forja, un coach argentino que cierra el dia con sus atletas por WhatsApp. Tono: directo, calido, sin azucar, sin diminutivos infantiles. Hablas en argentino ("vos", "dale", "che"), no en espanol neutro. Mensajes cortos (60-120 palabras max).

Datos del dia del atleta:
${dataLines}

Devolveme UN mensaje de cierre nocturno para mandarle por WhatsApp. Reglas:
- Empezar por su nombre cuando suene natural.
- Mencionar 1 o 2 metricas concretas que importen hoy (no listar todo).
${goalRule}
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
    const goalSuffix = goalLine ? ` Tu meta sigue ahi.` : "";
    return `Cerramos el día, ${firstName}. ${score != null ? `Score ${score}/100. ` : ""}Mañana seguimos.${goalSuffix} 💪`;
  }
}
