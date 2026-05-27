-- ============================================================
-- Migration 009: Soporte para modo amateur (FORJA_MODE=amateur)
-- ============================================================
-- Dos cambios:
--   1. Extender `goals` para aceptar metas personales libres
--      (perder kg, ganar masa, mejorar tiempo, etc.), no solo
--      eventos competitivos del ICP atleta.
--   2. Nueva tabla `user_reminders`: el usuario configura sus
--      propios crons de WhatsApp con cron_expr arbitraria.
--
-- Idempotente: DO blocks + IF NOT EXISTS.
-- ============================================================

-- ── 1. goals: agregar tipo "personal_goal" + columnas dinamicas ──

-- Drop del CHECK viejo (solo si existe). Postgres no tiene IF EXISTS
-- para constraint names viejos, por eso lo buscamos por nombre real.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'goals'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%event_type%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE goals DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

-- Nuevo CHECK que incluye "personal_goal".
ALTER TABLE goals
  ADD CONSTRAINT goals_event_type_check
  CHECK (event_type IN ('competition', 'recomp', 'performance', 'personal_goal'));

-- event_date pasa a nullable: una meta libre puede no tener deadline.
ALTER TABLE goals ALTER COLUMN event_date DROP NOT NULL;

-- Columnas dinamicas para la meta libre. NULL para metas elite clasicas.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS goal_kind TEXT;
-- Valores libres: lose_weight, gain_muscle, improve_time, reach_distance,
-- custom. Se valida en zod, no en SQL, para flexibilidad.

ALTER TABLE goals ADD COLUMN IF NOT EXISTS goal_metric_value NUMERIC;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS goal_metric_unit TEXT;
-- unit ∈ kg | km | min | reps | percent | custom

ALTER TABLE goals ADD COLUMN IF NOT EXISTS goal_metric_label TEXT;
-- Texto libre cuando goal_kind = "custom" (ej: "correr 10k en 50min").

COMMENT ON COLUMN goals.goal_kind IS
  'Kind de meta amateur: lose_weight | gain_muscle | improve_time | '
  'reach_distance | custom. NULL para metas elite (event_type != personal_goal).';

-- ── 2. user_reminders: crons configurables por el usuario ──
CREATE TABLE IF NOT EXISTS user_reminders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label           TEXT NOT NULL,
    -- Titulo corto para mostrar en la UI ("Tomar agua", "Entrenar a la tarde")
    message         TEXT NOT NULL,
    -- Mensaje exacto que se manda por WhatsApp.
    cron_expr       TEXT NOT NULL,
    -- Cron de 5 campos (min hora dom mes dow). Validamos en backend antes
    -- de insertar — no via CHECK porque la expresion es compleja.
    active          BOOLEAN NOT NULL DEFAULT true,
    last_fired_at   TIMESTAMPTZ,
    -- Para guardia anti-doble-disparo (si el cron del bot corre cada
    -- minuto y se overlappea, no spammeamos al usuario).
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_reminders_user_active
  ON user_reminders (user_id, active);

CREATE INDEX IF NOT EXISTS idx_user_reminders_active_lookup
  ON user_reminders (active)
  WHERE active = true;

COMMENT ON TABLE user_reminders IS
  'Recordatorios configurables por el usuario. El cron del bot corre cada '
  'minuto, busca recordatorios cuyo cron_expr matchea NOW(), y manda WhatsApp.';
