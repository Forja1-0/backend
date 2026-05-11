import { query } from "../config/db.js";

export interface FoodItem {
  id: string;
  name: string;
  category: string;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number;
  standard_portion_g: number | null;
  source: string;
}

/**
 * Cascada de busqueda en food_items (913 alimentos SARA 2):
 *   1. Prefix match (lower(name) LIKE 'pech%') — el mas barato
 *   2. Full-text search en espanol (plainto_tsquery) — frases
 *   3. Trigram fuzzy (similarity > 0.25) — typos
 *
 * Cada candidato lleva su rank y un source_priority para que
 * prefix > fts > trgm en el orden final.
 *
 * Indices del schema (idx_food_items_fts gin, idx_food_items_trgm gin)
 * cubren ambos casos sin necesidad de columna stored.
 */
export async function searchFood(q: string, limit = 10): Promise<FoodItem[]> {
  const trimmed = q.trim().toLowerCase();
  if (trimmed.length < 2) return [];

  const { rows } = await query<FoodItem>(
    `WITH
       prefix AS (
         SELECT id, 1.0::real AS rank_score, 1 AS source_priority
         FROM food_items
         WHERE lower(name) LIKE $1 || '%'
         LIMIT $2
       ),
       fts AS (
         SELECT fi.id,
                ts_rank(to_tsvector('spanish', fi.name),
                        plainto_tsquery('spanish', $1)) AS rank_score,
                2 AS source_priority
         FROM food_items fi
         WHERE to_tsvector('spanish', fi.name) @@ plainto_tsquery('spanish', $1)
           AND fi.id NOT IN (SELECT id FROM prefix)
         ORDER BY rank_score DESC
         LIMIT $2
       ),
       trgm AS (
         SELECT fi.id,
                similarity(lower(fi.name), $1)::real AS rank_score,
                3 AS source_priority
         FROM food_items fi
         WHERE similarity(lower(fi.name), $1) > 0.25
           AND fi.id NOT IN (SELECT id FROM prefix)
           AND fi.id NOT IN (SELECT id FROM fts)
         ORDER BY rank_score DESC
         LIMIT $2
       ),
       combined AS (
         SELECT id, rank_score, source_priority FROM prefix
         UNION ALL SELECT id, rank_score, source_priority FROM fts
         UNION ALL SELECT id, rank_score, source_priority FROM trgm
       )
     SELECT fi.id, fi.name, fi.category, fi.kcal_per_100g,
            fi.protein_per_100g, fi.carbs_per_100g, fi.fat_per_100g,
            fi.fiber_per_100g, fi.standard_portion_g, fi.source
     FROM combined c
     JOIN food_items fi ON fi.id = c.id
     ORDER BY c.source_priority, c.rank_score DESC
     LIMIT $2`,
    [trimmed, limit],
  );

  return rows;
}

export async function getFoodById(id: string): Promise<FoodItem | null> {
  const { rows } = await query<FoodItem>(
    `SELECT id, name, category, kcal_per_100g, protein_per_100g,
            carbs_per_100g, fat_per_100g, fiber_per_100g,
            standard_portion_g, source
     FROM food_items WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
