-- ============================================================
-- Migration 004: nutrition_plan_files (espejo de training_plan_files)
-- ============================================================
-- Por que: en migration 003 metimos las columnas de PDF + parsed_data
-- adentro de nutrition_plans. Eso rompio dos cosas:
--  1. Inconsistencia: training armo tabla separada (training_plan_files)
--     pero nutricion no, porque pense "nutrition_plans es 1:1, no hace falta".
--  2. saveStep4 hace DEACTIVATE + INSERT nuevo cada vez que el frontend
--     manda PUT /step/4. Como la fila nueva no tenia los bytes del PDF
--     ni el parsed_data, el INSERT pisaba la fila buena del upload con
--     una vacia. Por eso despues del Continue la DB quedaba sin archivo.
--
-- Fix: nutrition_plan_files toma el rol de "PDF + parseo rico", igual que
-- training_plan_files. nutrition_plans vuelve a ser solo macros (saveStep4
-- ya no toca la otra tabla). Las columnas de archivo de nutrition_plans
-- se borran (siempre estuvieron NULL en este punto, no se pierde nada).
-- ============================================================

CREATE TABLE IF NOT EXISTS nutrition_plan_files (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nutritionist_name   TEXT,
    raw_file_bytes      BYTEA,
    raw_file_mime       TEXT,
    raw_file_name       TEXT,
    raw_file_size       INT,
    parsed_data         JSONB NOT NULL,
    -- {athlete_summary, targets, meal_distribution[], daily_variants[],
    --  timing_rules[], meal_prep[], shopping_list[], hydration,
    --  success_indicators[], general_notes[]}
    parser_version      TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    parsed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_nutrition_plan_files_one_active
  ON nutrition_plan_files (user_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_nutrition_plan_files_parsed_gin
  ON nutrition_plan_files USING GIN (parsed_data);

COMMENT ON TABLE nutrition_plan_files IS
  'Plan nutricional original (PDF) + parseo rico. Espejo de training_plan_files. '
  'nutrition_plans queda solo con macros + meal_distribution legacy para queries del bot.';

-- ============================================================
-- Limpieza de columnas de archivo en nutrition_plans
-- ============================================================
-- Las dropeamos solo si todas estan NULL (caso esperado tras la 003).
-- Si llegara a haber datos por algun motivo, el bloque NO destruye nada
-- y deja un NOTICE para revisar manualmente.
DO $migrate$
DECLARE has_data BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM nutrition_plans
    WHERE raw_file_bytes IS NOT NULL
       OR parsed_data IS NOT NULL
       OR parser_version IS NOT NULL
  ) INTO has_data;

  IF has_data THEN
    RAISE NOTICE 'nutrition_plans tiene datos en columnas de archivo; revisar manualmente antes de dropear.';
  ELSE
    ALTER TABLE nutrition_plans
      DROP COLUMN IF EXISTS raw_file_bytes,
      DROP COLUMN IF EXISTS raw_file_mime,
      DROP COLUMN IF EXISTS raw_file_name,
      DROP COLUMN IF EXISTS raw_file_size,
      DROP COLUMN IF EXISTS parsed_data,
      DROP COLUMN IF EXISTS parsed_at,
      DROP COLUMN IF EXISTS parser_version;
  END IF;
END $migrate$;
