-- ============================================================
-- Migration 011: weight_logs — serie temporal de peso corporal
-- ============================================================
-- Hasta ahora el peso era un solo valor en users.weight_kg (capturado en
-- onboarding). Para "bajar 20kg" necesitamos la TENDENCIA, no un punto.
--
-- weight_logs es la fuente de la señal de progreso del amateur (fase 3/4) y,
-- de paso, cada peso nuevo dispara recomputeAutoTarget (el target estimado
-- baja a medida que baja el peso). users.weight_kg se mantiene como "peso
-- actual" (lo actualiza weight.repo al loguear) para el cálculo del BMR.
--
-- Idempotente: IF NOT EXISTS + seed con NOT EXISTS.
-- ============================================================

CREATE TABLE IF NOT EXISTS weight_logs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    weight_kg   REAL NOT NULL CHECK (weight_kg > 20 AND weight_kg < 400),
    source      TEXT NOT NULL DEFAULT 'whatsapp',
    -- whatsapp | onboarding_seed | profile
    logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_weight_logs_user_time
  ON weight_logs (user_id, logged_at DESC);

COMMENT ON TABLE weight_logs IS
  'Serie temporal de peso corporal. Cada fila nueva actualiza users.weight_kg '
  '(peso actual) y dispara recomputeAutoTarget. source: whatsapp | '
  'onboarding_seed | profile.';

-- Seed: un punto inicial por usuario existente, desde users.weight_kg, fechado
-- en su created_at. Solo si el user todavía no tiene weight_logs (idempotente).
INSERT INTO weight_logs (user_id, weight_kg, source, logged_at)
SELECT u.id, u.weight_kg, 'onboarding_seed', u.created_at
FROM users u
WHERE u.weight_kg IS NOT NULL
  AND u.weight_kg > 20 AND u.weight_kg < 400
  AND NOT EXISTS (SELECT 1 FROM weight_logs w WHERE w.user_id = u.id);
