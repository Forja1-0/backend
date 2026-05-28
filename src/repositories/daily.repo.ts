import { query } from "../config/db.js";

export interface CheckinData {
  nutrition_ok: boolean;
  sleep: number;
  pain: number;
}

export interface DailySummaryRow {
  user_id: string;
  summary_date: string;
  total_kcal: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
  kcal_adherence_pct: number | null;
  protein_adherence_pct: number | null;
  training_completed: boolean | null;
  training_rpe: number | null;
  performance_score: number | null;
}

/**
 * Recalcula los macros del dia de HOY desde meal_logs (+ RPE del training_log
 * de hoy) y hace UPSERT en daily_summaries. NO requiere checkin: se llama cada
 * vez que el usuario carga una comida o un entreno por WhatsApp, asi el dia
 * actual aparece al instante en el perfil web (antes esto solo pasaba en el
 * checkin nocturno y el dia quedaba vacio hasta entonces).
 *
 * IMPORTANTE: este path NUNCA escribe `training_completed`. Esa columna es el
 * sentinela de "checkin hecho" (lo usan hasCheckinToday y getCheckinCandidates):
 * si la seteasemos al loguear un entreno, el checkin nocturno dejaria de
 * dispararse para ese usuario. La completitud del entreno ya vive en
 * training_logs, que es lo que leen overview/training.
 */
export async function refreshDailySummary(userId: string): Promise<DailySummaryRow | null> {
  const { rows: macroRows } = await query<{
    total_kcal: number;
    total_protein_g: number;
    total_carbs_g: number;
    total_fat_g: number;
  }>(
    `SELECT
       COALESCE(SUM(total_kcal),0)::INT         AS total_kcal,
       COALESCE(SUM(total_protein_g),0)::REAL    AS total_protein_g,
       COALESCE(SUM(total_carbs_g),0)::REAL      AS total_carbs_g,
       COALESCE(SUM(total_fat_g),0)::REAL        AS total_fat_g
     FROM meal_logs
     WHERE user_id = $1
       AND logged_at::date = CURRENT_DATE
       AND confirmed = true`,
    [userId],
  );
  const macros = macroRows[0];

  const { rows: planRows } = await query<{ target_kcal: number; target_protein_g: number }>(
    `SELECT target_kcal, target_protein_g FROM nutrition_plans
     WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId],
  );
  const plan = planRows[0];
  const kcalAdh = plan ? Math.min((macros.total_kcal / plan.target_kcal) * 100, 150) : null;
  const proteinAdh = plan ? Math.min((macros.total_protein_g / plan.target_protein_g) * 100, 150) : null;

  const { rows: tRows } = await query<{ rpe: number | null }>(
    `SELECT rpe FROM training_logs
     WHERE user_id = $1 AND logged_at::date = CURRENT_DATE
     ORDER BY logged_at DESC LIMIT 1`,
    [userId],
  );
  const trainingRpe = tRows[0]?.rpe ?? null;

  await query(
    `INSERT INTO daily_summaries
       (user_id, summary_date, total_kcal, total_protein_g, total_carbs_g, total_fat_g,
        kcal_adherence_pct, protein_adherence_pct, training_rpe)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, summary_date) DO UPDATE SET
       total_kcal = EXCLUDED.total_kcal,
       total_protein_g = EXCLUDED.total_protein_g,
       total_carbs_g = EXCLUDED.total_carbs_g,
       total_fat_g = EXCLUDED.total_fat_g,
       kcal_adherence_pct = EXCLUDED.kcal_adherence_pct,
       protein_adherence_pct = EXCLUDED.protein_adherence_pct,
       training_rpe = COALESCE(EXCLUDED.training_rpe, daily_summaries.training_rpe)`,
    [userId, macros.total_kcal, macros.total_protein_g, macros.total_carbs_g, macros.total_fat_g, kcalAdh, proteinAdh, trainingRpe],
  );

  await query(
    `UPDATE daily_summaries
     SET performance_score = calculate_performance_score($1, CURRENT_DATE)
     WHERE user_id = $1 AND summary_date = CURRENT_DATE`,
    [userId],
  );

  const { rows: final } = await query<DailySummaryRow>(
    `SELECT user_id, summary_date::text, total_kcal, total_protein_g, total_carbs_g, total_fat_g,
            kcal_adherence_pct, protein_adherence_pct, training_completed, training_rpe, performance_score
     FROM daily_summaries
     WHERE user_id = $1 AND summary_date = CURRENT_DATE`,
    [userId],
  );
  return final[0] ?? null;
}

/**
 * Upsert del daily_summary del dia para el checkin nocturno: refresca macros +
 * RPE (reusa refreshDailySummary) y ademas fija `training_completed` desde el
 * training_log de hoy (o false), que es lo que marca el dia como "checkin
 * hecho". Devuelve la fila final con performance_score calculado.
 */
export async function upsertDailySummary(
  userId: string,
  _checkin: CheckinData,
): Promise<DailySummaryRow> {
  await refreshDailySummary(userId);

  const { rows: tRows } = await query<{ completed: boolean }>(
    `SELECT completed FROM training_logs
     WHERE user_id = $1 AND logged_at::date = CURRENT_DATE
     ORDER BY logged_at DESC LIMIT 1`,
    [userId],
  );
  // training_completed != null marca el dia como cerrado por el checkin.
  await query(
    `UPDATE daily_summaries
     SET training_completed = $2
     WHERE user_id = $1 AND summary_date = CURRENT_DATE`,
    [userId, tRows[0]?.completed ?? false],
  );

  await query(
    `UPDATE daily_summaries
     SET performance_score = calculate_performance_score($1, CURRENT_DATE)
     WHERE user_id = $1 AND summary_date = CURRENT_DATE`,
    [userId],
  );

  const { rows: final } = await query<DailySummaryRow>(
    `SELECT user_id, summary_date::text, total_kcal, total_protein_g, total_carbs_g, total_fat_g,
            kcal_adherence_pct, protein_adherence_pct, training_completed, training_rpe, performance_score
     FROM daily_summaries
     WHERE user_id = $1 AND summary_date = CURRENT_DATE`,
    [userId],
  );
  return final[0];
}

/** True si el user ya tiene daily_summary hoy con respuesta de checkin (sleep != null heuristica). */
export async function hasCheckinToday(userId: string): Promise<boolean> {
  const { rows } = await query<{ has: boolean }>(
    `SELECT EXISTS(
        SELECT 1 FROM daily_summaries
        WHERE user_id = $1
          AND summary_date = CURRENT_DATE
          AND training_completed IS NOT NULL
     ) AS has`,
    [userId],
  );
  return rows[0]?.has ?? false;
}

/**
 * Usuarios elegibles para el checkin nocturno:
 * activos, con WA conectado, y que NO hayan hecho el checkin hoy.
 */
export async function getCheckinCandidates(): Promise<
  { id: string; wa_chat_id: string; name: string | null; timezone: string }[]
> {
  const { rows } = await query<{
    id: string;
    wa_chat_id: string;
    name: string | null;
    timezone: string;
  }>(
    `SELECT u.id, u.wa_chat_id, u.name, u.timezone
     FROM users u
     WHERE u.active = true
       AND u.wa_chat_id IS NOT NULL
       AND u.onboarding_step >= 7
       AND NOT EXISTS (
         SELECT 1 FROM daily_summaries ds
         WHERE ds.user_id = u.id
           AND ds.summary_date = CURRENT_DATE
           AND ds.training_completed IS NOT NULL
       )`,
  );
  return rows;
}

export interface DailyRemainingRow {
  target_kcal: number;
  target_protein_g: number;
  target_carbs_g: number;
  target_fat_g: number;
  consumed_kcal: number;
  consumed_protein: number;
  consumed_carbs: number;
  consumed_fat: number;
  remaining_kcal: number;
  remaining_protein: number;
  remaining_carbs: number;
  remaining_fat: number;
}

/**
 * Macros target / consumidos / restantes del día para un usuario.
 * Lee de v_daily_remaining (schema.sql). Devuelve null si el user no
 * tiene plan nutricional activo (la vista no devuelve fila).
 */
export async function getDailyRemaining(
  userId: string,
): Promise<DailyRemainingRow | null> {
  const { rows } = await query<DailyRemainingRow>(
    `SELECT target_kcal, target_protein_g, target_carbs_g, target_fat_g,
            consumed_kcal, consumed_protein, consumed_carbs, consumed_fat,
            remaining_kcal, remaining_protein, remaining_carbs, remaining_fat
     FROM v_daily_remaining WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** Eventos recientes para enriquecer el prompt del AI summary. */
export async function getRecentEvents(
  userId: string,
  days = 7,
): Promise<{ event_type: string; description: string; occurred_at: Date }[]> {
  const { rows } = await query<{
    event_type: string;
    description: string;
    occurred_at: Date;
  }>(
    `SELECT event_type, description, occurred_at
     FROM events
     WHERE user_id = $1
       AND occurred_at >= NOW() - ($2 || ' days')::interval
     ORDER BY occurred_at DESC
     LIMIT 5`,
    [userId, days],
  );
  return rows;
}
