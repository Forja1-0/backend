/**
 * Logger generico de eventos hacia la tabla `system_events`.
 *
 * El proyecto tiene cultura data-first: cualquier accion relevante del
 * usuario o del sistema se appendea aca con payload JSONB. Asi despues
 * se puede preguntar con SQL "cuanto tarda un usuario entre que pide
 * 'perfil' y entra al web_profile", "que % de tokens nunca se consumen",
 * "que pasos del onboarding pierden mas gente", etc., sin tocar el resto
 * del schema.
 *
 * Nunca tira: si el INSERT falla, loguea y sigue. Un evento perdido vale
 * menos que romper el flujo del usuario.
 */
import type { Request } from "express";
import { query } from "../config/db.js";
import { logger } from "../config/logger.js";
import { getClientInfo } from "../utils/client-info.js";

// ───────────────────────── Catalogo de eventos ─────────────────────────
//
// Convencion: snake_case con namespace `<dominio>.<accion>`. El dominio
// dice DONDE pasa, la accion dice QUE pasa. Mantener esta lista
// actualizada — sirve como diccionario para los analistas que escriben
// SQL contra `system_events`.
export const EventTypes = {
  // ── Auth: WhatsApp -> web_profile ───────────────────────────────
  AUTH_TOKEN_ISSUED:    "auth.token_issued",
  AUTH_TOKEN_CONSUMED:  "auth.token_consumed",
  AUTH_TOKEN_FAILED:    "auth.token_failed",
  AUTH_SESSION_STARTED: "auth.session_started",
  AUTH_SESSION_ENDED:   "auth.session_ended",

  // ── WhatsApp bot ─────────────────────────────────────────────────
  WA_WEBHOOK_RECEIVED:    "wa.webhook_received",
  WA_MESSAGE_RECEIVED:    "wa.message_received",     // mensaje del user al bot
  WA_MESSAGE_IGNORED:     "wa.message_ignored",      // grupos, fromMe, etc.
  WA_MESSAGE_SENT:        "wa.message_sent",         // bot -> user
  WA_INTENT_CLASSIFIED:   "wa.intent_classified",
  WA_COMMAND_RECEIVED:    "wa.command_received",
  WA_UNKNOWN:             "wa.unknown",

  // ── Comidas ──────────────────────────────────────────────────────
  MEAL_PARSED:                "meal.parsed",
  MEAL_LOGGED:                "meal.logged",
  MEAL_CONFIRM_REQUESTED:     "meal.confirm_requested",
  MEAL_CONFIRMED:             "meal.confirmed",
  MEAL_CANCELLED:             "meal.cancelled",
  MEAL_CLARIFY_REQUESTED:     "meal.clarify_requested",
  MEAL_STATE_CLARIFY:         "meal.state_clarify_requested",
  MEAL_FOOD_CLARIFY:          "meal.food_clarify_requested",
  MEAL_FAILED:                "meal.failed",

  // ── Entrenamiento ────────────────────────────────────────────────
  TRAINING_COMPLETED:    "training.completed",
  TRAINING_RPE_SAVED:    "training.rpe_saved",
  TRAINING_SKIPPED:      "training.skipped",
  TRAINING_QUERY:        "training.queried",
  TRAINING_DAY_SWAPPED:  "training.day_swapped",

  // ── Checkin nocturno ─────────────────────────────────────────────
  CHECKIN_STARTED:       "checkin.started",
  CHECKIN_STEP:          "checkin.step_answered",
  CHECKIN_COMPLETED:     "checkin.completed",
  CHECKIN_VALIDATION_FAIL:"checkin.validation_failed",

  // ── Disruptions (legacy events table) ────────────────────────────
  DISRUPTION_LOGGED:     "disruption.logged",

  // ── Queries informativas ─────────────────────────────────────────
  QUERY_NUTRITION:       "query.nutrition",
  QUERY_PROGRESS:        "query.progress",
  QUERY_NO_PLAN:         "query.no_plan",

  // ── Greetings & social ───────────────────────────────────────────
  GREETING:              "wa.greeting",
  GRATITUDE:             "wa.gratitude",
  NON_TEXT:              "wa.non_text",

  // ── Baja / unsubscribe ───────────────────────────────────────────
  BAJA_REQUESTED:        "baja.requested",
  BAJA_CONFIRMED:        "baja.confirmed",
  BAJA_CANCELLED:        "baja.cancelled",

  // ── Onboarding ───────────────────────────────────────────────────
  ONBOARDING_STARTED:                "onboarding.started",
  ONBOARDING_STEP_SAVED:             "onboarding.step_saved",
  ONBOARDING_STEP_FAILED:            "onboarding.step_failed",
  ONBOARDING_TRAINING_PARSED:        "onboarding.training_plan_parsed",
  ONBOARDING_TRAINING_PARSE_FAILED:  "onboarding.training_plan_parse_failed",
  ONBOARDING_NUTRITION_UPLOADED:     "onboarding.nutrition_plan_uploaded",
  ONBOARDING_TRAINING_UPLOADED:      "onboarding.training_plan_uploaded",
  ONBOARDING_CONSENT_SAVED:          "onboarding.consent_saved",
  ONBOARDING_WELCOME_SENT:           "onboarding.welcome_sent",
  ONBOARDING_WELCOME_FAILED:         "onboarding.welcome_failed",
  ONBOARDING_FETCHED:                "onboarding.fetched",

  // ── Web profile: lecturas ────────────────────────────────────────
  PROFILE_SECTION_VIEWED:    "profile.section_viewed",
  PROFILE_EXPORTED:          "profile.exported",
  PROFILE_DOC_DOWNLOADED:    "profile.document_downloaded",
  PROFILE_PLAN_DOWNLOADED:   "profile.nutrition_plan_downloaded",

  // ── Web profile: mutaciones ──────────────────────────────────────
  PROFILE_IDENTITY_UPDATED:      "profile.identity_updated",
  PROFILE_RESTRICTIONS_UPDATED:  "profile.restrictions_updated",
  PROFILE_BODY_UPDATED:          "profile.body_updated",
  PROFILE_INJURIES_UPDATED:      "profile.injuries_updated",
  PROFILE_MEDICAL_UPDATED:       "profile.medical_updated",
  PROFILE_PREFERENCES_UPDATED:   "profile.preferences_updated",
  PROFILE_NUTRITION_PLAN_UPDATED:"profile.nutrition_plan_updated",
  PROFILE_PLAN_UPLOADED:         "profile.nutrition_plan_uploaded",
  PROFILE_PLAN_DELETED:          "profile.nutrition_plan_deleted",
  PROFILE_FREQUENT_MEAL_CREATED: "profile.frequent_meal_created",
  PROFILE_FREQUENT_MEAL_UPDATED: "profile.frequent_meal_updated",
  PROFILE_FREQUENT_MEAL_DELETED: "profile.frequent_meal_deleted",
  PROFILE_DOC_UPLOADED:          "profile.document_uploaded",
  PROFILE_DOC_DELETED:           "profile.document_deleted",
  PROFILE_ACCOUNT_DELETED:       "profile.account_deleted",

  // ── Cron ─────────────────────────────────────────────────────────
  CRON_MORNING_TICK:        "cron.morning_tick",
  CRON_MORNING_REMINDER:    "cron.morning_reminder_sent",
  CRON_NIGHT_TICK:          "cron.night_tick",
  CRON_NIGHT_CHECKIN_SENT:  "cron.night_checkin_sent",
  CRON_REMINDER_TICK:       "cron.user_reminder_tick",
  CRON_REMINDER_FIRED:      "cron.user_reminder_fired",

  // ── Recordatorios configurables (amateur) ────────────────────────
  REMINDER_CREATED:         "reminder.created",
  REMINDER_UPDATED:         "reminder.updated",
  REMINDER_DELETED:         "reminder.deleted",
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes] | (string & {});

export interface LogEventInput {
  userId?: string | null;
  type: EventType;
  payload?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export async function logEvent(e: LogEventInput): Promise<void> {
  try {
    await query(
      `INSERT INTO system_events (user_id, event_type, payload, ip, user_agent)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [
        e.userId ?? null,
        e.type,
        JSON.stringify(e.payload ?? {}),
        e.ip ?? null,
        e.userAgent ?? null,
      ],
    );
  } catch (err) {
    logger.error("logEvent failed", { type: e.type, err });
  }
}

/**
 * Helper para rutas Express. Extrae ip/user-agent automaticamente del
 * request y dispara el insert en background — no await del caller, no se
 * bloquea la respuesta. Cualquier error lo loguea events.service.
 */
export function logEventFromRequest(
  req: Request,
  userId: string | null | undefined,
  type: EventType,
  payload?: Record<string, unknown>,
): void {
  const { ip, userAgent } = getClientInfo(req);
  // fire-and-forget: el logger interno ya swallow-ea errores
  void logEvent({ userId: userId ?? null, type, payload, ip, userAgent });
}

/**
 * Helper para eventos del bot WhatsApp (sin request HTTP). No tiene IP/UA
 * porque viene del webhook de Evolution; igualmente recuerda el jid en
 * el payload si lo pasamos.
 */
export function logBotEvent(
  userId: string | null | undefined,
  type: EventType,
  payload?: Record<string, unknown>,
): void {
  void logEvent({ userId: userId ?? null, type, payload });
}
