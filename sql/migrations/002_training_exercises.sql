-- ============================================================
-- Migration 002: agregar lista de ejercicios al plan de entrenamiento
-- ============================================================
-- Razon: el clasificador del bot necesita un diccionario por user
-- para detectar "hice pecfly" / "termine sentadillas" sin AI.
-- El diccionario se deriva de los exercises[] de cada sesion.
--
-- Estructura esperada:
-- [
--   { "name": "Sentadilla", "aliases": ["sentadillas", "back squat"],
--     "sets": 4, "reps": "8-10", "load_kg": null, "notes": null },
--   ...
-- ]
--
-- Nullable: planes viejos siguen funcionando con matching session-level.
-- ============================================================

ALTER TABLE training_plans
  ADD COLUMN IF NOT EXISTS exercises JSONB;

-- Indice GIN para queries futuras tipo "qué dias incluyen sentadilla"
CREATE INDEX IF NOT EXISTS idx_training_plans_exercises_gin
  ON training_plans USING GIN (exercises);

COMMENT ON COLUMN training_plans.exercises IS
  'Lista JSONB de ejercicios de la sesion: [{name, aliases[], sets?, reps?, load_kg?, notes?}]. Null = plan session-level legacy.';
