import { query, tx } from "../config/db.js";
import type {
  Step1Data, Step2Data, Step3Data, Step4Data,
  Step5Data, Step6Data, Step7Data, ConsentData,
} from "../schemas/onboarding.schema.js";
import { invalidateUserDict } from "../bot/parser/training-matcher.js";
import { normalizeArPhone } from "../utils/phone.js";
import { recomputeAutoTargetSafe } from "../services/nutrition-target.service.js";
import type {
  ParsedNutritionPlan, ParsedTrainingPlanRich,
} from "../services/plan-pdf-parser.service.js";

export function sanitizeTime(timeStr: string | null | undefined): string | null {
  if (!timeStr) return null;
  const trimmed = timeStr.trim();
  const match = trimmed.match(/\b([0-1]?[0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9]))?\b/);
  if (match) {
    const hours = match[1].padStart(2, "0");
    const minutes = match[2];
    const seconds = match[3] || "00";
    return `${hours}:${minutes}:${seconds}`;
  }
  return null;
}

interface UserRow {
  id: string;
  name: string | null;
  email: string | null;
  phone_wa: string | null;
  wa_chat_id: string | null;
  active: boolean;
  onboarding_step: number;
  created_at: Date;
}

// ── Start: create empty user shell ────────────────────────
// Idempotente por email: si alguien reintenta el alta con un email que ya
// arrancó, NO explotamos (antes: unique violation → 500). Devolvemos el shell
// existente para que retome el onboarding donde lo dejó. Sin email (null) cada
// start crea una fila nueva (los NULL no colisionan en el unique index).
export async function createUser(input: {
  email?: string | null;
  phone_wa?: string | null;
}): Promise<UserRow> {
  const email = input.email ?? null;
  const phone = input.phone_wa ? normalizeArPhone(input.phone_wa) : null;
  const { rows } = await query<UserRow>(
    `INSERT INTO users (email, phone_wa, onboarding_step, active)
     VALUES ($1, $2, 0, true)
     ON CONFLICT (email) DO UPDATE
       SET phone_wa = COALESCE(EXCLUDED.phone_wa, users.phone_wa)
     RETURNING id, name, email, phone_wa, wa_chat_id, active, onboarding_step, created_at`,
    [email, phone],
  );
  return rows[0];
}

export async function getUser(userId: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>(
    `SELECT id, name, email, phone_wa, wa_chat_id, active, onboarding_step, created_at
     FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

// ── Step 1: Personal info → users ─────────────────────────
export async function saveStep1(userId: string, d: Step1Data) {
  const { rows } = await query<{ id: string; onboarding_step: number }>(
    `UPDATE users
     SET name = $2,
         email = $3,
         age = $4,
         sex = $5,
         weight_kg = $6,
         height_cm = $7,
         body_fat_pct = $8,
         phone_wa = COALESCE($9, phone_wa),
         onboarding_step = GREATEST(onboarding_step, 1)
     WHERE id = $1
     RETURNING id, onboarding_step`,
    [
      userId,
      d.name,
      d.email,
      d.age,
      d.sex,
      d.weight_kg,
      d.height_cm,
      d.body_fat_pct ?? null,
      d.phone_wa ? normalizeArPhone(d.phone_wa) : null,
    ],
  );
  return rows[0];
}

// ── Step 2: Medical history → medical_history ─────────────
export async function saveStep2(userId: string, d: Step2Data) {
  return tx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO medical_history
         (user_id, active_injuries, past_injuries, chronic_conditions, allergies, medications,
          ecg_file_url, xray_file_url, blood_work_url, medical_clearance_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id) DO UPDATE SET
         active_injuries = EXCLUDED.active_injuries,
         past_injuries = EXCLUDED.past_injuries,
         chronic_conditions = EXCLUDED.chronic_conditions,
         allergies = EXCLUDED.allergies,
         medications = EXCLUDED.medications,
         ecg_file_url = EXCLUDED.ecg_file_url,
         xray_file_url = EXCLUDED.xray_file_url,
         blood_work_url = EXCLUDED.blood_work_url,
         medical_clearance_url = EXCLUDED.medical_clearance_url
       RETURNING id`,
      [
        userId,
        JSON.stringify(d.active_injuries),
        JSON.stringify(d.past_injuries),
        JSON.stringify(d.chronic_conditions),
        JSON.stringify(d.allergies),
        JSON.stringify(d.medications),
        d.ecg_file_url ?? null,
        d.xray_file_url ?? null,
        d.blood_work_url ?? null,
        d.medical_clearance_url ?? null,
      ],
    );
    await client.query(
      `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 2) WHERE id = $1`,
      [userId],
    );
    return rows[0];
  });
}

// ── Step 3: Goal → goals ──────────────────────────────────
// Hay UNIQUE INDEX (user_id) WHERE is_active = true → necesita tx.
// Soporta dos shapes:
//   ELITE → event_type ∈ competition|recomp|performance con event_date.
//   AMATEUR → event_type = personal_goal con goal_kind + metric dinamico.
export async function saveStep3(userId: string, d: Step3Data) {
  const result = await tx(async (client) => {
    await client.query(
      `UPDATE goals SET is_active = false WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO goals
         (user_id, event_type, event_name, event_date, distance, objective_notes,
          goal_kind, goal_metric_value, goal_metric_unit, goal_metric_label, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
       RETURNING id`,
      [
        userId,
        d.event_type,
        d.event_name ?? null,
        d.event_date ?? null,
        d.distance ?? null,
        d.objective_notes ?? null,
        d.goal_kind ?? null,
        d.goal_metric_value ?? null,
        d.goal_metric_unit ?? null,
        d.goal_metric_label ?? null,
      ],
    );
    await client.query(
      `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 3) WHERE id = $1`,
      [userId],
    );
    return rows[0];
  });
  // Cambió la meta → recalcular el target auto (no-op si el user tiene plan
  // manual). Fuera de la tx: un fallo acá no debe abortar el guardado del goal.
  await recomputeAutoTargetSafe(userId);
  return result;
}

// Lectura del goal activo (lo usa el cron nocturno para pasar contexto
// a Gemini y los mensajes amateur lo muestran como push diario).
export interface ActiveGoal {
  event_type: string;
  event_name: string | null;
  event_date: string | null;
  distance: string | null;
  objective_notes: string | null;
  goal_kind: string | null;
  goal_metric_value: number | null;
  goal_metric_unit: string | null;
  goal_metric_label: string | null;
}

export async function getActiveGoal(userId: string): Promise<ActiveGoal | null> {
  const { rows } = await query<ActiveGoal>(
    `SELECT event_type, event_name, event_date, distance, objective_notes,
            goal_kind, goal_metric_value, goal_metric_unit, goal_metric_label
     FROM goals
     WHERE user_id = $1 AND is_active = true
     LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

// ── Step 4: Nutrition plan → nutrition_plans ──────────────
export async function saveStep4(userId: string, d: Step4Data) {
  return tx(async (client) => {
    await client.query(
      `UPDATE nutrition_plans SET is_active = false
       WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO nutrition_plans
         (user_id, target_kcal, target_protein_g, target_carbs_g, target_fat_g,
          meal_distribution, nutritionist_name, plan_file_url, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       RETURNING id`,
      [
        userId,
        d.target_kcal,
        d.target_protein_g,
        d.target_carbs_g,
        d.target_fat_g,
        d.meal_distribution ? JSON.stringify(d.meal_distribution) : null,
        d.nutritionist_name ?? null,
        d.plan_file_url ?? null,
      ],
    );
    await client.query(
      `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 4) WHERE id = $1`,
      [userId],
    );
    return rows[0];
  });
}

// ── Step 5: Dietary restrictions → dietary_restrictions ───
export async function saveStep5(userId: string, d: Step5Data) {
  return tx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO dietary_restrictions
         (user_id, no_beef, no_chicken, no_pork, no_fish, no_dairy, no_eggs,
          vegan, vegetarian, celiac, lactose_intolerant, other)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (user_id) DO UPDATE SET
         no_beef = EXCLUDED.no_beef,
         no_chicken = EXCLUDED.no_chicken,
         no_pork = EXCLUDED.no_pork,
         no_fish = EXCLUDED.no_fish,
         no_dairy = EXCLUDED.no_dairy,
         no_eggs = EXCLUDED.no_eggs,
         vegan = EXCLUDED.vegan,
         vegetarian = EXCLUDED.vegetarian,
         celiac = EXCLUDED.celiac,
         lactose_intolerant = EXCLUDED.lactose_intolerant,
         other = EXCLUDED.other
       RETURNING id`,
      [
        userId,
        d.no_beef, d.no_chicken, d.no_pork, d.no_fish,
        d.no_dairy, d.no_eggs, d.vegan, d.vegetarian,
        d.celiac, d.lactose_intolerant, d.other ?? null,
      ],
    );
    await client.query(
      `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 5) WHERE id = $1`,
      [userId],
    );
    return rows[0];
  });
}

// ── Step 6: Training plan → training_plans (full replace) ──
export async function saveStep6(userId: string, d: Step6Data) {
  return tx(async (client) => {
    await client.query(
      `UPDATE training_plans SET is_active = false
       WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    for (const day of d.training_days) {
      await client.query(
        `INSERT INTO training_plans
           (user_id, day_of_week, session_type, session_name, approx_time,
            duration_min, coach_name, exercises, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [
          userId,
          day.day_of_week,
          day.session_type,
          day.session_name ?? null,
          sanitizeTime(day.approx_time),
          day.duration_min ?? null,
          d.coach_name ?? null,
          day.exercises ? JSON.stringify(day.exercises) : null,
        ],
      );
    }
    await client.query(
      `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 6) WHERE id = $1`,
      [userId],
    );
    invalidateUserDict(userId);
    return { saved: d.training_days.length };
  });
}

// ── Step 7: Frequent meals → frequent_meals (full replace) ──
export async function saveStep7(userId: string, d: Step7Data) {
  return tx(async (client) => {
    await client.query(`DELETE FROM frequent_meals WHERE user_id = $1`, [userId]);
    for (const meal of d.meals) {
      await client.query(
        `INSERT INTO frequent_meals
           (user_id, alias, ingredients, total_kcal,
            total_protein_g, total_carbs_g, total_fat_g)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          meal.alias.toLowerCase().trim(),
          JSON.stringify(meal.ingredients),
          meal.total_kcal,
          meal.total_protein_g,
          meal.total_carbs_g,
          meal.total_fat_g,
        ],
      );
    }
    await client.query(
      `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 7) WHERE id = $1`,
      [userId],
    );
    return { saved: d.meals.length };
  });
}

// ── Nutrition plan: upload PDF + parseo rico ───────────────
// Escribe en DOS tablas (espejo del flujo de training):
//  * nutrition_plan_files: PDF crudo + parsed_data (jsonb rico).
//  * nutrition_plans: macros + meal_distribution legacy (queries del bot).
// PUT /step/4 (saveStep4) solo toca nutrition_plans, asi que el archivo
// y el parseo rico sobreviven a futuros saves de macros.
export interface NutritionUploadInput {
  fileBytes: Buffer;
  fileMime: string;
  fileName: string;
  parsed: ParsedNutritionPlan;
  parserVersion: string;
}

export async function saveNutritionPlanUpload(
  userId: string,
  input: NutritionUploadInput,
) {
  const p = input.parsed;
  // Clamps por los CHECK constraints (target_kcal BETWEEN 800 AND 8000,
  // macros >= 0). Si el parser no encontro macros la UI los va a pedir
  // a mano en el preview antes del PUT /step/4.
  const clamp = (n: number | null | undefined, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, Math.round(n ?? lo)));
  const kcal = clamp(p.targets.kcal, 800, 8000);
  const protein = Math.max(0, Math.round(p.targets.protein_g ?? 0));
  const carbs = Math.max(0, Math.round(p.targets.carbs_g ?? 0));
  const fat = Math.max(0, Math.round(p.targets.fat_g ?? 0));
  // meal_distribution legacy: {meal: {kcal, ...}}. Mantenemos para
  // compatibilidad con v_daily_remaining; el detalle rico va a parsed_data.
  const mealDist: Record<string, { kcal: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null }> = {};
  for (const meal of p.meal_distribution) {
    mealDist[meal.meal_id] = {
      kcal: meal.macros.kcal,
      protein_g: meal.macros.protein_g,
      carbs_g: meal.macros.carbs_g,
      fat_g: meal.macros.fat_g,
    };
  }
  return tx(async (client) => {
    // 1. Desactivar planes vigentes en ambas tablas (replace-on-upload).
    await client.query(
      `UPDATE nutrition_plan_files SET is_active = false
       WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    await client.query(
      `UPDATE nutrition_plans SET is_active = false
       WHERE user_id = $1 AND is_active = true`,
      [userId],
    );

    // 2. nutrition_plan_files: PDF crudo + parsed_data rico.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO nutrition_plan_files
         (user_id, nutritionist_name, raw_file_bytes, raw_file_mime,
          raw_file_name, raw_file_size, parsed_data, parser_version, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       RETURNING id`,
      [
        userId,
        p.nutritionist_name ?? null,
        input.fileBytes,
        input.fileMime,
        input.fileName,
        input.fileBytes.length,
        JSON.stringify(p),
        input.parserVersion,
      ],
    );

    // 3. nutrition_plans: macros + meal_distribution para queries del bot.
    await client.query(
      `INSERT INTO nutrition_plans
         (user_id, target_kcal, target_protein_g, target_carbs_g, target_fat_g,
          meal_distribution, nutritionist_name, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [
        userId,
        kcal,
        protein,
        carbs,
        fat,
        Object.keys(mealDist).length ? JSON.stringify(mealDist) : null,
        p.nutritionist_name ?? null,
      ],
    );

    await client.query(
      `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 4) WHERE id = $1`,
      [userId],
    );
    return { file_id: rows[0].id };
  });
}

// ── Training plan: upload PDF + parseo rico ────────────────
// Persiste training_plan_files (PDF + JSON rico) Y rehidrata training_plans
// (row-per-day) para que los queries del bot sigan funcionando.
const TRAINING_SESSION_TYPES = new Set([
  "gym", "natacion", "bici", "corrida", "funcional",
  "crossfit", "yoga", "movilidad", "descanso", "otro",
]);

export interface TrainingUploadInput {
  fileBytes: Buffer;
  fileMime: string;
  fileName: string;
  parsed: ParsedTrainingPlanRich;
  parserVersion: string;
}

export async function saveTrainingPlanUpload(
  userId: string,
  input: TrainingUploadInput,
) {
  const p = input.parsed;
  return tx(async (client) => {
    // 1. Desactivar plan vigente (file + days)
    await client.query(
      `UPDATE training_plan_files SET is_active = false
       WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    await client.query(
      `UPDATE training_plans SET is_active = false
       WHERE user_id = $1 AND is_active = true`,
      [userId],
    );

    // 2. Persistir el archivo + parsed_data rico
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO training_plan_files
         (user_id, coach_name, raw_file_bytes, raw_file_mime, raw_file_name,
          raw_file_size, parsed_data, parser_version, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       RETURNING id`,
      [
        userId,
        p.coach_name ?? null,
        input.fileBytes,
        input.fileMime,
        input.fileName,
        input.fileBytes.length,
        JSON.stringify(p),
        input.parserVersion,
      ],
    );

    // 3. Rehidratar training_plans (row-per-day) para queries del bot
    for (const day of p.days ?? []) {
      const sessionType = TRAINING_SESSION_TYPES.has(day.session_type)
        ? day.session_type
        : "otro";
      const exercises = (day.exercises ?? []).map((ex) => ({
        name: ex.name,
        aliases: ex.aliases ?? [],
        sets: ex.sets ?? null,
        reps: ex.reps ?? null,
        load_kg: ex.load_kg ?? null,
        notes: ex.notes ?? null,
      }));
      await client.query(
        `INSERT INTO training_plans
           (user_id, day_of_week, session_type, session_name, approx_time,
            duration_min, coach_name, exercises, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [
          userId,
          day.day_of_week,
          sessionType,
          day.session_name ?? null,
          sanitizeTime(day.approx_time),
          day.duration_min ?? null,
          p.coach_name ?? null,
          exercises.length ? JSON.stringify(exercises) : null,
        ],
      );
    }

    await client.query(
      `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 6) WHERE id = $1`,
      [userId],
    );
    invalidateUserDict(userId);
    return { file_id: rows[0].id, days: (p.days ?? []).length };
  });
}

// ── Consent → consents ────────────────────────────────────
export async function saveConsent(
  userId: string,
  d: ConsentData,
  ip: string,
  userAgent: string | null,
) {
  const { rows } = await query<{ id: string; consented_at: Date }>(
    `INSERT INTO consents
       (user_id, data_processing, international_transfer, nutrition_disclaimer,
        ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       data_processing = EXCLUDED.data_processing,
       international_transfer = EXCLUDED.international_transfer,
       nutrition_disclaimer = EXCLUDED.nutrition_disclaimer,
       ip_address = EXCLUDED.ip_address,
       user_agent = EXCLUDED.user_agent,
       consented_at = NOW()
     RETURNING id, consented_at`,
    [userId, d.data_processing, d.international_transfer, d.nutrition_disclaimer, ip, userAgent],
  );
  // Cierre de onboarding: si el amateur no subió plan, generamos su target
  // estimado ahora que ya conocemos peso/meta/entrenamiento. No-op si hay
  // plan manual (elite ya subió macros en el paso 4).
  await recomputeAutoTargetSafe(userId);
  return rows[0];
}
