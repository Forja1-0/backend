-- ============================================================
-- Migration 006: soporte para el perfil web (centro de control)
-- ============================================================
-- El perfil web (web_profile) necesita persistir cosas que la Fase
-- Toyota no modelaba todavia:
--
--  1. user_preferences: recordatorios, zona de silencio, umbral de
--     alerta nutricional, tono del bot y flags de privacidad. Una sola
--     fila JSONB por usuario (1:1) — el bot/cron lo lee para saber
--     cuando y como hablarle al atleta. Sin esto, Configuracion era
--     100% estado local que se perdia al recargar.
--
--  2. medical_documents: documentos clinicos (ECG, radiografia,
--     analisis, apto medico) como BYTEA en Postgres — mismo patron que
--     nutrition_plan_files / training_plan_files ("el archivo nunca
--     toca disco"). medical_history solo tenia *_file_url sueltas sin
--     forma de guardar el binario ni el historial. Las columnas
--     *_file_url de medical_history se siguen seteando apuntando a la
--     ruta servida, asi getHealth/transformer no se rompen.
--
-- Idempotente: IF NOT EXISTS en todo. Re-correr no rompe nada.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs               JSONB NOT NULL DEFAULT '{}',
    -- {reminders:[{id,label,sub,time,on}], custom_reminders:[{id,time,msg}],
    --  quiet_hours:{from,to}, alert_threshold_pct:int,
    --  bot_tone:'rocky'|'analytic'|'empathic',
    --  privacy:{rank:bool, community_avg:bool, newsletter:bool}}
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE user_preferences IS
  'Preferencias del perfil web: recordatorios, zona de silencio, umbral '
  'de alerta, tono del bot, privacidad. 1:1 con users. El cron/bot lo lee.';

CREATE TABLE IF NOT EXISTS medical_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot                TEXT NOT NULL CHECK (slot IN
                          ('ecg', 'xray', 'blood_work', 'medical_clearance', 'other')),
    doc_type            TEXT NOT NULL,
    -- etiqueta legible que eligio el usuario ("Electrocardiograma", etc.)
    raw_file_bytes      BYTEA NOT NULL,
    raw_file_mime       TEXT NOT NULL,
    raw_file_name       TEXT NOT NULL,
    raw_file_size       INT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_medical_documents_user
  ON medical_documents (user_id, created_at DESC);

COMMENT ON TABLE medical_documents IS
  'Documentos clinicos (ECG, radiografia, analisis, apto) como BYTEA. '
  'Mismo patron que nutrition_plan_files. medical_history.*_file_url '
  'apunta a la ruta servida del ultimo doc de cada slot.';
