-- ============================================================
-- Migration 008: recipes + recipe_components
-- ============================================================
-- Razon: la AI separa "fideos con tuco" en [fideos, tuco] y pierde
-- "tuco" porque no es un alimento base de SARA2 sino una RECETA
-- compuesta. Esta tabla guarda la composicion canonica de los platos
-- argentinos tipicos para que el hidratador del meal-parser los
-- expanda en sus componentes y consulte SARA2 normalmente.
--
-- Disenado para AI-as-parser-only: la lista de slugs es estable y
-- el LLM la recibe como enum en su responseSchema (sin reasoning).
--
-- Idempotente. El seed (scripts/seed-recipes.mjs) hace DELETE+INSERT
-- por source, no esta migration.
-- ============================================================

CREATE TABLE IF NOT EXISTS recipes (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug               TEXT NOT NULL UNIQUE,
    display_name       TEXT NOT NULL,
    aliases            TEXT[] NOT NULL DEFAULT '{}',
    default_portion_g  INTEGER NOT NULL CHECK (default_portion_g > 0),
    source_url         TEXT,
    source             TEXT NOT NULL DEFAULT 'forja_v1',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recipes_aliases
    ON recipes USING GIN (aliases);

CREATE TABLE IF NOT EXISTS recipe_components (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id           UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    food_id             UUID REFERENCES food_items(id) ON DELETE SET NULL,
    food_query          TEXT NOT NULL,
    grams_per_portion   NUMERIC(8,2) NOT NULL CHECK (grams_per_portion > 0),
    state               TEXT CHECK (state IN ('crudo', 'cocido')),
    display_order       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_recipe_components_recipe
    ON recipe_components (recipe_id);

COMMENT ON TABLE recipes IS
  'Recetas compuestas argentinas tipicas (tuco, milanesa napolitana, locro...). '
  'La AI las identifica por slug; el hidratador expande recipe_components '
  'y consulta SARA2 para macros. Seedeada por scripts/seed-recipes.mjs.';

COMMENT ON TABLE recipe_components IS
  'Composicion fija por porcion estandar. grams_per_portion es la cantidad '
  'del ingrediente para UNA porcion de la receta. El parser escala por qty del user.';
