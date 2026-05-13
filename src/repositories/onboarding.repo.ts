import { query, tx } from "../config/db.js";
import type {
  Step1Data, Step2Data, Step3Data, Step4Data,
  Step5Data, Step6Data, Step7Data, ConsentData,
} from "../schemas/onboarding.schema.js";

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
export async function createUser(input: {
  email?: string | null;
  phone_wa?: string | null;
}): Promise<UserRow> {
  const { rows } = await query<UserRow>(
    `INSERT INTO users (email, phone_wa, onboarding_step, active)
     VALUES ($1, $2, 0, true)
     RETURNING id, name, email, phone_wa, wa_chat_id, active, onboarding_step, created_at`,
    [input.email ?? null, input.phone_wa ?? null],
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
      d.phone_wa ?? null,
    ],
  );
  return rows[0];
}

// ── Step 2: Medical history → medical_history ─────────────
export async function saveStep2(userId: string, d: Step2Data) {
  return tx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO medical_history
         (user_id, active_injuries, past_injuries, chronic_conditions, allergies, medications)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         active_injuries = EXCLUDED.active_injuries,
         past_injuries = EXCLUDED.past_injuries,
         chronic_conditions = EXCLUDED.chronic_conditions,
         allergies = EXCLUDED.allergies,
         medications = EXCLUDED.medications
       RETURNING id`,
      [
        userId,
        JSON.stringify(d.active_injuries),
        JSON.stringify(d.past_injuries),
        JSON.stringify(d.chronic_conditions),
        JSON.stringify(d.allergies),
        JSON.stringify(d.medications),
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
export async function saveStep3(userId: string, d: Step3Data) {
  return tx(async (client) => {
    await client.query(
      `UPDATE goals SET is_active = false WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO goals
         (user_id, event_type, event_name, event_date, distance, objective_notes, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id`,
      [
        userId,
        d.event_type,
        d.event_name ?? null,
        d.event_date,
        d.distance ?? null,
        d.objective_notes ?? null,
      ],
    );
    await client.query(
      `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 3) WHERE id = $1`,
      [userId],
    );
    return rows[0];
  });
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
          meal_distribution, nutritionist_name, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING id`,
      [
        userId,
        d.target_kcal,
        d.target_protein_g,
        d.target_carbs_g,
        d.target_fat_g,
        d.meal_distribution ? JSON.stringify(d.meal_distribution) : null,
        d.nutritionist_name ?? null,
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
          day.approx_time ?? null,
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
  return rows[0];
}
