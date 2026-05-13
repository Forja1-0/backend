/**
 * Matcher de "hice X" contra el plan de entrenamiento del usuario.
 *
 * Construye un diccionario por user (en memoria, TTL 1h) con:
 *   - session_type   (gym, piernas, pecho, natacion, etc)
 *   - session_name   ("Piernas A", "Tirada larga")
 *   - exercise.name  ("Sentadilla", "Press de banca")
 *   - exercise.aliases (["sentadillas", "back squat", "squat"])
 *
 * Cuando llega un mensaje, busca por cada token (con tolerancia a typos)
 * el mejor match del diccionario. Devuelve el plan_id + flag de si es
 * el dia de hoy o si se hizo "fuera de orden".
 */

import * as trainingRepo from "../../repositories/training.repo.js";
import { levenshtein, maxTypoDistance } from "./fuzzy.js";
import { normalize, tokenize } from "./normalize.js";

export interface TrainingMatch {
  plan_id: string;
  day_of_week: number;
  session_type: string;
  session_name: string | null;
  matched_token: string;
  matched_canonical: string;
  matched_via: "session_name" | "session_type" | "exercise" | "alias";
  is_today: boolean;
  /** 0 = hoy. Negativo = atras (martes y es jueves). Positivo = adelante. */
  day_offset: number;
}

interface DictEntry {
  /** Token normalizado para matchear (lowercased, sin acentos). */
  token: string;
  plan_id: string;
  day_of_week: number;
  session_type: string;
  session_name: string | null;
  canonical: string;
  via: TrainingMatch["matched_via"];
}

interface UserDict {
  entries: DictEntry[];
  expiresAt: number;
}

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, UserDict>();

/** Invalida el cache del user — llamar despues de actualizar su plan. */
export function invalidateUserDict(userId: string): void {
  cache.delete(userId);
}

async function getDict(userId: string): Promise<DictEntry[]> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;

  const plans = await trainingRepo.getAllActivePlans(userId);
  const entries: DictEntry[] = [];

  for (const plan of plans) {
    const base = {
      plan_id: plan.id,
      day_of_week: plan.day_of_week,
      session_type: plan.session_type,
      session_name: plan.session_name,
    };
    // session_type: ej "gym", "piernas", "pecho"
    if (plan.session_type) {
      entries.push({
        ...base,
        token: normalize(plan.session_type),
        canonical: plan.session_type,
        via: "session_type",
      });
    }
    // session_name: ej "Piernas A". Lo metemos completo y palabra por palabra.
    if (plan.session_name) {
      const norm = normalize(plan.session_name);
      entries.push({ ...base, token: norm, canonical: plan.session_name, via: "session_name" });
      for (const word of tokenize(norm)) {
        if (word.length >= 4) {
          entries.push({ ...base, token: word, canonical: plan.session_name, via: "session_name" });
        }
      }
    }
    // exercises
    if (Array.isArray(plan.exercises)) {
      for (const ex of plan.exercises) {
        if (ex.name) {
          entries.push({
            ...base,
            token: normalize(ex.name),
            canonical: ex.name,
            via: "exercise",
          });
        }
        for (const alias of ex.aliases ?? []) {
          entries.push({
            ...base,
            token: normalize(alias),
            canonical: ex.name,
            via: "alias",
          });
        }
      }
    }
  }

  cache.set(userId, { entries, expiresAt: Date.now() + TTL_MS });
  return entries;
}

/**
 * Busca el mejor match para los tokens del usuario contra su plan.
 *
 * Tie-break (en orden):
 *   1. distancia=0 (match exacto) gana siempre
 *   2. menor distancia de edicion
 *   3. menor day_offset (preferimos hoy o el dia mas cercano)
 *   4. via en orden: exercise > alias > session_name > session_type
 *
 * Devuelve null si ningun token cruza el threshold de typo.
 */
export async function matchTraining(
  userId: string,
  normalizedText: string,
  todayDow: number,
): Promise<TrainingMatch | null> {
  const tokens = tokenize(normalizedText);
  if (tokens.length === 0) return null;

  const entries = await getDict(userId);
  if (entries.length === 0) return null;

  let best: { entry: DictEntry; token: string; dist: number } | null = null;

  for (const tok of tokens) {
    if (tok.length < 3) continue;
    for (const entry of entries) {
      // Token corto vs entrada larga (ej tok="gym" vs entry.token="piernas a"):
      // permitimos que el token este CONTENIDO en la entrada como palabra entera.
      const exact = tok === entry.token;
      let dist: number;
      if (exact) {
        dist = 0;
      } else if (Math.abs(tok.length - entry.token.length) > 3) {
        // Si entry es multi-palabra, probar contra cada palabra
        if (entry.token.includes(" ")) {
          let minWord = Infinity;
          for (const w of entry.token.split(" ")) {
            if (w.length < 3) continue;
            const d = levenshtein(tok, w);
            if (d <= maxTypoDistance(w)) minWord = Math.min(minWord, d);
          }
          if (minWord === Infinity) continue;
          dist = minWord;
        } else continue;
      } else {
        dist = levenshtein(tok, entry.token);
        if (dist > maxTypoDistance(entry.token)) continue;
      }

      if (!best || dist < best.dist || (dist === best.dist && betterEntry(entry, best.entry, todayDow))) {
        best = { entry, token: tok, dist };
      }
    }
  }

  if (!best) return null;

  const offset = signedDayOffset(best.entry.day_of_week, todayDow);
  return {
    plan_id: best.entry.plan_id,
    day_of_week: best.entry.day_of_week,
    session_type: best.entry.session_type,
    session_name: best.entry.session_name,
    matched_token: best.token,
    matched_canonical: best.entry.canonical,
    matched_via: best.entry.via,
    is_today: best.entry.day_of_week === todayDow,
    day_offset: offset,
  };
}

const VIA_PRIORITY: Record<TrainingMatch["matched_via"], number> = {
  exercise: 4,
  alias: 3,
  session_name: 2,
  session_type: 1,
};

function betterEntry(a: DictEntry, b: DictEntry, todayDow: number): boolean {
  // Preferimos el dia mas cercano a hoy (en distancia ciclica 0..3)
  const da = Math.abs(signedDayOffset(a.day_of_week, todayDow));
  const db = Math.abs(signedDayOffset(b.day_of_week, todayDow));
  if (da !== db) return da < db;
  return VIA_PRIORITY[a.via] > VIA_PRIORITY[b.via];
}

/** Diferencia ciclica: -3..+3 dias. todayDow - planDow en sentido natural. */
function signedDayOffset(planDow: number, todayDow: number): number {
  let diff = planDow - todayDow;
  if (diff > 3) diff -= 7;
  if (diff < -3) diff += 7;
  return diff;
}
