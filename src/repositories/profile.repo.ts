import { query } from "../config/db.js";

/**
 * Repo del perfil web (centro de control del atleta). Solo lee/escribe sobre
 * el schema canónico (sql/schema.sql) — sin tablas nuevas. Lo que la Fase
 * Toyota no modela (suscripción, recordatorios, tono del bot, privacidad)
 * NO se inventa acá: el front lo maneja como estado local hasta que exista
 * una migración que lo respalde.
 */

export interface DbUser {
  id: string;
  name: string;
  age: number;
  sex: "M" | "F" | "X";
  weight_kg: number;
  height_cm: number;
  body_fat_pct: number | null;
  email: string;
  phone_wa: string;
  wa_chat_id: string | null;
  timezone: string;
  active: boolean;
  onboarding_step: number;
  created_at: string;
}

export async function getUser(userId: string): Promise<DbUser | null> {
  const { rows } = await query<DbUser>(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [userId]);
  return rows[0] ?? null;
}

/* ---------------- Overview / Mi Semana ---------------- */
export async function getOverview(userId: string) {
  const [goal, plan, remaining, todayTraining, summaries, trainingLogs, events] = await Promise.all([
    query(
      `SELECT event_name, event_date, distance, objective_notes, created_at
       FROM goals WHERE user_id = $1 AND is_active = true
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),
    query(
      `SELECT target_kcal, target_protein_g, target_carbs_g, target_fat_g, meal_distribution, nutritionist_name
       FROM nutrition_plans WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [userId],
    ),
    query(`SELECT * FROM v_daily_remaining WHERE user_id = $1 LIMIT 1`, [userId]),
    query(
      `SELECT session_type, session_name, approx_time, duration_min
       FROM training_plans
       WHERE user_id = $1 AND is_active = true
         AND day_of_week = EXTRACT(DOW FROM (now() AT TIME ZONE
              (SELECT timezone FROM users WHERE id = $1)))::int
       LIMIT 1`,
      [userId],
    ),
    query(
      `SELECT summary_date, total_kcal, total_protein_g, total_carbs_g, total_fat_g,
              kcal_adherence_pct, protein_adherence_pct, training_completed, training_rpe, performance_score
       FROM daily_summaries WHERE user_id = $1
       ORDER BY summary_date DESC LIMIT 7`,
      [userId],
    ),
    query(
      `SELECT tl.session_name, tl.completed, tl.rpe, tl.notes, tl.logged_at
       FROM training_logs tl
       WHERE tl.user_id = $1 AND tl.logged_at >= now() - interval '7 days'
       ORDER BY tl.logged_at DESC`,
      [userId],
    ),
    query(
      `SELECT event_type, description, occurred_at
       FROM events WHERE user_id = $1
       ORDER BY occurred_at DESC LIMIT 5`,
      [userId],
    ),
  ]);

  return {
    goal: goal.rows[0] ?? null,
    plan: plan.rows[0] ?? null,
    remaining: remaining.rows[0] ?? null,
    todayTraining: todayTraining.rows[0] ?? null,
    summaries: summaries.rows,
    trainingLogs: trainingLogs.rows,
    events: events.rows,
  };
}

/* ---------------- Nutrición ---------------- */
export async function getNutrition(userId: string) {
  const [active, history, restrictions, summaries] = await Promise.all([
    query(
      `SELECT id, target_kcal, target_protein_g, target_carbs_g, target_fat_g,
              meal_distribution, nutritionist_name, plan_file_url, created_at
       FROM nutrition_plans WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [userId],
    ),
    query(
      `SELECT id, target_kcal, nutritionist_name, is_active, created_at
       FROM nutrition_plans WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    ),
    query(`SELECT * FROM dietary_restrictions WHERE user_id = $1 LIMIT 1`, [userId]),
    query(
      `SELECT summary_date, total_kcal, total_protein_g, total_carbs_g, total_fat_g,
              kcal_adherence_pct
       FROM daily_summaries WHERE user_id = $1
       ORDER BY summary_date DESC LIMIT 90`,
      [userId],
    ),
  ]);
  return {
    active: active.rows[0] ?? null,
    history: history.rows,
    restrictions: restrictions.rows[0] ?? null,
    summaries: summaries.rows.reverse(),
  };
}

/* ---------------- Comidas frecuentes (CRUD) ---------------- */
export interface MealIngredient {
  food_item_id?: string | null;
  name: string;
  grams: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

function sumMacros(ings: MealIngredient[]) {
  return ings.reduce(
    (a, x) => ({
      total_kcal: a.total_kcal + (x.kcal || 0),
      total_protein_g: a.total_protein_g + (x.protein || 0),
      total_carbs_g: a.total_carbs_g + (x.carbs || 0),
      total_fat_g: a.total_fat_g + (x.fat || 0),
    }),
    { total_kcal: 0, total_protein_g: 0, total_carbs_g: 0, total_fat_g: 0 },
  );
}

export async function listFrequentMeals(userId: string) {
  const { rows } = await query(
    `SELECT id, alias, ingredients, total_kcal, total_protein_g, total_carbs_g,
            total_fat_g, use_count, created_at
     FROM frequent_meals WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  return rows;
}

export async function createFrequentMeal(userId: string, alias: string, ingredients: MealIngredient[]) {
  const m = sumMacros(ingredients);
  const { rows } = await query(
    `INSERT INTO frequent_meals
       (user_id, alias, ingredients, total_kcal, total_protein_g, total_carbs_g, total_fat_g)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     RETURNING *`,
    [userId, alias, JSON.stringify(ingredients), Math.round(m.total_kcal), m.total_protein_g, m.total_carbs_g, m.total_fat_g],
  );
  return rows[0];
}

export async function updateFrequentMeal(userId: string, id: string, alias: string, ingredients: MealIngredient[]) {
  const m = sumMacros(ingredients);
  const { rows } = await query(
    `UPDATE frequent_meals
        SET alias = $3, ingredients = $4::jsonb, total_kcal = $5,
            total_protein_g = $6, total_carbs_g = $7, total_fat_g = $8
      WHERE user_id = $1 AND id = $2
      RETURNING *`,
    [userId, id, alias, JSON.stringify(ingredients), Math.round(m.total_kcal), m.total_protein_g, m.total_carbs_g, m.total_fat_g],
  );
  return rows[0] ?? null;
}

export async function deleteFrequentMeal(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM frequent_meals WHERE user_id = $1 AND id = $2`, [userId, id]);
  return (rowCount ?? 0) > 0;
}

/* ---------------- Restricciones ---------------- */
const RESTRICTION_COLS = [
  "no_beef", "no_chicken", "no_pork", "no_fish", "no_dairy",
  "no_eggs", "vegan", "vegetarian", "celiac", "lactose_intolerant",
] as const;

export async function upsertRestrictions(userId: string, flags: Record<string, boolean>, other: string | null) {
  const cols = RESTRICTION_COLS.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
  const vals = RESTRICTION_COLS.map((c) => Boolean(flags[c]));
  const { rows } = await query(
    `INSERT INTO dietary_restrictions
       (user_id, ${RESTRICTION_COLS.join(", ")}, other)
     VALUES ($1, ${RESTRICTION_COLS.map((_, i) => `$${i + 2}`).join(", ")}, $${RESTRICTION_COLS.length + 2})
     ON CONFLICT (user_id) DO UPDATE SET ${cols}, other = EXCLUDED.other
     RETURNING *`,
    [userId, ...vals, other],
  );
  return rows[0];
}

/* ---------------- Entrenamiento ---------------- */
export async function getTraining(userId: string) {
  const [plan, logs, prs] = await Promise.all([
    query(
      `SELECT id, day_of_week, session_type, session_name, approx_time, duration_min, coach_name
       FROM training_plans WHERE user_id = $1 AND is_active = true
       ORDER BY day_of_week`,
      [userId],
    ),
    query(
      `SELECT id, session_name, completed, rpe, notes, modifications, logged_at
       FROM training_logs WHERE user_id = $1
       ORDER BY logged_at DESC LIMIT 90`,
      [userId],
    ),
    query(
      `SELECT id, description, context, occurred_at
       FROM events WHERE user_id = $1 AND event_type = 'pr'
       ORDER BY occurred_at DESC`,
      [userId],
    ),
  ]);

  const total = logs.rows.length;
  const done = logs.rows.filter((r: any) => r.completed).length;
  const rpes = logs.rows.filter((r: any) => r.rpe != null).map((r: any) => r.rpe as number);
  const avgRpe = rpes.length ? +(rpes.reduce((a, b) => a + b, 0) / rpes.length).toFixed(1) : null;

  return {
    plan: plan.rows,
    logs: logs.rows,
    prs: prs.rows,
    stats: { done, planned: total, rate: total ? +((done / total) * 100).toFixed(1) : 0, avgRpe },
  };
}

/* ---------------- Salud y cuerpo ---------------- */
export async function getHealth(userId: string) {
  const [user, med] = await Promise.all([
    query(
      `SELECT weight_kg, height_cm, body_fat_pct, updated_at FROM users WHERE id = $1`,
      [userId],
    ),
    query(
      `SELECT active_injuries, past_injuries, chronic_conditions, allergies, medications,
              ecg_file_url, xray_file_url, blood_work_url, medical_clearance_url
       FROM medical_history WHERE user_id = $1 LIMIT 1`,
      [userId],
    ),
  ]);
  return { body: user.rows[0] ?? null, medical: med.rows[0] ?? null };
}

export async function updateBody(
  userId: string,
  patch: { weight_kg?: number; body_fat_pct?: number; height_cm?: number },
) {
  const sets: string[] = [];
  const vals: unknown[] = [userId];
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) continue;
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return null;
  const { rows } = await query(
    `UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1
     RETURNING weight_kg, height_cm, body_fat_pct`,
    vals,
  );
  return rows[0] ?? null;
}

export async function updateActiveInjuries(userId: string, injuries: unknown[]) {
  const { rows } = await query(
    `INSERT INTO medical_history (user_id, active_injuries)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET active_injuries = EXCLUDED.active_injuries
     RETURNING active_injuries`,
    [userId, JSON.stringify(injuries)],
  );
  return rows[0];
}

/* ---------------- Journey ---------------- */
export async function getJourney(userId: string) {
  const [events, summaries, cards] = await Promise.all([
    query(
      `SELECT id, event_type, description, severity, occurred_at, resolved_at
       FROM events WHERE user_id = $1
       ORDER BY occurred_at DESC LIMIT 100`,
      [userId],
    ),
    query(
      `SELECT summary_date, performance_score, kcal_adherence_pct, training_completed
       FROM daily_summaries WHERE user_id = $1
       ORDER BY summary_date DESC LIMIT 90`,
      [userId],
    ),
    query(
      `SELECT id, card_type, week_number, total_weeks, stats_snapshot,
              narrative_text, image_url, shared, created_at
       FROM journey_cards WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    ),
  ]);
  return {
    events: events.rows,
    scoreSeries: summaries.rows
      .reverse()
      .map((r: any) => r.performance_score)
      .filter((v: number | null) => v != null),
    cards: cards.rows,
  };
}
