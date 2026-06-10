/**
 * Wiring del target auto-calculado (modo amateur). Lee los datos del usuario,
 * llama al motor puro (nutrition-target.ts) y persiste el resultado como una
 * fila `nutrition_plans` con `source = 'forja_auto'` — así revive TODO el coach
 * loop existente (v_daily_remaining → getDailyRemaining → assessDay → reco)
 * sin tocar nada de eso.
 *
 * Llamá `recomputeAutoTarget(userId)` cuando cambie algo que mueva el cálculo:
 *  - fin de onboarding (saveConsent)
 *  - cambio de meta (saveStep3)
 *  - cambio de peso/altura/grasa (updateBody) o edad/sexo (updateIdentity)
 *  - (futuro) cambio de peso por WhatsApp → ver fase 3 (weight_logs)
 */

import { query, tx } from "../config/db.js";
import { logger } from "../config/logger.js";
import {
  computeNutritionTarget,
  type AmateurGoalKind,
  type NutritionTarget,
  type Sex,
} from "./nutrition-target.js";

interface UserStatsRow {
  sex: Sex | null;
  age: number | null;
  weight_kg: number | null;
  height_cm: number | null;
}

/**
 * (Re)calcula y persiste el target estimado. Idempotente y best-effort.
 *
 * Reglas de guarda:
 *  - Si el plan activo es `source = 'manual'` → NO toca nada (respeta el plan
 *    del nutri / la edición manual del user). Este guard es además lo que
 *    restringe el auto-target a usuarios sin plan manual = el ICP amateur.
 *  - Si faltan datos del user (sexo/edad/peso/altura) → no genera nada.
 *
 * Devuelve el target persistido, o `null` si no se generó (guard o datos).
 */
export async function recomputeAutoTarget(userId: string): Promise<NutritionTarget | null> {
  // 1. Respetar un plan manual activo (nutri o macro-editor del perfil).
  const { rows: planRows } = await query<{ source: string }>(
    `SELECT source FROM nutrition_plans
     WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId],
  );
  if (planRows[0]?.source === "manual") return null;

  // 2. Datos del user. Sin estos no hay cálculo posible.
  const { rows: userRows } = await query<UserStatsRow>(
    `SELECT sex, age, weight_kg, height_cm FROM users WHERE id = $1`,
    [userId],
  );
  const u = userRows[0];
  if (!u || !u.sex || u.age == null || u.weight_kg == null || u.height_cm == null) {
    return null;
  }

  // 3. Sesiones/semana = días no-descanso del plan de entrenamiento activo.
  //    Sin plan de entreno → 0 (sedentario).
  const { rows: sessRows } = await query<{ n: string }>(
    `SELECT COUNT(DISTINCT day_of_week)::text AS n FROM training_plans
     WHERE user_id = $1 AND is_active = true AND session_type <> 'descanso'`,
    [userId],
  );
  const sessionsPerWeek = Number.parseInt(sessRows[0]?.n ?? "0", 10) || 0;

  // 4. goal_kind del goal activo (lose_weight / gain_muscle / ... / null).
  const { rows: goalRows } = await query<{ goal_kind: string | null }>(
    `SELECT goal_kind FROM goals
     WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId],
  );
  const goalKind = (goalRows[0]?.goal_kind ?? null) as AmateurGoalKind;

  const target = computeNutritionTarget({
    sex: u.sex,
    age: u.age,
    weightKg: u.weight_kg,
    heightCm: u.height_cm,
    sessionsPerWeek,
    goalKind,
  });

  // 5. Reemplazar el plan auto previo (deactivate + insert) en una tx para no
  //    violar idx_nutrition_one_active.
  await tx(async (client) => {
    await client.query(
      `UPDATE nutrition_plans SET is_active = false
       WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    await client.query(
      `INSERT INTO nutrition_plans
         (user_id, target_kcal, target_protein_g, target_carbs_g, target_fat_g,
          source, is_active)
       VALUES ($1, $2, $3, $4, $5, 'forja_auto', true)`,
      [userId, target.kcal, target.protein_g, target.carbs_g, target.fat_g],
    );
  });

  logger.info("auto nutrition target recomputed", {
    userId,
    kcal: target.kcal,
    strategy: target.basis.strategy,
    sessionsPerWeek,
    goalKind,
  });
  return target;
}

/**
 * ¿El usuario depende del target auto-estimado? True si NO tiene un plan
 * manual activo (es decir: plan forja_auto o sin plan = perfil amateur). Lo usa
 * el meal handler para decidir si registra estimaciones sin interrogar.
 */
export async function isAutoTargetUser(userId: string): Promise<boolean> {
  const { rows } = await query<{ source: string }>(
    `SELECT source FROM nutrition_plans
     WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId],
  );
  return rows[0]?.source !== "manual";
}

/**
 * Versión que nunca tira: para usar como hook fire-and-forget en repos que no
 * deben fallar si el recálculo falla (el dato principal ya se guardó).
 */
export async function recomputeAutoTargetSafe(userId: string): Promise<void> {
  try {
    await recomputeAutoTarget(userId);
  } catch (err) {
    logger.error("recomputeAutoTarget failed (non-fatal)", { userId, err });
  }
}
