import { query, tx } from "../config/db.js";

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
  const [
    goal,
    plan,
    remaining,
    todayTraining,
    weekPlan,
    summaries,
    trainingLogs,
    monthlyAgg,
    events,
  ] = await Promise.all([
    query(
      `SELECT event_type, event_name, event_date, distance, objective_notes,
              goal_kind, goal_metric_value, goal_metric_unit, goal_metric_label,
              created_at
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
    // Sesiones planeadas en la semana (filas activas en training_plans que no
    // son descanso). Lo necesita el HomeAmateur para "X de Y sesiones".
    query(
      `SELECT COUNT(*)::int AS planned
       FROM training_plans
       WHERE user_id = $1 AND is_active = true
         AND COALESCE(session_type, '') <> 'rest'`,
      [userId],
    ),
    query(
      `SELECT summary_date, total_kcal, total_protein_g, total_carbs_g, total_fat_g,
              kcal_adherence_pct, protein_adherence_pct, training_completed, training_rpe, performance_score
       FROM daily_summaries WHERE user_id = $1
       ORDER BY summary_date DESC LIMIT 30`,
      [userId],
    ),
    query(
      `SELECT tl.session_name, tl.completed, tl.rpe, tl.notes, tl.logged_at
       FROM training_logs tl
       WHERE tl.user_id = $1 AND tl.logged_at >= now() - interval '7 days'
       ORDER BY tl.logged_at DESC`,
      [userId],
    ),
    // Agregados 30 dias: sesiones completadas y promedio de adherencia kcal.
    // Lo usa el bloque "Este mes" del HomeAmateur sin tener que recomputar.
    query(
      `SELECT
         (SELECT COUNT(*)::int FROM training_logs
            WHERE user_id = $1 AND completed = true
              AND logged_at >= now() - interval '30 days') AS sessions_done_30d,
         (SELECT ROUND(AVG(kcal_adherence_pct))::int FROM daily_summaries
            WHERE user_id = $1 AND summary_date >= (now()::date - interval '30 days')
              AND kcal_adherence_pct IS NOT NULL) AS nutrition_pct_30d,
         (SELECT ROUND(AVG(kcal_adherence_pct))::int FROM daily_summaries
            WHERE user_id = $1 AND summary_date >= (now()::date - interval '7 days')
              AND kcal_adherence_pct IS NOT NULL) AS nutrition_pct_7d`,
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
    weekSessionsPlanned: weekPlan.rows[0]?.planned ?? 0,
    summaries: summaries.rows,
    trainingLogs: trainingLogs.rows,
    monthly: {
      sessionsDone30d: monthlyAgg.rows[0]?.sessions_done_30d ?? 0,
      nutritionPct30d: monthlyAgg.rows[0]?.nutrition_pct_30d ?? null,
      nutritionPct7d: monthlyAgg.rows[0]?.nutrition_pct_7d ?? null,
    },
    events: events.rows,
  };
}

/* ---------------- Nutrición ---------------- */
export async function getNutrition(userId: string) {
  const [active, history, restrictions, summaries] = await Promise.all([
    query(
      `SELECT np.id, np.target_kcal, np.target_protein_g, np.target_carbs_g,
              np.target_fat_g, np.meal_distribution, np.nutritionist_name,
              CASE WHEN EXISTS (
                     SELECT 1 FROM nutrition_plan_files f
                     WHERE f.user_id = np.user_id AND f.is_active = true
                   )
                   THEN '/api/profile/' || np.user_id || '/nutrition/plan/file'
                   ELSE np.plan_file_url
              END AS plan_file_url,
              np.created_at
       FROM nutrition_plans np
       WHERE np.user_id = $1 AND np.is_active = true LIMIT 1`,
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

/* ---------------- Identidad (datos personales) ---------------- */
export async function updateIdentity(
  userId: string,
  patch: { name?: string; age?: number; sex?: "M" | "F" | "X"; email?: string; phone_wa?: string; timezone?: string },
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
     RETURNING id AS user_id, name, age, sex, email, phone_wa, timezone`,
    vals,
  );
  return rows[0] ?? null;
}

export async function deleteUser(userId: string): Promise<boolean> {
  // ON DELETE CASCADE en todas las FKs → borra medical_history, goals,
  // nutrition_plans, training_plans, frequent_meals, meal_logs,
  // training_logs, events, daily_summaries, journey_cards, consents,
  // dietary_restrictions, user_preferences, medical_documents, etc.
  const { rowCount } = await query(`DELETE FROM users WHERE id = $1`, [userId]);
  return (rowCount ?? 0) > 0;
}

/* ---------------- Plan nutricional (editar macros) ---------------- */
export async function updateNutritionPlan(
  userId: string,
  d: { target_kcal: number; target_protein_g: number; target_carbs_g: number; target_fat_g: number; nutritionist_name?: string | null },
) {
  // Espejo de saveStep4: el plan activo es inmutable, se desactiva y se
  // crea uno nuevo (los cambios "aplican desde mañana, no retroactivos").
  return tx(async (client) => {
    const prev = await client.query(
      `SELECT meal_distribution, nutritionist_name, plan_file_url
       FROM nutrition_plans WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [userId],
    );
    await client.query(
      `UPDATE nutrition_plans SET is_active = false WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    const carry = prev.rows[0] ?? {};
    const { rows } = await client.query(
      `INSERT INTO nutrition_plans
         (user_id, target_kcal, target_protein_g, target_carbs_g, target_fat_g,
          meal_distribution, nutritionist_name, plan_file_url, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       RETURNING id, target_kcal, target_protein_g, target_carbs_g, target_fat_g,
                 nutritionist_name, plan_file_url, created_at`,
      [
        userId,
        Math.round(d.target_kcal),
        Math.round(d.target_protein_g),
        Math.round(d.target_carbs_g),
        Math.round(d.target_fat_g),
        carry.meal_distribution ?? null,
        d.nutritionist_name ?? carry.nutritionist_name ?? null,
        carry.plan_file_url ?? null,
      ],
    );
    return rows[0];
  });
}

/**
 * Sube el PDF del plan como referencia descargable. A diferencia del flujo de
 * onboarding NO pasa por Gemini: el perfil web edita los macros aparte (macro
 * editor), acá solo se guarda el archivo. parsed_data queda como stub para
 * cumplir el NOT NULL del schema sin acoplar a la IA.
 */
export async function saveProfileNutritionPlanFile(
  userId: string,
  file: { bytes: Buffer; mime: string; name: string },
) {
  return tx(async (client) => {
    await client.query(
      `UPDATE nutrition_plan_files SET is_active = false
       WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    const nutri = await client.query<{ nutritionist_name: string | null }>(
      `SELECT nutritionist_name FROM nutrition_plans
       WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [userId],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO nutrition_plan_files
         (user_id, nutritionist_name, raw_file_bytes, raw_file_mime,
          raw_file_name, raw_file_size, parsed_data, parser_version, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, true)
       RETURNING id`,
      [
        userId,
        nutri.rows[0]?.nutritionist_name ?? null,
        file.bytes,
        file.mime,
        file.name,
        file.bytes.length,
        JSON.stringify({ source: "profile_upload" }),
        "profile-upload-v1",
      ],
    );
    return { file_id: rows[0].id };
  });
}

export async function deactivateNutritionPlanFile(userId: string): Promise<boolean> {
  return tx(async (client) => {
    const f = await client.query(
      `UPDATE nutrition_plan_files SET is_active = false
       WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    await client.query(
      `UPDATE nutrition_plans SET plan_file_url = NULL
       WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    return (f.rowCount ?? 0) > 0;
  });
}

export async function getNutritionPlanFileBytes(userId: string) {
  const { rows } = await query<{
    raw_file_bytes: Buffer | null;
    raw_file_mime: string | null;
    raw_file_name: string | null;
  }>(
    `SELECT raw_file_bytes, raw_file_mime, raw_file_name
     FROM nutrition_plan_files
     WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

/* ---------------- Médico (crónicas / medicación / alergias / pasadas) ---------------- */
const MEDICAL_JSON_COLS = ["chronic_conditions", "allergies", "medications", "past_injuries", "active_injuries"] as const;
type MedicalCol = (typeof MEDICAL_JSON_COLS)[number];

export async function updateMedical(userId: string, patch: Partial<Record<MedicalCol, unknown[]>>) {
  const cols = Object.keys(patch).filter((k): k is MedicalCol => (MEDICAL_JSON_COLS as readonly string[]).includes(k));
  if (!cols.length) return null;
  // Upsert: si no existe la fila medical_history, se crea con defaults.
  const insertCols = cols.join(", ");
  const insertPlaceholders = cols.map((_, i) => `$${i + 2}::jsonb`).join(", ");
  const updateSet = cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
  const vals = cols.map((c) => JSON.stringify(patch[c] ?? []));
  const { rows } = await query(
    `INSERT INTO medical_history (user_id, ${insertCols})
     VALUES ($1, ${insertPlaceholders})
     ON CONFLICT (user_id) DO UPDATE SET ${updateSet}
     RETURNING chronic_conditions, allergies, medications, past_injuries, active_injuries`,
    [userId, ...vals],
  );
  return rows[0];
}

/* ---------------- Documentos clínicos ---------------- */
const SLOT_URL_COL: Record<string, string> = {
  ecg: "ecg_file_url",
  xray: "xray_file_url",
  blood_work: "blood_work_url",
  medical_clearance: "medical_clearance_url",
};

export async function listMedicalDocuments(userId: string) {
  const { rows } = await query(
    `SELECT id, slot, doc_type, raw_file_mime, raw_file_name, raw_file_size, created_at
     FROM medical_documents WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

export async function createMedicalDocument(
  userId: string,
  doc: { slot: string; doc_type: string; bytes: Buffer; mime: string; name: string; size: number },
) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO medical_documents
         (user_id, slot, doc_type, raw_file_bytes, raw_file_mime, raw_file_name, raw_file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, slot, doc_type, raw_file_mime, raw_file_name, raw_file_size, created_at`,
      [userId, doc.slot, doc.doc_type, doc.bytes, doc.mime, doc.name, doc.size],
    );
    const id = rows[0].id;
    const urlCol = SLOT_URL_COL[doc.slot];
    if (urlCol) {
      // medical_history es 1:1 — upsert para no romper si la fila no existe.
      await client.query(
        `INSERT INTO medical_history (user_id, ${urlCol})
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET ${urlCol} = EXCLUDED.${urlCol}`,
        [userId, `/api/profile/${userId}/documents/${id}/file`],
      );
    }
    return rows[0];
  });
}

export async function getMedicalDocumentBytes(userId: string, id: string) {
  const { rows } = await query<{
    raw_file_bytes: Buffer;
    raw_file_mime: string;
    raw_file_name: string;
  }>(
    `SELECT raw_file_bytes, raw_file_mime, raw_file_name
     FROM medical_documents WHERE user_id = $1 AND id = $2 LIMIT 1`,
    [userId, id],
  );
  return rows[0] ?? null;
}

export async function deleteMedicalDocument(userId: string, id: string): Promise<boolean> {
  return tx(async (client) => {
    const { rows } = await client.query<{ slot: string }>(
      `DELETE FROM medical_documents WHERE user_id = $1 AND id = $2 RETURNING slot`,
      [userId, id],
    );
    if (!rows[0]) return false;
    const urlCol = SLOT_URL_COL[rows[0].slot];
    if (urlCol) {
      // Si quedan otros docs del mismo slot, apuntar al más reciente; si no, NULL.
      const latest = await client.query<{ id: string }>(
        `SELECT id FROM medical_documents
         WHERE user_id = $1 AND slot = $2 ORDER BY created_at DESC LIMIT 1`,
        [userId, rows[0].slot],
      );
      const newUrl = latest.rows[0]
        ? `/api/profile/${userId}/documents/${latest.rows[0].id}/file`
        : null;
      await client.query(
        `UPDATE medical_history SET ${urlCol} = $2 WHERE user_id = $1`,
        [userId, newUrl],
      );
    }
    return true;
  });
}

/* ---------------- Preferencias (recordatorios / tono / privacidad) ---------------- */
export async function getPreferences(userId: string) {
  const { rows } = await query<{ prefs: Record<string, unknown> }>(
    `SELECT prefs FROM user_preferences WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return rows[0]?.prefs ?? null;
}

export async function upsertPreferences(userId: string, prefs: Record<string, unknown>) {
  const { rows } = await query<{ prefs: Record<string, unknown> }>(
    `INSERT INTO user_preferences (user_id, prefs, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()
     RETURNING prefs`,
    [userId, JSON.stringify(prefs)],
  );
  return rows[0].prefs;
}

/* ---------------- Export (Ley 25.326 — derecho de acceso) ---------------- */
export async function exportAll(userId: string) {
  const [user, medical, goals, plans, restrictions, training, meals, mealLogs, trainingLogs, events, summaries, cards, prefs, docs] =
    await Promise.all([
      query(`SELECT * FROM users WHERE id = $1`, [userId]),
      query(`SELECT * FROM medical_history WHERE user_id = $1`, [userId]),
      query(`SELECT * FROM goals WHERE user_id = $1 ORDER BY created_at`, [userId]),
      query(`SELECT id, target_kcal, target_protein_g, target_carbs_g, target_fat_g, nutritionist_name, is_active, created_at FROM nutrition_plans WHERE user_id = $1 ORDER BY created_at`, [userId]),
      query(`SELECT * FROM dietary_restrictions WHERE user_id = $1`, [userId]),
      query(`SELECT id, day_of_week, session_type, session_name, approx_time, duration_min, coach_name, is_active FROM training_plans WHERE user_id = $1 ORDER BY day_of_week`, [userId]),
      query(`SELECT * FROM frequent_meals WHERE user_id = $1 ORDER BY created_at`, [userId]),
      query(`SELECT * FROM meal_logs WHERE user_id = $1 ORDER BY logged_at`, [userId]),
      query(`SELECT * FROM training_logs WHERE user_id = $1 ORDER BY logged_at`, [userId]),
      query(`SELECT * FROM events WHERE user_id = $1 ORDER BY occurred_at`, [userId]),
      query(`SELECT * FROM daily_summaries WHERE user_id = $1 ORDER BY summary_date`, [userId]),
      query(`SELECT id, card_type, week_number, total_weeks, narrative_text, shared, created_at FROM journey_cards WHERE user_id = $1 ORDER BY created_at`, [userId]),
      query(`SELECT prefs, updated_at FROM user_preferences WHERE user_id = $1`, [userId]),
      query(`SELECT id, slot, doc_type, raw_file_mime, raw_file_name, raw_file_size, created_at FROM medical_documents WHERE user_id = $1 ORDER BY created_at`, [userId]),
    ]);
  return {
    exported_at: new Date().toISOString(),
    user: user.rows[0] ?? null,
    medical_history: medical.rows[0] ?? null,
    goals: goals.rows,
    nutrition_plans: plans.rows,
    dietary_restrictions: restrictions.rows[0] ?? null,
    training_plans: training.rows,
    frequent_meals: meals.rows,
    meal_logs: mealLogs.rows,
    training_logs: trainingLogs.rows,
    events: events.rows,
    daily_summaries: summaries.rows,
    journey_cards: cards.rows,
    preferences: prefs.rows[0] ?? null,
    medical_documents: docs.rows,
  };
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
