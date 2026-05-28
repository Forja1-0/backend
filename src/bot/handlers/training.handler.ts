import type { User } from "../../types/user.types.js";
import * as trainingRepo from "../../repositories/training.repo.js";
import * as dailyRepo from "../../repositories/daily.repo.js";
import { getSession, setSession, clearSession } from "../session.store.js";
import { sendText } from "../../services/evolution.service.js";
import * as T from "../personality/templates.js";
import { extractStandaloneNumber } from "../parser/normalize.js";
import { matchTraining } from "../parser/training-matcher.js";
import { logger } from "../../config/logger.js";
import { logBotEvent, EventTypes } from "../../services/events.service.js";

/**
 * Procesa "completé X" / "terminé X" / "listo".
 * Graba el training_log y abre una sesion para capturar el RPE.
 *
 * El normalized viene del classifier, no del usuario crudo, por eso
 * los regex aca asumen acentos ya stripados.
 */
export async function handleComplete(user: User, normalized: string): Promise<void> {
  const jid = user.wa_chat_id!;

  const todayPlan = await trainingRepo.getTodayPlan(user.id, user.timezone);
  const todayDow = computeTodayDow(user.timezone);

  // Intentamos matchear contra el plan completo del usuario (exercise/alias/session).
  // Si el matcher engancha un dia distinto a hoy, lo registramos como swap.
  let matchedPlanId: string | undefined = todayPlan?.id;
  let sessionName: string;
  let dayOffset = 0;

  const match = await matchTraining(user.id, normalized, todayDow);
  if (match) {
    matchedPlanId = match.plan_id;
    sessionName = match.session_name ?? match.session_type;
    dayOffset = match.day_offset;
  } else {
    sessionName =
      extractSessionName(normalized) ??
      todayPlan?.session_name ??
      todayPlan?.session_type ??
      "Entrenamiento";
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
  });

  if (match && !match.is_today && todayPlan && todayPlan.session_type !== "descanso") {
    logBotEvent(user.id, EventTypes.TRAINING_DAY_SWAPPED, {
      done_session: sessionName,
      planned_session: todayPlan.session_name ?? todayPlan.session_type,
    });
    await sendText(
      jid,
      T.trainingDaySwapped(sessionName, todayPlan.session_name ?? todayPlan.session_type),
      { userId: user.id, category: "training_day_swapped" },
    );
  } else {
    await sendText(jid, T.trainingComplete(sessionName), {
      userId: user.id,
      category: "training_complete",
    });
  }
  logger.debug("training match", { userId: user.id, match, dayOffset });
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
    await sendText(jid, T.trainingQueryRest(), {
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
// "complete piernas hoy" → "piernas" (corta en stopword)
// "listo el gym a full" → "el gym"
// ──────────────────────────────────────────────────────────
const VERB_PREFIX = /^(?:complet[ae]|terminado|terminada|terminamos|termin[ae]|finalice|finalizado|acab[eo]|ya termine|ya hice|ya entrene|hecho|cerrado|listo(?:\s+el|\s+la)?|hice|hicimos)\s+/;
const STOPWORD_BOUNDARY = /\b(?:hoy|ayer|recien|al fin|por fin|a full|durisimo|durisima|tremendo|tremenda|completo|completa|enterito|enterita|y |con |en el|en la)\b/;

function extractSessionName(normalized: string): string | null {
  const m = normalized.match(VERB_PREFIX);
  if (!m) return null;
  const rest = normalized.slice(m[0].length).trim();
  if (!rest) return null;
  const cutoff = rest.search(STOPWORD_BOUNDARY);
  const clean = cutoff > 0 ? rest.slice(0, cutoff).trim() : rest;
  return clean.length > 0 ? clean.slice(0, 80) : null;
}
