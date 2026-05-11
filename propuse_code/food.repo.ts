import { query } from '../config/db';

export interface FoodItem {
  id: string;
  name: string;
  category: string;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  standard_portion_g: number;
  source: string;
}

/**
 * Full-text search with Spanish config + fuzzy fallback via pg_trgm.
 * Returns up to `limit` results, ordered by relevance.
 *
 * Search strategy:
 * 1. Exact prefix match (fastest, handles "pech" → "pechuga")
 * 2. FTS with ts_rank (handles "pechuga pollo")
 * 3. Trigram similarity fallback (handles typos: "pechga" → "pechuga")
 */
export async function searchFood(q: string, limit = 10): Promise<FoodItem[]> {
  const trimmed = q.trim().toLowerCase();
  if (trimmed.length < 2) return [];

  const { rows } = await query(
    `WITH
     -- 1. Prefix match
     prefix AS (
       SELECT *, 1.0 AS rank_score, 1 AS source_priority
       FROM food_items
       WHERE lower(name) LIKE $1 || '%'
       LIMIT $2
     ),
     -- 2. Full-text search
     fts AS (
       SELECT fi.*, ts_rank(fi.search_vector, plainto_tsquery('spanish', $1)) AS rank_score,
              2 AS source_priority
       FROM food_items fi
       WHERE fi.search_vector @@ plainto_tsquery('spanish', $1)
         AND fi.id NOT IN (SELECT id FROM prefix)
       ORDER BY rank_score DESC
       LIMIT $2
     ),
     -- 3. Trigram fuzzy fallback
     trgm AS (
       SELECT fi.*, similarity(lower(fi.name), $1) AS rank_score,
              3 AS source_priority
       FROM food_items fi
       WHERE similarity(lower(fi.name), $1) > 0.25
         AND fi.id NOT IN (SELECT id FROM prefix)
         AND fi.id NOT IN (SELECT id FROM fts)
       ORDER BY rank_score DESC
       LIMIT $2
     )
     SELECT id, name, category, kcal_per_100g, protein_per_100g,
            carbs_per_100g, fat_per_100g, standard_portion_g, source
     FROM (
       SELECT * FROM prefix
       UNION ALL SELECT * FROM fts
       UNION ALL SELECT * FROM trgm
     ) combined
     ORDER BY source_priority, rank_score DESC
     LIMIT $2`,
    [trimmed, limit]
  );

  return rows;
}

/**
 * Get a single food item by ID (for precise lookups after user selects from autocomplete)
 */
export async function getFoodById(id: string): Promise<FoodItem | null> {
  const { rows } = await query(
    `SELECT id, name, category, kcal_per_100g, protein_per_100g,
            carbs_per_100g, fat_per_100g, standard_portion_g, source
     FROM food_items WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}
