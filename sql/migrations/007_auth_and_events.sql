-- ============================================================
-- Migration 007: auth tokens de WhatsApp -> web_profile + events
-- ============================================================
-- Dos tablas nuevas para conectar el bot con el perfil web sin
-- pedirle al usuario que recuerde mail/password.
--
--  1. whatsapp_auth_tokens: el usuario escribe "perfil" en WhatsApp
--     y el bot le devuelve un link unico con un token de 10 chars.
--     Al tocar el link, el web_profile consume el token y recibe
--     una sesion. Single-use, 15min TTL, atado al user_id ya
--     identificado por su numero de WhatsApp.
--
--  2. web_sessions: sesion del navegador una vez consumido el token.
--     Opaque token (no JWT) para que sea revocable y auditable.
--     30 dias de vida; cada request al backend valida con un INDEX.
--
--  3. events: log generico para cultura data-first. Cualquier accion
--     del usuario o del sistema se persiste con payload JSONB + IP +
--     user agent. Despues se analiza con SQL/BI sin tocar el resto
--     del schema.
--
-- Idempotente: IF NOT EXISTS en todo. Re-correr no rompe nada.
-- ============================================================

-- ── 1. whatsapp_auth_tokens ────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_auth_tokens (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token               TEXT NOT NULL UNIQUE,
    -- 10 chars alfanumericos sin ambiguos (no 0/O/1/l/I). El UNIQUE
    -- garantiza que no haya colisiones aun con millones de tokens.
    expires_at          TIMESTAMPTZ NOT NULL,
    used_at             TIMESTAMPTZ,
    -- NULL = aun no consumido. Una vez seteado, el token muere.
    used_ip             INET,
    used_user_agent     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_ip          INET
    -- IP del bot/webhook que genero el token (server-side, info-only).
);

-- Lookup por token al consumir. Es el hot path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_auth_tokens_token
  ON whatsapp_auth_tokens (token);

-- Para invalidar tokens previos del mismo user al generar uno nuevo.
CREATE INDEX IF NOT EXISTS idx_wa_auth_tokens_user_active
  ON whatsapp_auth_tokens (user_id, expires_at)
  WHERE used_at IS NULL;

COMMENT ON TABLE whatsapp_auth_tokens IS
  'Tokens de un solo uso generados al escribir "perfil" en WhatsApp. '
  '15min TTL, single-use, atados al user_id identificado por el JID.';

-- ── 2. web_sessions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS web_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token       TEXT NOT NULL UNIQUE,
    -- 32 bytes random base64url. No es un secreto adivinable.
    issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    issued_ip           INET,
    issued_user_agent   TEXT,
    last_ip             INET,
    last_user_agent     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_web_sessions_token
  ON web_sessions (session_token);

CREATE INDEX IF NOT EXISTS idx_web_sessions_user
  ON web_sessions (user_id, issued_at DESC);

COMMENT ON TABLE web_sessions IS
  'Sesion del navegador en web_profile. Opaque token revocable, '
  '30 dias TTL. Cada request del front lo manda como Authorization '
  'header y el middleware updatea last_seen_at/last_ip.';

-- ── 3. system_events ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_events (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    -- nullable para eventos sin usuario identificado (intentos de
    -- auth fallidos antes de saber quien es).
    event_type          TEXT NOT NULL,
    -- Convencion: snake_case con namespace. Ej:
    --   auth.token_issued        auth.token_consumed
    --   auth.token_failed        auth.session_started
    --   profile.section_viewed   profile.identity_updated
    --   wa.command_received      wa.message_sent
    payload             JSONB NOT NULL DEFAULT '{}',
    ip                  INET,
    user_agent          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_events_user_created
  ON system_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_system_events_type_created
  ON system_events (event_type, created_at DESC);

-- JSONB GIN para queries tipo "WHERE payload @> '{section: nutrition}'"
CREATE INDEX IF NOT EXISTS idx_system_events_payload_gin
  ON system_events USING GIN (payload);

COMMENT ON TABLE system_events IS
  'Log generico de eventos. Cualquier accion relevante (auth, vistas, '
  'mutaciones, mensajes del bot) se appendea aca con payload JSONB. '
  'Base de toda la observabilidad y analytics del producto.';
