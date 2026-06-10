import { query } from "../config/db.js";

export interface SaveMealLogParams {
  user_id: string;
  input_mode: "quick" | "descriptive" | "precise";
  raw_input: string;
  parsed_items: any[];
  total_kcal: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
  is_estimate: boolean;
  confirmed: boolean;
}

export interface LastMealRow {
  id: string;
  raw_input: string;
  total_kcal: number;
}

// Último registro de comida de HOY (misma definición de "hoy" que usa
// refreshDailySummary: logged_at::date = CURRENT_DATE). Sirve para el flujo
// "corregir": antes prometíamos "piso la anterior" pero nunca borrábamos nada
// → la corrección se guardaba como comida nueva y contaba doble.
export async function getLastMealToday(userId: string): Promise<LastMealRow | null> {
  const { rows } = await query<LastMealRow>(
    `SELECT id, raw_input, total_kcal
     FROM meal_logs
     WHERE user_id = $1 AND logged_at::date = CURRENT_DATE
     ORDER BY logged_at DESC
     LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function deleteMealLog(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM meal_logs WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function saveMealLog(params: SaveMealLogParams) {
  const { rows } = await query(
    `INSERT INTO meal_logs (
      user_id, input_mode, raw_input, parsed_items,
      total_kcal, total_protein_g, total_carbs_g, total_fat_g,
      is_estimate, confirmed
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      params.user_id,
      params.input_mode,
      params.raw_input,
      JSON.stringify(params.parsed_items),
      Math.round(params.total_kcal),
      params.total_protein_g,
      params.total_carbs_g,
      params.total_fat_g,
      params.is_estimate,
      params.confirmed,
    ],
  );
  return rows[0];
}
