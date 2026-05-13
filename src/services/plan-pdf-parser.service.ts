// Parsea PDFs (o imagenes) de planes nutricionales / de entrenamiento usando
// Gemini 2.5 Flash con inline_data. Esto reemplaza el flujo viejo donde el
// frontend tenia que pegar texto y un PDF se "subia" sin ser procesado.
//
// Disenado para extraer toda la riqueza del plan: tablas con macros por
// comida, distribucion horaria, justificaciones cientificas, protocolos de
// rehabilitacion, alertas, lista de compras, etc. Lo que el coach/nutri
// escribio es lo que el bot va a necesitar para responder.

import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export const PARSER_VERSION = "pdf-gemini-2.5-flash@1";

const SUPPORTED_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

// temperatura baja: queremos extraccion fiel, no creatividad
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.1,
    maxOutputTokens: 8192,
    responseMimeType: "application/json",
  },
});

// ════════════════════════════════════════════════════════════
// Tipos de salida (espejo del JSON que pedimos a Gemini)
// ════════════════════════════════════════════════════════════

export interface ParsedNutritionPlan {
  athlete_summary: {
    name: string | null;
    age: number | null;
    weight_kg: number | null;
    height_cm: number | null;
    goal: string | null;
  };
  targets: {
    kcal: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
  };
  nutritionist_name: string | null;
  phase: string | null;
  budget_notes: string | null;
  diagnosis: string | null;
  protein_quality: Array<{
    food: string;
    protein_per_100g: number | null;
    diaas: number | null;
    digestibility_pct: number | null;
    limiting_aa: string | null;
    notes: string | null;
  }>;
  meal_distribution: Array<{
    meal_id: string;            // "desayuno", "snack_facu", "almuerzo", "pre_entreno", "post_entreno", "cena"
    label: string;              // texto visible: "Desayuno", "Snack facu", etc.
    schedule: string | null;    // "6:30-7:00"
    description: string | null; // texto libre con lo que come
    items: Array<{
      name: string;
      grams: number | null;
      units: string | null;     // "rodajas", "unidades", "ml", "cda"
    }>;
    macros: {
      kcal: number | null;
      protein_g: number | null;
      carbs_g: number | null;
      fat_g: number | null;
    };
    notes: string | null;
  }>;
  daily_variants: Array<{
    when: string;               // "dia con natacion AM", "gym tarde-noche", "domingo"
    adjustments: string;
  }>;
  supplement_alternatives: Array<{
    meal_id: string | null;
    description: string;
    macros: {
      kcal: number | null;
      protein_g: number | null;
      carbs_g: number | null;
      fat_g: number | null;
    };
  }>;
  timing_rules: Array<{
    nutrient: string;           // "carbohidratos", "proteina_pre", "creatina"
    window: string;             // "1-2 horas pre-entreno"
    rationale: string;
    foods: string[];
  }>;
  meal_prep: Array<{
    item: string;
    quantity: string;
    method: string;
    keeps_for: string | null;
  }>;
  shopping_list: Array<{
    item: string;
    weekly_qty: string;
    price_estimate: string | null;
    key_contribution: string | null;
  }>;
  hydration: {
    daily_l_min: number | null;
    daily_l_double_session: number | null;
    electrolyte_recipe: string | null;
    notes: string | null;
  };
  success_indicators: string[];
  general_notes: string[];      // todo lo que es contexto, justificacion, advertencias
}

export interface ParsedTrainingPlanRich {
  athlete_summary: {
    name: string | null;
    age: number | null;
    weight_kg: number | null;
    height_cm: number | null;
    active_injuries: string[];
  };
  event: {
    name: string | null;
    date: string | null;        // ISO yyyy-mm-dd si se infiere
    distance: string | null;
  };
  period: {
    label: string | null;       // "Fase 1 - Base General + Rehab"
    weeks: number | null;       // 16
    start_month: string | null;
    end_month: string | null;
  };
  coach_name: string | null;
  weekly_structure: {
    normal: Array<{
      day: string;              // "Lunes"
      day_of_week: number;      // 0..6
      sessions: Array<{
        kind: string;           // "gym", "natacion", "movilidad", "descanso"
        label: string;          // "Empuje A (pesado)"
        time: string | null;    // "17:00-19:00"
        duration_min: number | null;
      }>;
    }>;
    reduced: Array<{
      day: string;
      day_of_week: number;
      sessions: Array<{
        kind: string;
        label: string;
        time: string | null;
        duration_min: number | null;
      }>;
    }>;
  };
  rehab_rules: string[];        // las reglas no negociables
  days: Array<{
    day_of_week: number;        // 0=domingo .. 6=sabado
    session_type: string;       // gym, natacion, bici, corrida, funcional, crossfit, yoga, movilidad, descanso, otro
    session_name: string | null;
    duration_min: number | null;
    approx_time: string | null; // "12:00-14:00" -> "12:00"
    rationale: string | null;   // "¿Por qué rehab acá?"
    exercises: Array<{
      name: string;
      aliases: string[];
      sets: number | null;
      reps: string | null;
      load_kg: number | null;
      rest: string | null;      // "3 min"
      tempo: string | null;
      notes: string | null;
      is_rehab: boolean;
    }>;
    volume_total_sets: number | null;
  }>;
  rehab_protocols: Array<{
    area: string;               // "Tendon de Aquiles izq", "Menisco lateral der"
    status: string | null;
    current_phase: string | null;
    exercises_summary: string;
    progression_criteria: string[];
    contraindications: string[];
    citations: string[];
  }>;
  swim_plan: {
    sessions: Array<{
      label: string;            // "Martes AM"
      structure: string;
      total_volume_m: number | null;
      focus: string | null;
    }>;
    progression: Array<{
      weeks: string;            // "1-4"
      volume_m: string;
      focus: string;
    }>;
    notes: string | null;
  } | null;
  progression_model: {
    description: string;
    steps: string[];
  } | null;
  alerts: {
    stop_signals: string[];
    reduce_signals: string[];
  };
  general_notes: string[];
}

// ════════════════════════════════════════════════════════════
// Prompts
// ════════════════════════════════════════════════════════════

const NUTRITION_PROMPT = `Sos un nutricionista deportivo argentino. Recibiste el plan nutricional de un atleta. Tu trabajo es extraer TODA la informacion en un JSON estructurado. No omitas nada relevante: tablas, justificaciones, ventanas de timing, lista de compras, recetas, hidratacion, indicadores de exito. Si el plan menciona literatura cientifica, copialo en notes.

Devolve UN JSON con este shape EXACTO (sin texto antes ni despues, sin markdown fences):

{
  "athlete_summary": {"name": string|null, "age": number|null, "weight_kg": number|null, "height_cm": number|null, "goal": string|null},
  "targets": {"kcal": number|null, "protein_g": number|null, "carbs_g": number|null, "fat_g": number|null},
  "nutritionist_name": string|null,
  "phase": string|null,
  "budget_notes": string|null,
  "diagnosis": string|null,
  "protein_quality": [{"food": string, "protein_per_100g": number|null, "diaas": number|null, "digestibility_pct": number|null, "limiting_aa": string|null, "notes": string|null}],
  "meal_distribution": [{
    "meal_id": "desayuno"|"snack_am"|"snack_facu"|"almuerzo"|"merienda"|"pre_entreno"|"post_entreno"|"cena"|"colacion"|"otro",
    "label": string,
    "schedule": string|null,
    "description": string|null,
    "items": [{"name": string, "grams": number|null, "units": string|null}],
    "macros": {"kcal": number|null, "protein_g": number|null, "carbs_g": number|null, "fat_g": number|null},
    "notes": string|null
  }],
  "daily_variants": [{"when": string, "adjustments": string}],
  "supplement_alternatives": [{"meal_id": string|null, "description": string, "macros": {"kcal": number|null, "protein_g": number|null, "carbs_g": number|null, "fat_g": number|null}}],
  "timing_rules": [{"nutrient": string, "window": string, "rationale": string, "foods": [string]}],
  "meal_prep": [{"item": string, "quantity": string, "method": string, "keeps_for": string|null}],
  "shopping_list": [{"item": string, "weekly_qty": string, "price_estimate": string|null, "key_contribution": string|null}],
  "hydration": {"daily_l_min": number|null, "daily_l_double_session": number|null, "electrolyte_recipe": string|null, "notes": string|null},
  "success_indicators": [string],
  "general_notes": [string]
}

REGLAS:
- Si el plan no menciona un dato, usa null o array vacio. NUNCA inventes.
- meal_id: normaliza al alias. Si dice "Snack facu" usa "snack_facu", si dice "Pre-entreno" -> "pre_entreno".
- grams: solo si esta explicito. Si dice "2 rodajas" -> grams=null, units="rodajas".
- general_notes: copia textual de cualquier explicacion cientifica, advertencia, o consejo que el plan menciona.
- protein_quality: si hay tabla DIAAS o similar, listar cada alimento. Si no hay tabla, array vacio.
- success_indicators: las metricas que el plan dice chequear (peso semanal, fuerza, sueno...).
`;

const TRAINING_PROMPT = `Sos un preparador fisico argentino. Recibiste el plan de entrenamiento de un atleta. Tu trabajo es extraer TODA la informacion en un JSON estructurado: estructura semanal, dias detallados con ejercicios (series/reps/descanso/notas), protocolos de rehabilitacion con su justificacion cientifica, plan de natacion, progresion de cargas, alertas, etc.

Devolve UN JSON con este shape EXACTO (sin texto antes ni despues, sin markdown fences):

{
  "athlete_summary": {"name": string|null, "age": number|null, "weight_kg": number|null, "height_cm": number|null, "active_injuries": [string]},
  "event": {"name": string|null, "date": string|null, "distance": string|null},
  "period": {"label": string|null, "weeks": number|null, "start_month": string|null, "end_month": string|null},
  "coach_name": string|null,
  "weekly_structure": {
    "normal": [{"day": string, "day_of_week": number, "sessions": [{"kind": string, "label": string, "time": string|null, "duration_min": number|null}]}],
    "reduced": [{"day": string, "day_of_week": number, "sessions": [{"kind": string, "label": string, "time": string|null, "duration_min": number|null}]}]
  },
  "rehab_rules": [string],
  "days": [{
    "day_of_week": number,
    "session_type": "gym"|"natacion"|"bici"|"corrida"|"funcional"|"crossfit"|"yoga"|"movilidad"|"descanso"|"otro",
    "session_name": string|null,
    "duration_min": number|null,
    "approx_time": string|null,
    "rationale": string|null,
    "exercises": [{
      "name": string,
      "aliases": [string],
      "sets": number|null,
      "reps": string|null,
      "load_kg": number|null,
      "rest": string|null,
      "tempo": string|null,
      "notes": string|null,
      "is_rehab": boolean
    }],
    "volume_total_sets": number|null
  }],
  "rehab_protocols": [{"area": string, "status": string|null, "current_phase": string|null, "exercises_summary": string, "progression_criteria": [string], "contraindications": [string], "citations": [string]}],
  "swim_plan": {"sessions": [{"label": string, "structure": string, "total_volume_m": number|null, "focus": string|null}], "progression": [{"weeks": string, "volume_m": string, "focus": string}], "notes": string|null} | null,
  "progression_model": {"description": string, "steps": [string]} | null,
  "alerts": {"stop_signals": [string], "reduce_signals": [string]},
  "general_notes": [string]
}

REGLAS:
- day_of_week: 0=domingo, 1=lunes, 2=martes, 3=miercoles, 4=jueves, 5=viernes, 6=sabado. Si el plan dice "Lunes" -> 1.
- session_type: usa SOLO los valores listados. "Empuje A pesado" -> "gym". "Nado tecnica" -> "natacion". "Movilidad" -> "movilidad". "Descanso" -> "descanso".
- aliases: 2-3 variantes que el atleta puede usar al hablar por WhatsApp (slang argentino, ingles, abreviado). Ej "Press banca c/ mancuernas" -> ["press banca", "banca con mancuernas", "DB bench press"].
- is_rehab: true si el ejercicio esta marcado como REHAB o es claramente rehabilitacion (TKE, isometricos, exc. de gemelo, etc.).
- rationale: el "¿por que rehab aca?" o cualquier explicacion del dia. Copiar fielmente.
- Si un dia es descanso, exercises: [].
- approx_time: si dice "12:00-14:00" usar "12:00".
- general_notes: copia textual de cualquier explicacion cientifica, citas (Rio et al. 2015), o advertencia.
- Si no podes inferir un campo, null. NUNCA inventes datos.`;

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════

export class PdfParseError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "PdfParseError";
  }
}

function ensureSupportedMime(mime: string) {
  if (!SUPPORTED_MIMES.has(mime)) {
    throw new PdfParseError(
      `mime no soportado: ${mime}. Aceptamos PDF e imagenes (PNG, JPG, WEBP).`,
    );
  }
}

async function callGeminiWithFile<T>(
  prompt: string,
  bytes: Buffer,
  mime: string,
): Promise<T> {
  ensureSupportedMime(mime);
  const inline = {
    inlineData: {
      data: bytes.toString("base64"),
      mimeType: mime,
    },
  };
  const t0 = Date.now();
  let raw = "";
  try {
    const result = await model.generateContent([{ text: prompt }, inline]);
    raw = result.response.text();
  } catch (err) {
    logger.error("plan-pdf-parser: gemini call failed", {
      message: (err as any)?.message,
      status: (err as any)?.status,
      mime,
      bytes: bytes.length,
    });
    throw new PdfParseError("no se pudo procesar el archivo con la IA", err);
  }

  const ms = Date.now() - t0;
  logger.info("plan-pdf-parser: gemini ok", { ms, mime, bytes: bytes.length });

  // responseMimeType:application/json ya devuelve JSON limpio, pero por las
  // dudas tolerar markdown fences o texto antes/despues.
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new PdfParseError("la IA no devolvio JSON valido");
  }
  try {
    return JSON.parse(jsonMatch[0]) as T;
  } catch (err) {
    throw new PdfParseError("la IA devolvio JSON corrupto", err);
  }
}

// ════════════════════════════════════════════════════════════
// API publica
// ════════════════════════════════════════════════════════════

export async function parseNutritionPlanFile(
  bytes: Buffer,
  mime: string,
): Promise<ParsedNutritionPlan> {
  const parsed = await callGeminiWithFile<ParsedNutritionPlan>(NUTRITION_PROMPT, bytes, mime);
  // Saneamiento minimo de shape: garantizamos arrays en vez de null/undefined.
  parsed.protein_quality ??= [];
  parsed.meal_distribution ??= [];
  parsed.daily_variants ??= [];
  parsed.supplement_alternatives ??= [];
  parsed.timing_rules ??= [];
  parsed.meal_prep ??= [];
  parsed.shopping_list ??= [];
  parsed.success_indicators ??= [];
  parsed.general_notes ??= [];
  parsed.hydration ??= { daily_l_min: null, daily_l_double_session: null, electrolyte_recipe: null, notes: null };
  return parsed;
}

export async function parseTrainingPlanFile(
  bytes: Buffer,
  mime: string,
): Promise<ParsedTrainingPlanRich> {
  const parsed = await callGeminiWithFile<ParsedTrainingPlanRich>(TRAINING_PROMPT, bytes, mime);
  parsed.weekly_structure ??= { normal: [], reduced: [] };
  parsed.weekly_structure.normal ??= [];
  parsed.weekly_structure.reduced ??= [];
  parsed.rehab_rules ??= [];
  parsed.days ??= [];
  parsed.rehab_protocols ??= [];
  parsed.alerts ??= { stop_signals: [], reduce_signals: [] };
  parsed.alerts.stop_signals ??= [];
  parsed.alerts.reduce_signals ??= [];
  parsed.general_notes ??= [];
  for (const day of parsed.days) {
    day.exercises ??= [];
    for (const ex of day.exercises) {
      ex.aliases ??= [];
      ex.is_rehab ??= false;
    }
  }
  return parsed;
}
