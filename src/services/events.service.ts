/**
 * Logger generico de eventos hacia la tabla `events`.
 *
 * El proyecto tiene cultura data-first: cualquier accion relevante del
 * usuario o del sistema se appendea aca con payload JSONB. Asi despues se
 * puede preguntar con SQL "cuanto tarda un usuario entre que pide 'perfil'
 * y entra al web_profile", "que % de tokens nunca se consumen", etc., sin
 * tener que tocar el resto del schema.
 *
 * Nunca tira: si el INSERT falla, loguea y sigue. Un evento perdido vale
 * menos que romper el flujo del usuario.
 */
import { query } from "../config/db.js";
import { logger } from "../config/logger.js";

export type EventType =
  // WhatsApp -> web_profile auth flow
  | "auth.token_issued"
  | "auth.token_consumed"
  | "auth.token_failed"
  | "auth.session_started"
  | "auth.session_ended"
  // Bot
  | "wa.command_received"
  | "wa.message_sent"
  // Perfil web
  | "profile.section_viewed"
  | "profile.mutation"
  // Generico (escape hatch para no bloquear el codigo)
  | (string & {});

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
