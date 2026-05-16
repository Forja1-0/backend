-- ============================================================
-- Migration 005: food_portions — porciones naturales por alimento
-- ============================================================
-- Razon: el parser de comidas leia "2 milanesas" como "2 gramos de
-- milanesa" porque no tenia forma de saber cuanto pesa UNA milanesa.
-- food_portions vincula cada food_items (SARA2) con sus porciones
-- caseras reales (unidad, feta, plato playo cocido, cucharada, ...),
-- extraidas de EQUIVALENCIAS_2026 y el Atlas Fotografico UBA.
--
-- Asi:
--   "2 milanesas"        -> 2 x porcion default (150g) = 300g
--   "un plato de fideos" -> porcion "plato playo cocido" = 200g cocido
--   "feta de jamon"      -> porcion "feta" = 35g
--
-- food_id es NULLABLE: el seed (scripts/seed-food-portions.mjs) resuelve
-- el food_id contra los nombres reales de food_items con el MISMO
-- matching del parser. Si un alimento no matchea, la fila igual queda
-- (food_id NULL) para diagnostico; el parser cae a standard_portion_g.
--
-- Idempotente: el seed borra y reinserta por source, no esta migracion.
-- ============================================================

CREATE TABLE IF NOT EXISTS food_portions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    food_id         UUID REFERENCES food_items(id) ON DELETE CASCADE,
    -- Termino con el que el seed resolvio (o intento resolver) el food_id.
    -- Se guarda para re-seed / diagnostico de matches incorrectos.
    food_query      TEXT NOT NULL,
    portion_name    TEXT NOT NULL,
    -- "unidad", "feta", "plato playo cocido", "cucharada sopera", ...
    portion_grams   NUMERIC NOT NULL CHECK (portion_grams > 0),
    portion_state   TEXT CHECK (portion_state IN ('crudo', 'cocido')),
    -- NULL = no aplica estado (huevo, queso, pan, fruta, ...)
    is_default      BOOLEAN NOT NULL DEFAULT false,
    -- true = porcion que se asume cuando dicen solo el nombre / "N <alimento>"
    source          TEXT NOT NULL,
    -- "EQUIVALENCIAS_2026", "ATLAS_UBA", "estimado"
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup principal del parser: porciones de un alimento (filtrando estado).
CREATE INDEX IF NOT EXISTS idx_food_portions_food
  ON food_portions (food_id) WHERE food_id IS NOT NULL;

-- Una sola porcion default por (alimento, estado). Evita ambiguedad al
-- defaultear "2 milanesas". WHERE parcial: solo aplica a is_default=true.
-- COALESCE para tratar state NULL como un valor distinto y unico.
CREATE UNIQUE INDEX IF NOT EXISTS idx_food_portions_one_default
  ON food_portions (food_id, COALESCE(portion_state, ''))
  WHERE is_default = true AND food_id IS NOT NULL;

COMMENT ON TABLE food_portions IS
  'Porciones caseras por alimento (unidad, feta, plato, cucharada). '
  'Vincula food_items SARA2 con pesos reales para que el parser convierta '
  '"2 milanesas" -> 300g. Seedeada por scripts/seed-food-portions.mjs.';
