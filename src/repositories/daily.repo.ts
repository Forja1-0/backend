import { query } from "../config/db.js";

export interface CheckinData {
  nutrition_ok: boolean;
  sleep: number; // 1-5
  pain: number;  // 0-10
}

/**
 * Upsert del daily_summary del día de hoy con los datos del check-in nocturno.
 * training_completed y training_rpe vienen del training_log si ya existe.
 */
export async function upsertDailySummary(
  userId: string,
  checkin: CheckinData,
): Promise<void> {
  // Obtenemos los macros del día (meal_logs confirmados)
  const { rows: macroRows } = await query(
    `SELECT
       COALESCE(SUM(total_kcal),0)::INT       AS total_kcal,
       COALESCE(SUM(total_protein_g),0)::REAL  AS total_protein_g,
       COALESCE(SUM(total_carbs_g),0)::REAL    AS total_carbs_g,
       COALESCE(SUM(total_fat_g),0)::REAL      AS total_fat_g
     FROM meal_logs
     WHERE user_id = $1
       AND logged_at::date = CURRENT_DATE
       AND confirmed = true`,
    [userId],
  );
  const macros = macroRows[0] as any;

  // Obtenemos target del plan activo para calcular adherencia
  const { rows: planRows } = await query(
    `SELECT target_kcal, target_protein_g FROM nutrition_plans
     WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId],
  );
  const plan = planRows[0] as any;

  const kcal_adh = plan
    ? Math.min((macros.total_kcal / plan.target_kcal) * 100, 150)
    : null;
  const protein_adh = plan
    ? Math.min((macros.total_protein_g / plan.target_protein_g) * 100, 150)
    : null;

  // Training del día
  const { rows: tRows } = await query(
    `SELECT completed, rpe FROM training_logs
     WHERE user_id = $1 AND logged_at::date = CURRENT_DATE
     ORDER BY logged_at DESC LIMIT 1`,
    [userId],
  );
  const training = tRows[0] as any;

  await query(
    `INSERT INTO daily_summaries
       (user_id, summary_date, total_kcal, total_protein_g, total_carbs_g, total_fat_g,
        kcal_adherence_pct, protein_adherence_pct,
        training_completed, training_rpe)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, summary_date) DO UPDATE SET
       total_kcal = EXCLUDED.total_kcal,
       total_protein_g = EXCLUDED.total_protein_g,
       total_carbs_g = EXCLUDED.total_carbs_g,
       total_fat_g = EXCLUDED.total_fat_g,
       kcal_adherence_pct = EXCLUDED.kcal_adherence_pct,
       protein_adherence_pct = EXCLUDED.protein_adherence_pct,
       training_completed = COALESCE(EXCLUDED.training_completed, daily_summaries.training_completed),
       training_rpe = COALESCE(EXCLUDED.training_rpe, daily_summaries.training_rpe)`,
    [
      userId,
      macros.total_kcal,
      macros.total_protein_g,
      macros.total_carbs_g,
      macros.total_fat_g,
      kcal_adh,
      protein_adh,
      training?.completed ?? false,
      training?.rpe ?? null,
    ],
  );

  // Calculamos el performance score via la función SQL
  await query(
    `UPDATE daily_summaries
     SET performance_score = calculate_performance_score($1, CURRENT_DATE)
     WHERE user_id = $1 AND summary_date = CURRENT_DATE`,
    [userId],
  );
}

/**
 * Obtiene todos los usuarios activos con wa_chat_id para el cron nocturno.
 */
export async function getActiveUsersForCheckin(): Promise<
  { id: string; wa_chat_id: string; name: string | null; timezone: string }[]
> {
  const { rows } = await query(
    `SELECT id, wa_chat_id, name, timezone FROM users
     WHERE active = true AND wa_chat_id IS NOT NULL`,
  );
  return rows as any;
}
