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

export interface FoodMatch extends FoodItem {
  /** Score normalizado 0..1. prefix > fts > trgm.  */
  match_score: number;
  match_source: "prefix" | "fts" | "trgm";
}

/**
 * Cascada en food_items (913 alimentos SARA 2):
 *   1. Prefix match (lower(name) LIKE 'pech%') — score 1.0
 *   2. FTS espanol — score = ts_rank normalizado a [0, 1]
 *   3. Trigram similarity — score = similarity directa
 *
 * El consumidor decide el threshold segun caso de uso (handler de comida
 * pide ≥ 0.5 para confiar; busqueda de autocomplete acepta todo).
 */
export async function searchFood(q: string, limit = 10): Promise<FoodMatch[]> {
  const trimmed = q.trim().toLowerCase();
  if (trimmed.length < 2) return [];

  const { rows } = await query<FoodMatch>(
    `WITH
       prefix AS (
         SELECT id, 1.0::real AS match_score, 'prefix'::text AS match_source
         FROM food_items
         WHERE lower(name) LIKE $1 || '%'
         LIMIT $2
       ),
       fts AS (
         SELECT fi.id,
                LEAST(ts_rank(to_tsvector('spanish', fi.name),
                              plainto_tsquery('spanish', $1)) * 4, 1.0)::real AS match_score,
                'fts'::text AS match_source
         FROM food_items fi
         WHERE to_tsvector('spanish', fi.name) @@ plainto_tsquery('spanish', $1)
           AND fi.id NOT IN (SELECT id FROM prefix)
         ORDER BY match_score DESC
         LIMIT $2
       ),
       trgm AS (
         SELECT fi.id,
                similarity(lower(fi.name), $1)::real AS match_score,
                'trgm'::text AS match_source
         FROM food_items fi
         WHERE similarity(lower(fi.name), $1) > 0.25
           AND fi.id NOT IN (SELECT id FROM prefix)
           AND fi.id NOT IN (SELECT id FROM fts)
         ORDER BY match_score DESC
         LIMIT $2
       ),
       combined AS (
         SELECT id, match_score, match_source, 1 AS p FROM prefix
         UNION ALL SELECT id, match_score, match_source, 2 FROM fts
         UNION ALL SELECT id, match_score, match_source, 3 FROM trgm
       )
     SELECT fi.id, fi.name, fi.category, fi.kcal_per_100g,
            fi.protein_per_100g, fi.carbs_per_100g, fi.fat_per_100g,
            fi.fiber_per_100g, fi.standard_portion_g, fi.source,
            c.match_score, c.match_source
     FROM combined c
     JOIN food_items fi ON fi.id = c.id
     ORDER BY c.p, c.match_score DESC
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
