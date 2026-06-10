-- ============================================================
-- Migration 010: target nutricional auto-calculado (modo amateur)
-- ============================================================
-- El amateur no sube plan de nutri: Forja le estima un target diario
-- (ver services/nutrition-target.ts) y lo persiste como una fila normal
-- de `nutrition_plans` para reusar TODO el coach loop existente
-- (v_daily_remaining, getDailyRemaining, assessDay, reco, adherencia).
--
-- Esta migración solo agrega la columna `source` para distinguir:
--   manual     = plan del nutri / macros editados a mano por el user.
--   forja_auto = target estimado por Forja.
-- recomputeAutoTarget SOLO pisa filas forja_auto — nunca toca un plan manual.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + DO block para el CHECK.
-- ============================================================

ALTER TABLE nutrition_plans
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

-- CHECK por nombre (Postgres no tiene ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'nutrition_plans'::regclass
      AND conname = 'nutrition_plans_source_check'
  ) THEN
    ALTER TABLE nutrition_plans
      ADD CONSTRAINT nutrition_plans_source_check
      CHECK (source IN ('manual', 'forja_auto'));
  END IF;
END $$;

COMMENT ON COLUMN nutrition_plans.source IS
  'manual = plan del nutri / editado a mano. forja_auto = target estimado '
  'por Forja (amateur sin plan). recomputeAutoTarget solo pisa forja_auto.';

-- v_daily_remaining NO necesita cambios: joinea nutrition_plans WHERE
-- is_active = true sin mirar source, así que una fila forja_auto la enciende
-- exactamente igual que una manual.
