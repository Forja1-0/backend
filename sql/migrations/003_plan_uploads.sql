-- ============================================================
-- Migration 003: persistir PDF crudo + parseo rico de planes
-- ============================================================
-- Razon: el onboarding aceptaba archivo en el UI pero descartaba
-- el binario y solo guardaba macros target / dias sueltos. Los
-- planes reales (nutricionista + coach) tienen tablas, justificaciones
-- cientificas, protocolos de rehab, listas de compras, distribucion
-- por comida con horarios, alertas... todo eso lo necesita el bot
-- para responder en WhatsApp con contexto real.
--
-- Estrategia:
--  * nutrition_plans es 1:1 con user -> extender con bytea + parsed_data jsonb.
--  * training_plans es row-per-day -> nueva tabla training_plan_files
--    para el PDF + JSONB rico; los rows de training_plans se siguen
--    poblando (queries del bot intactas).
-- ============================================================

ALTER TABLE nutrition_plans
  ADD COLUMN IF NOT EXISTS raw_file_bytes  BYTEA,
  ADD COLUMN IF NOT EXISTS raw_file_mime   TEXT,
  ADD COLUMN IF NOT EXISTS raw_file_name   TEXT,
  ADD COLUMN IF NOT EXISTS raw_file_size   INT,
  ADD COLUMN IF NOT EXISTS parsed_data     JSONB,
  ADD COLUMN IF NOT EXISTS parsed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parser_version  TEXT;

COMMENT ON COLUMN nutrition_plans.raw_file_bytes IS
  'PDF original tal como lo subio el atleta. Para reprocesar si el parser mejora.';
COMMENT ON COLUMN nutrition_plans.parsed_data IS
  'JSON rico extraido del PDF: athlete_summary, diagnosis, protein_quality, '
  'meal_distribution (con horarios y macros por comida), variants, timing_rules, '
  'meal_prep, shopping_list, hydration, success_indicators, notes[].';

-- ============================================================
-- training_plan_files: 1 PDF por user, complementa training_plans
-- ============================================================
CREATE TABLE IF NOT EXISTS training_plan_files (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    coach_name          TEXT,
    raw_file_bytes      BYTEA,
    raw_file_mime       TEXT,
    raw_file_name       TEXT,
    raw_file_size       INT,
    parsed_data         JSONB NOT NULL,
    -- {athlete_summary, period, weekly_structure, rehab_rules[], days[],
    --  rehab_protocols[], swim_plan, progression_model, alerts[], notes[]}
    parser_version      TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    parsed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un solo plan activo por usuario (replace-on-upload).
CREATE UNIQUE INDEX IF NOT EXISTS idx_training_plan_files_one_active
  ON training_plan_files (user_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_training_plan_files_parsed_gin
  ON training_plan_files USING GIN (parsed_data);

COMMENT ON TABLE training_plan_files IS
  'Plan de entrenamiento original (PDF) + parseo rico. training_plans sigue '
  'siendo la tabla operacional row-per-day para queries del bot; esta tabla '
  'es la fuente de verdad de origen + contexto cientifico/rehab.';
