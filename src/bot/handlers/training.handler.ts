import type { User } from "../../types/user.types.js";
import { env } from "../../config/env.js";
import * as trainingRepo from "../../repositories/training.repo.js";
import * as dailyRepo from "../../repositories/daily.repo.js";
import { getSession, setSession, clearSession } from "../session.store.js";
import { sendText } from "../../services/evolution.service.js";
import * as T from "../personality/templates.js";
import { extractStandaloneNumber, normalize, tokenize } from "../parser/normalize.js";
import { matchTraining } from "../parser/training-matcher.js";
import { logger } from "../../config/logger.js";
import { logBotEvent, EventTypes } from "../../services/events.service.js";

/** Entidades que extrajo el interpreter (Gemini) para training_complete. */
export interface AiTrainingHints {
  /** Qué entrenó, en palabras del usuario ("brazos", "corri 5k"). */
  sessionText: string | null;
  /** El usuario dijo explicitamente que se salió del plan/rutina. */
  offPlan: boolean;
}

/**
 * Procesa "completé X" / "terminé X" / "listo".
 * Graba el training_log y abre una sesion para capturar el RPE.
 *
 * Orden de decision (la AI interpreta, el algoritmo decide, nadie inventa):
 *   1. Matchear contra el plan lo que la AI extrajo (hints.sessionText).
 *      Si la AI no extrajo nada, matchear el texto completo (rescate).
 *   2. Sin match pero el usuario NOMBRÓ lo que hizo → registrar SUS palabras,
 *      SIN plan_id (off-plan). Nunca atribuirselo a la sesion de hoy.
 *   3. Sin match y sin nombre ("listo", "ya entrené") → ahi si, lo unico
 *      razonable es asumir la sesion planificada de hoy.
 *
 * El normalized viene del classifier, no del usuario crudo, por eso
 * los regex aca asumen acentos ya stripados.
 */
export async function handleComplete(
  user: User,
  normalized: string,
  hints?: AiTrainingHints,
): Promise<void> {
  const jid = user.wa_chat_id!;

  const todayPlan = await trainingRepo.getTodayPlan(user.id, user.timezone);
  const todayDow = computeTodayDow(user.timezone);

  // ── 1. Match contra el plan ───────────────────────────────
  // Si la AI extrajo la entidad, matcheamos SOLO eso: el texto completo mete
  // ruido ("me sali de la RUTINA" podria enganchar una sesion "Rutina A").
  const aiText = hints?.sessionText ? normalize(hints.sessionText) : null;
  const match = aiText
    ? await matchTraining(user.id, aiText, todayDow)
    : await matchTraining(user.id, normalized, todayDow);

  let matchedPlanId: string | undefined;
  let sessionName: string;
  let dayOffset = 0;
  let offPlan = false;

  if (match) {
    matchedPlanId = match.plan_id;
    sessionName = match.session_name ?? match.session_type;
    dayOffset = match.day_offset;
  } else {
    // ── 2. Sin match: ¿nombró lo que hizo? ──────────────────
    const named = aiText ?? extractSessionName(normalized);
    if (named && !isGenericSessionName(named)) {
      sessionName = named.slice(0, 80);
      offPlan = true; // sus palabras, sin plan_id — no inventamos
    } else {
      // ── 3. No nombró nada: asumimos la sesion de hoy ──────
      sessionName = todayPlan?.session_name ?? todayPlan?.session_type ?? "Entrenamiento";
      matchedPlanId = todayPlan?.id;
    }
  }

  const log = await trainingRepo.logTrainingComplete(user, sessionName, matchedPlanId);
  await refreshDaily(user.id);
  setSession(jid, { flow: "rpe_capture", training_log_id: log.id });

  logBotEvent(user.id, EventTypes.TRAINING_COMPLETED, {
    session_name: sessionName,
    plan_id: matchedPlanId ?? null,
    training_log_id: log.id,
    matched: match != null,
    is_today: match?.is_today ?? null,
    day_offset: dayOffset,
    off_plan: offPlan,
    ai_session_text: hints?.sessionText ?? null,
  });

  const plannedToday =
    todayPlan && todayPlan.session_type !== "descanso"
      ? todayPlan.session_name ?? todayPlan.session_type
      : null;

  if (offPlan) {
    logBotEvent(user.id, EventTypes.TRAINING_OFF_PLAN, {
      done_session: sessionName,
      planned_session: plannedToday,
      explicit_off_plan: hints?.offPlan ?? false,
    });
    await sendText(jid, T.trainingOffPlan(sessionName, plannedToday), {
      userId: user.id,
      category: "training_off_plan",
    });
  } else if (match && !match.is_today && plannedToday) {
    logBotEvent(user.id, EventTypes.TRAINING_DAY_SWAPPED, {
      done_session: sessionName,
      planned_session: plannedToday,
    });
    await sendText(jid, T.trainingDaySwapped(sessionName, plannedToday), {
      userId: user.id,
      category: "training_day_swapped",
    });
  } else {
    await sendText(jid, T.trainingComplete(sessionName), {
      userId: user.id,
      category: "training_complete",
    });
  }
  logger.debug("training match", { userId: user.id, match, dayOffset, offPlan });
}

/**
 * Refresca el daily_summary de hoy tras loguear/actualizar un entreno, para
 * que el perfil web refleje el dia al instante. Best-effort: el training_log
 * ya quedo guardado, no queremos romper el flujo del bot si esto falla.
 */
async function refreshDaily(userId: string): Promise<void> {
  try {
    await dailyRepo.refreshDailySummary(userId);
  } catch (err) {
    logger.error("refreshDailySummary failed after training", { err, userId });
  }
}

function computeTodayDow(timezone: string | null | undefined): number {
  const tz = timezone || "America/Argentina/Buenos_Aires";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(new Date());
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[parts] ?? new Date().getDay();
}

export async function handleRpeResponse(user: User, text: string): Promise<void> {
  const jid = user.wa_chat_id!;
  const session = getSession(jid);
  if (!session || session.flow !== "rpe_capture") return;

  const rpe = extractStandaloneNumber(text.trim().toLowerCase());
  if (rpe === null || rpe < 1 || rpe > 10) {
    logBotEvent(user.id, "training.rpe_invalid", { raw: text });
    await sendText(jid, T.trainingNeedsNumber(), {
      userId: user.id,
      category: "training_rpe_invalid",
    });
    return;
  }

  await trainingRepo.setRpe(session.training_log_id, rpe);
  await refreshDaily(user.id);
  clearSession(jid);
  logBotEvent(user.id, EventTypes.TRAINING_RPE_SAVED, {
    rpe,
    training_log_id: session.training_log_id,
  });
  await sendText(jid, T.trainingRpeSaved(rpe), {
    userId: user.id,
    category: "training_rpe_saved",
  });
}

export async function handleSkip(user: User): Promise<void> {
  const jid = user.wa_chat_id!;
  try {
    await trainingRepo.logTrainingSkip(user.id);
    await refreshDaily(user.id);
  } catch (err) {
    logger.error("logTrainingSkip failed", { err, userId: user.id });
  }
  logBotEvent(user.id, EventTypes.TRAINING_SKIPPED, { jid });
  await sendText(jid, T.trainingSkip(), { userId: user.id, category: "training_skip" });
}

export async function handleQuery(user: User): Promise<void> {
  const jid = user.wa_chat_id!;
  const plan = await trainingRepo.getTodayPlan(user.id, user.timezone);
  if (!plan || plan.session_type === "descanso") {
    logBotEvent(user.id, EventTypes.TRAINING_QUERY, {
      has_session: false,
      is_rest: plan?.session_type === "descanso",
    });
    await sendText(jid, T.trainingQueryRest(env.FORJA_MODE === "amateur"), {
      userId: user.id,
      category: "training_query_rest",
    });
    return;
  }
  logBotEvent(user.id, EventTypes.TRAINING_QUERY, {
    has_session: true,
    session_type: plan.session_type,
    session_name: plan.session_name,
  });
  await sendText(
    jid,
    T.trainingQuery({
      name: plan.session_name,
      type: plan.session_type,
      time: plan.approx_time,
    }),
    { userId: user.id, category: "training_query" },
  );
}

// ──────────────────────────────────────────────────────────
// Extrae el nombre de la sesion del texto.
// "complete piernas" → "piernas"
// "entrene brazos completo" → "brazos" (corta en stopword)
// "hoy hice espalda" → "espalda" (tolera prefijo temporal)
// "listo el gym a full" → "gym" (genérico → el caller asume plan de hoy)
// ──────────────────────────────────────────────────────────
const VERB_PREFIX = /^(?:hoy |ayer |recien |ya )?(?:complet[ae]|terminado|terminada|terminamos|termin[ae]|finalice|finalizado|acab[eo]|entrenamos|entrene|hecho|cerrado|listo(?:\s+el|\s+la)?|hice|hicimos)\s+/;
const STOPWORD_BOUNDARY = /\b(?:hoy|ayer|recien|al fin|por fin|a full|durisimo|durisima|tremendo|tremenda|completo|completa|enterito|enterita|y |con |en el|en la|me sali|me fui)\b/;

export function extractSessionName(normalized: string): string | null {
  const m = normalized.match(VERB_PREFIX);
  if (!m) return null;
  const rest = normalized.slice(m[0].length).trim();
  if (!rest) return null;
  const cutoff = rest.search(STOPWORD_BOUNDARY);
  const clean = cutoff > 0 ? rest.slice(0, cutoff).trim() : rest;
  return clean.length > 0 ? clean.slice(0, 80) : null;
}

// Palabras que no nombran una sesion concreta ("hice lo de hoy", "termine el
// entrenamiento"). Si lo "nombrado" es solo esto, NO es off-plan: el usuario
// se refiere a la sesion planificada.
const GENERIC_SESSION_TOKENS = new Set([
  "lo", "la", "el", "de", "del", "mi", "todo", "toda", "hoy", "dia",
  "entrenamiento", "entreno", "rutina", "sesion", "plan", "gym", "gimnasio",
]);

export function isGenericSessionName(name: string): boolean {
  const toks = tokenize(normalize(name));
  return toks.length === 0 || toks.every((t) => GENERIC_SESSION_TOKENS.has(t));
}
