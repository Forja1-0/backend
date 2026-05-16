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
