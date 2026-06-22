import { query } from "../config/db.js";
import type { User } from "../types/user.types.js";

export interface TrainingPlanRow {
  id: string;
  session_type: string;
  session_name: string | null;
  approx_time: string | null; // "HH:MM:SS" from PG
  duration_min: number | null;
}

export interface TrainingLogRow {
  id: string;
  user_id: string;
  session_name: string;
  completed: boolean;
  rpe: number | null;
  logged_at: Date;
}

/**
 * Devuelve el plan de entrenamiento del usuario para HOY según su timezone.
 * Usa day_of_week = EXTRACT(DOW FROM NOW() AT TIME ZONE user.timezone).
 */
export async function getTodayPlan(
  userId: string,
  timezone = "America/Argentina/Buenos_Aires",
): Promise<TrainingPlanRow | null> {
  const { rows } = await query<TrainingPlanRow>(
    `SELECT id, session_type, session_name, approx_time, duration_min
     FROM training_plans
     WHERE user_id = $1
       AND day_of_week = EXTRACT(DOW FROM NOW() AT TIME ZONE $2)::INT
       AND is_active = true
     LIMIT 1`,
    [userId, timezone],
  );
  return rows[0] ?? null;
}

/**
 * Registra una sesión de entrenamiento como completada.
 * Devuelve el training_log creado.
 */
export async function logTrainingComplete(
  user: User,
  sessionName: string,
  planId?: string,
): Promise<TrainingLogRow> {
  const { rows } = await query<TrainingLogRow>(
    `INSERT INTO training_logs (user_id, training_plan_id, session_name, completed)
     VALUES ($1, $2, $3, true)
     RETURNING *`,
    [user.id, planId ?? null, sessionName],
  );
  return rows[0];
}

/**
 * Registra un dia salteado.
 */
export async function logTrainingSkip(userId: string): Promise<void> {
  await query(
    `INSERT INTO training_logs (user_id, session_name, completed)
     VALUES ($1, 'Saltado', false)`,
    [userId],
  );
}

/**
 * Actualiza el RPE de un training_log ya creado.
 */
export async function setRpe(
  trainingLogId: string,
  rpe: number,
): Promise<void> {
  await query(
    `UPDATE training_logs SET rpe = $1 WHERE id = $2`,
    [rpe, trainingLogId],
  );
}

/**
 * Trae TODO el plan semanal del usuario con exercises[].
 * Usado por el matcher de "hice X" para construir el diccionario por user.
 */
export async function getAllActivePlans(userId: string): Promise<
  Array<{
    id: string;
    day_of_week: number;
    session_type: string;
    session_name: string | null;
    exercises: Array<{ name: string; aliases: string[] }> | null;
  }>
> {
  const { rows } = await query<{
    id: string;
    day_of_week: number;
    session_type: string;
    session_name: string | null;
    exercises: Array<{ name: string; aliases: string[] }> | null;
  }>(
    `SELECT id, day_of_week, session_type, session_name, exercises
     FROM training_plans
     WHERE user_id = $1 AND is_active = true`,
    [userId],
  );
  return rows;
}

/**
 * Obtiene todos los usuarios activos con wa_chat_id y su plan de hoy,
 * para el recordatorio matutino (cron 6AM).
 */
export async function getAllUsersWithTodayTraining(): Promise<
  {
    user_id: string;
    wa_chat_id: string;
    name: string | null;
    session_type: string;
    session_name: string | null;
    approx_time: string | null;
    duration_min: number | null;
  }[]
> {
  const { rows } = await query(
    `SELECT user_id, wa_chat_id, name, session_type, session_name, approx_time, duration_min
     FROM v_today_training`,
  );
  return rows as any;
}

/**
 * TODOS los usuarios activos y onboardeados (con wa_chat_id) para el mensaje de
 * "inicio del día" — con su sesión de hoy si la tienen (LEFT JOIN: en día de
 * descanso session_type queda null). Distinto de getAllUsersWithTodayTraining
 * (que solo trae a quien entrena hoy): la mañana va para todos porque ahí se
 * registra el sueño, entrenen o no.
 */
export async function getActiveUsersForMorning(): Promise<
  {
    user_id: string;
    wa_chat_id: string;
    name: string | null;
    session_type: string | null;
    session_name: string | null;
    approx_time: string | null;
    duration_min: number | null;
  }[]
> {
  const { rows } = await query(
    `SELECT DISTINCT ON (u.id)
            u.id AS user_id, u.wa_chat_id, u.name,
            tp.session_type, tp.session_name, tp.approx_time, tp.duration_min
     FROM users u
     LEFT JOIN training_plans tp
       ON tp.user_id = u.id
      AND tp.is_active = true
      AND tp.day_of_week = EXTRACT(DOW FROM NOW() AT TIME ZONE u.timezone)::INT
     WHERE u.active = true
       AND u.wa_chat_id IS NOT NULL
       AND u.onboarding_step >= 7
     ORDER BY u.id, tp.session_type NULLS LAST`,
  );
  return rows as any;
}
