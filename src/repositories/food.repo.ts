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
            fi.fiber_per_100g, fi.source,
            c.match_score, c.match_source
     FROM combined c
     JOIN food_items fi ON fi.id = c.id
     ORDER BY c.p, c.match_score DESC
     LIMIT $2`,
    [trimmed, limit],
  );

  return rows;
}

export interface FoodCandidate extends FoodItem {
  /** score crudo del cascade (prefix/fts/trgm) — solo desempate. */
  base_score: number;
}

/**
 * Recall AMPLIO de candidatos para el resolver del parser. NO aplica
 * threshold: devuelve todo lo que prefix/fts/trgm pesque para que el
 * ranking por cobertura de tokens (food-match.ts) decida. Esto evita el
 * bug del FTS que topea en ~0.40 y rechazaba matches correctos.
 */
export async function searchFoodCandidates(q: string, limit = 25): Promise<FoodCandidate[]> {
  const trimmed = q.trim().toLowerCase();
  if (trimmed.length < 2) return [];

  const { rows } = await query<FoodCandidate>(
    `WITH
       prefix AS (
         SELECT id, 1.0::real AS base_score
         FROM food_items WHERE lower(name) LIKE $1 || '%' LIMIT $2
       ),
       fts AS (
         SELECT fi.id,
                LEAST(ts_rank(to_tsvector('spanish', fi.name),
                              plainto_tsquery('spanish', $1)) * 4, 1.0)::real AS base_score
         FROM food_items fi
         WHERE to_tsvector('spanish', fi.name) @@ plainto_tsquery('spanish', $1)
         ORDER BY base_score DESC LIMIT $2
       ),
       trgm AS (
         SELECT fi.id, similarity(lower(fi.name), $1)::real AS base_score
         FROM food_items fi
         WHERE similarity(lower(fi.name), $1) > 0.18
         ORDER BY base_score DESC LIMIT $2
       ),
       combined AS (
         SELECT DISTINCT ON (id) id, base_score FROM (
           SELECT * FROM prefix
           UNION ALL SELECT * FROM fts
           UNION ALL SELECT * FROM trgm
         ) u ORDER BY id, base_score DESC
       )
     SELECT fi.id, fi.name, fi.category, fi.kcal_per_100g,
            fi.protein_per_100g, fi.carbs_per_100g, fi.fat_per_100g,
            fi.fiber_per_100g, fi.source,
            c.base_score
     FROM combined c
     JOIN food_items fi ON fi.id = c.id
     ORDER BY c.base_score DESC
     LIMIT $2`,
    [trimmed, limit],
  );
  return rows;
}

export async function getFoodById(id: string): Promise<FoodItem | null> {
  const { rows } = await query<FoodItem>(
    `SELECT id, name, category, kcal_per_100g, protein_per_100g,
            carbs_per_100g, fat_per_100g, fiber_per_100g,
            source
     FROM food_items WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// ────────────────────────────────────────────────────────────
// FOOD_PORTIONS — porciones caseras por alimento (ver migration 005)
// ────────────────────────────────────────────────────────────

export interface FoodPortion {
  id: string;
  food_id: string;
  portion_name: string;
  portion_grams: number;
  /** 'crudo' | 'cocido' | null (no aplica). */
  portion_state: string | null;
  is_default: boolean;
  source: string;
  notes: string | null;
}

/** Todas las porciones de un alimento, default primero. */
export async function getPortionsForFood(foodId: string): Promise<FoodPortion[]> {
  const { rows } = await query<FoodPortion>(
    `SELECT id, food_id, portion_name, portion_grams::float8 AS portion_grams,
            portion_state, is_default, source, notes
     FROM food_portions
     WHERE food_id = $1
     ORDER BY is_default DESC, portion_grams ASC`,
    [foodId],
  );
  return rows;
}

/**
 * Porcion default de un alimento. Si se pasa `state` ('crudo'/'cocido'),
 * prioriza la default de ese estado; si no hay, cae a la default sin estado.
 */
export async function getDefaultPortion(
  foodId: string,
  state?: "crudo" | "cocido" | null,
): Promise<FoodPortion | null> {
  const { rows } = await query<FoodPortion>(
    `SELECT id, food_id, portion_name, portion_grams::float8 AS portion_grams,
            portion_state, is_default, source, notes
     FROM food_portions
     WHERE food_id = $1 AND is_default = true
       AND ($2::text IS NULL OR portion_state = $2 OR portion_state IS NULL)
     ORDER BY (portion_state = $2) DESC NULLS LAST
     LIMIT 1`,
    [foodId, state ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Busca una porcion por medida casera ("plato", "feta", "cucharada",
 * "pote", "rodaja"...). Match por substring sobre portion_name.
 * Si hay estado, lo respeta; si no, prioriza la default.
 */
export async function findPortionByMeasure(
  foodId: string,
  measure: string,
  state?: "crudo" | "cocido" | null,
): Promise<FoodPortion | null> {
  const { rows } = await query<FoodPortion>(
    `SELECT id, food_id, portion_name, portion_grams::float8 AS portion_grams,
            portion_state, is_default, source, notes
     FROM food_portions
     WHERE food_id = $1
       AND portion_name ILIKE '%' || $2 || '%'
       AND ($3::text IS NULL OR portion_state = $3 OR portion_state IS NULL)
     ORDER BY (portion_state = $3) DESC NULLS LAST, is_default DESC
     LIMIT 1`,
    [foodId, measure, state ?? null],
  );
  return rows[0] ?? null;
}
