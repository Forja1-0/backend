-- ============================================================
-- Migration 001: permitir user "shell" durante onboarding
-- ============================================================
-- Razon: el flujo de onboarding crea un user vacio en POST /start
-- y va llenando datos a lo largo de los 7 pasos. Los NOT NULL
-- originales impiden ese patron.
--
-- UNIQUE en email se mantiene; en Postgres los NULL no chocan
-- contra UNIQUE, asi que multiples shells sin email funcionan.
-- ============================================================

ALTER TABLE users
  ALTER COLUMN name DROP NOT NULL,
  ALTER COLUMN age DROP NOT NULL,
  ALTER COLUMN sex DROP NOT NULL,
  ALTER COLUMN weight_kg DROP NOT NULL,
  ALTER COLUMN height_cm DROP NOT NULL,
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN phone_wa DROP NOT NULL;
