-- ============================================================
-- Migration 005: food_portions — porciones naturales por alimento
-- ============================================================
-- Razon: el parser leia "2 milanesas" como "2 gramos de milanesa"
-- porque no sabia cuanto pesa UNA milanesa. food_portions vincula
-- cada food_items (SARA2) con sus porciones caseras reales.
--
-- IMPORTANTE: esta migration es idempotente Y tolera que la tabla ya
-- exista con el schema del prompt original (sin food_query). Por eso:
--   * CREATE TABLE IF NOT EXISTS  -> instalaciones nuevas
--   * ALTER ... ADD COLUMN IF NOT EXISTS food_query -> tabla preexistente
-- food_query lo necesita el seed para registrar/diagnosticar el match.
-- Queda NULLABLE (filas viejas no lo tienen; el seed reescribe todo).
--
-- El seed (scripts/seed-food-portions.mjs) hace DELETE+INSERT por source,
-- no esta migration.
-- ============================================================

CREATE TABLE IF NOT EXISTS food_portions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    food_id         UUID REFERENCES food_items(id) ON DELETE CASCADE,
    food_query      TEXT,
    portion_name    TEXT NOT NULL,
    portion_grams   NUMERIC NOT NULL CHECK (portion_grams > 0),
    portion_state   TEXT CHECK (portion_state IN ('crudo', 'cocido')),
    is_default      BOOLEAN NOT NULL DEFAULT false,
    source          TEXT NOT NULL,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tabla preexistente (prompt original): le falta food_query. Agregarla.
ALTER TABLE food_portions
  ADD COLUMN IF NOT EXISTS food_query TEXT;

CREATE INDEX IF NOT EXISTS idx_food_portions_food
  ON food_portions (food_id) WHERE food_id IS NOT NULL;

-- Una sola porcion default por (alimento, estado). COALESCE para tratar
-- state NULL como valor unico. WHERE parcial: ignora food_id NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_food_portions_one_default
  ON food_portions (food_id, COALESCE(portion_state, ''))
  WHERE is_default = true AND food_id IS NOT NULL;

COMMENT ON TABLE food_portions IS
  'Porciones caseras por alimento (unidad, feta, plato, cucharada). '
  'Vincula food_items SARA2 con pesos reales para "2 milanesas" -> 300g. '
  'Seedeada por scripts/seed-food-portions.mjs.';
