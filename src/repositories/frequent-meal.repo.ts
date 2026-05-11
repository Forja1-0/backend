import { query } from "../config/db.js";

export interface FrequentMeal {
  id: string;
  alias: string;
  ingredients: unknown[];
  total_kcal: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
}

/**
 * Match exacto por alias (lowercase trim).
 * El query usa el indice idx_frequent_meals_alias (user_id, lower(alias)).
 */
export async function findByAlias(
  userId: string,
  alias: string,
): Promise<FrequentMeal | null> {
  const { rows } = await query<FrequentMeal>(
    `SELECT id, alias, ingredients, total_kcal,
            total_protein_g, total_carbs_g, total_fat_g
     FROM frequent_meals
     WHERE user_id = $1 AND lower(alias) = lower($2)
     LIMIT 1`,
    [userId, alias.trim()],
  );
  return rows[0] ?? null;
}

export async function bumpUseCount(id: string): Promise<void> {
  await query(`UPDATE frequent_meals SET use_count = use_count + 1 WHERE id = $1`, [id]);
}
