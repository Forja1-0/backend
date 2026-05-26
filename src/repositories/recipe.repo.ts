import { query } from "../config/db.js";

export interface RecipeComponent {
  food_id: string | null;
  food_query: string;
  grams_per_portion: number;
  state: "crudo" | "cocido" | null;
  display_order: number;
}

export interface Recipe {
  id: string;
  slug: string;
  display_name: string;
  aliases: string[];
  default_portion_g: number;
  components: RecipeComponent[];
}

/**
 * Trae una receta por slug con sus componentes ordenados.
 * Devuelve null si el slug no existe.
 */
export async function findRecipeBySlug(slug: string): Promise<Recipe | null> {
  const { rows: rs } = await query<{
    id: string;
    slug: string;
    display_name: string;
    aliases: string[];
    default_portion_g: number;
  }>(
    `SELECT id, slug, display_name, aliases, default_portion_g
     FROM recipes WHERE slug = $1`,
    [slug],
  );
  const r = rs[0];
  if (!r) return null;

  const { rows: comps } = await query<RecipeComponent>(
    `SELECT food_id, food_query, grams_per_portion::float8 AS grams_per_portion,
            state, display_order
     FROM recipe_components
     WHERE recipe_id = $1
     ORDER BY display_order ASC`,
    [r.id],
  );
  return { ...r, components: comps };
}

/**
 * Lookup por alias para fallback regex (cuando la AI esta caida y queremos
 * pescar al menos "tuco"/"napolitana" del texto sin la AI).
 */
export async function findRecipeByAlias(alias: string): Promise<Recipe | null> {
  const norm = alias.trim().toLowerCase();
  if (norm.length < 3) return null;
  const { rows } = await query<{ slug: string }>(
    `SELECT slug FROM recipes WHERE $1 = ANY(aliases) LIMIT 1`,
    [norm],
  );
  return rows[0] ? findRecipeBySlug(rows[0].slug) : null;
}
