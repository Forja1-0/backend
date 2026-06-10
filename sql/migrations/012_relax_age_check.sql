-- ============================================================
-- Migration 012: relajar el CHECK de edad (16..70 → 16..100)
-- ============================================================
-- El público amateur casual incluye gente >70. El schema original capaba la
-- edad en 70 con un CHECK de columna (users_age_check), así que un usuario de
-- 72 reventaba el onboarding con un 500 (violación 23514) tras pasar Zod.
-- Subimos el techo a 100. Idempotente: dropear el constraint si existe y
-- recrearlo con el rango nuevo.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_age_check;
ALTER TABLE users ADD CONSTRAINT users_age_check CHECK (age BETWEEN 16 AND 100);
