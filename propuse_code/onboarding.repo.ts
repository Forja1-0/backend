import { query, tx } from '../config/db';
import type {
  Step1Data, Step2Data, Step3Data, Step4Data,
  Step5Data, Step6Data, Step7Data, ConsentData,
} from '../schemas/onboarding.schema';

// ── Start: create user shell ──────────────────────────────
export async function createUser(phoneWa: string | null) {
  const { rows } = await query(
    `INSERT INTO users (phone_wa, onboarding_step, status)
     VALUES ($1, 0, 'onboarding')
     RETURNING id, onboarding_step, status, created_at`,
    [phoneWa]
  );
  return rows[0];
}

export async function getUser(userId: string) {
  const { rows } = await query(
    `SELECT id, name, phone_wa, wa_jid, onboarding_step, status, created_at
     FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// ── Step 1: Personal info → users table ───────────────────
export async function saveStep1(userId: string, d: Step1Data) {
  const { rows } = await query(
    `UPDATE users
     SET name = $2, age = $3, sex = $4, weight_kg = $5, height_cm = $6,
         body_fat_pct = $7, onboarding_step = GREATEST(onboarding_step, 1)
     WHERE id = $1
     RETURNING id, onboarding_step`,
    [userId, d.name, d.age, d.sex, d.weight_kg, d.height_cm, d.body_fat_pct ?? null]
  );
  return rows[0];
}

// ── Step 2: Medical history → medical_history table ───────
export async function saveStep2(userId: string, d: Step2Data) {
  const { rows } = await query(
    `INSERT INTO medical_history (user_id, active_injuries, previous_injuries,
       chronic_conditions, food_allergies, medications)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       active_injuries = EXCLUDED.active_injuries,
       previous_injuries = EXCLUDED.previous_injuries,
       chronic_conditions = EXCLUDED.chronic_conditions,
       food_allergies = EXCLUDED.food_allergies,
       medications = EXCLUDED.medications
     RETURNING id`,
    [
      userId,
      JSON.stringify(d.active_injuries),
      JSON.stringify(d.previous_injuries),
      JSON.stringify(d.chronic_conditions),
      JSON.stringify(d.food_allergies),
      JSON.stringify(d.medications),
    ]
  );
  await query(
    `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 2) WHERE id = $1`,
    [userId]
  );
  return rows[0];
}

// ── Step 3: Goal → goals table ────────────────────────────
export async function saveStep3(userId: string, d: Step3Data) {
  // Deactivate any previous active goal
  await query(
    `UPDATE goals SET is_active = false WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  const { rows } = await query(
    `INSERT INTO goals (user_id, goal_type, event_name, event_date, distance, description, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING id`,
    [userId, d.goal_type, d.event_name ?? null, d.event_date ?? null, d.distance ?? null, d.description ?? null]
  );
  await query(
    `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 3) WHERE id = $1`,
    [userId]
  );
  return rows[0];
}

// ── Step 4: Nutrition plan → nutrition_plans table ────────
export async function saveStep4(userId: string, d: Step4Data) {
  await query(
    `UPDATE nutrition_plans SET is_active = false WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  const { rows } = await query(
    `INSERT INTO nutrition_plans (user_id, target_kcal, target_protein_g, target_carbs_g,
       target_fat_g, meal_distribution, nutritionist_name, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true)
     RETURNING id`,
    [
      userId, d.target_kcal, d.target_protein_g, d.target_carbs_g,
      d.target_fat_g, d.meal_distribution ? JSON.stringify(d.meal_distribution) : null,
      d.nutritionist_name ?? null,
    ]
  );
  await query(
    `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 4) WHERE id = $1`,
    [userId]
  );
  return rows[0];
}

// ── Step 5: Dietary restrictions → dietary_restrictions ───
export async function saveStep5(userId: string, d: Step5Data) {
  const { rows } = await query(
    `INSERT INTO dietary_restrictions (user_id, no_beef, no_chicken, no_pork, no_fish,
       no_dairy, no_egg, vegan, vegetarian, celiac, lactose_intolerant, other)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (user_id) DO UPDATE SET
       no_beef = EXCLUDED.no_beef, no_chicken = EXCLUDED.no_chicken,
       no_pork = EXCLUDED.no_pork, no_fish = EXCLUDED.no_fish,
       no_dairy = EXCLUDED.no_dairy, no_egg = EXCLUDED.no_egg,
       vegan = EXCLUDED.vegan, vegetarian = EXCLUDED.vegetarian,
       celiac = EXCLUDED.celiac, lactose_intolerant = EXCLUDED.lactose_intolerant,
       other = EXCLUDED.other
     RETURNING id`,
    [
      userId, d.no_beef, d.no_chicken, d.no_pork, d.no_fish,
      d.no_dairy, d.no_egg, d.vegan, d.vegetarian,
      d.celiac, d.lactose_intolerant, d.other ?? null,
    ]
  );
  await query(
    `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 5) WHERE id = $1`,
    [userId]
  );
  return rows[0];
}

// ── Step 6: Training plan → training_plans table ──────────
export async function saveStep6(userId: string, d: Step6Data) {
  return tx(async (client) => {
    // Deactivate old plan
    await client.query(
      `UPDATE training_plans SET is_active = false WHERE user_id = $1 AND is_active = true`,
      [userId]
    );

    // Insert each day
    for (const day of d.training_days) {
      await client.query(
        `INSERT INTO training_plans (user_id, day_of_week, session_type, session_name,
           approx_time, duration_min, coach_name, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [
          userId, day.day_of_week, day.session_type, day.session_name,
          day.approx_time ?? null, day.duration_min ?? null,
          d.coach_name ?? null,
        ]
      );
    }

    await client.query(
      `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 6) WHERE id = $1`,
      [userId]
    );
    return { saved: d.training_days.length };
  });
}

// ── Step 7: Frequent meals → frequent_meals table ─────────
export async function saveStep7(userId: string, d: Step7Data) {
  return tx(async (client) => {
    // Delete existing frequent meals (full replace on re-submit)
    await client.query(
      `DELETE FROM frequent_meals WHERE user_id = $1`,
      [userId]
    );

    for (const meal of d.meals) {
      await client.query(
        `INSERT INTO frequent_meals (user_id, alias, ingredients, total_kcal,
           total_protein_g, total_carbs_g, total_fat_g)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId, meal.alias.toLowerCase().trim(),
          JSON.stringify(meal.ingredients),
          meal.total_kcal, meal.total_protein_g,
          meal.total_carbs_g, meal.total_fat_g,
        ]
      );
    }

    await client.query(
      `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 7) WHERE id = $1`,
      [userId]
    );
    return { saved: d.meals.length };
  });
}

// ── Consent → consents table ──────────────────────────────
export async function saveConsent(userId: string, d: ConsentData, ip: string) {
  const { rows } = await query(
    `INSERT INTO consents (user_id, data_processing, international_transfer,
       nutrition_disclaimer, ip_address)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       data_processing = EXCLUDED.data_processing,
       international_transfer = EXCLUDED.international_transfer,
       nutrition_disclaimer = EXCLUDED.nutrition_disclaimer,
       ip_address = EXCLUDED.ip_address,
       consented_at = NOW()
     RETURNING id, consented_at`,
    [userId, d.data_processing, d.international_transfer, d.nutrition_disclaimer, ip]
  );

  // Mark user as active (onboarding complete)
  await query(
    `UPDATE users SET status = 'active' WHERE id = $1`,
    [userId]
  );

  return rows[0];
}

// ── Finalize: mark onboarding complete ────────────────────
export async function completeOnboarding(userId: string) {
  const { rows } = await query(
    `UPDATE users SET status = 'active', onboarding_step = 7
     WHERE id = $1 AND onboarding_step >= 7
     RETURNING id, status`,
    [userId]
  );
  return rows[0] || null;
}
