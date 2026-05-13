-- ============================================================
-- FORJA — Schema completo para Postgres
-- Fase Toyota (MVP) · Mayo 2026
-- Correr en EasyPanel con Postgres 16+
-- ============================================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid(), encrypt/decrypt
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- Fuzzy matching para parser de comidas

-- ============================================================
-- 1. USERS — Centro de todo
-- ============================================================
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    age             INT NOT NULL CHECK (age BETWEEN 16 AND 70),
    sex             TEXT NOT NULL CHECK (sex IN ('M', 'F', 'X')),
    weight_kg       REAL NOT NULL CHECK (weight_kg > 0),
    height_cm       REAL NOT NULL CHECK (height_cm > 0),
    body_fat_pct    REAL CHECK (body_fat_pct BETWEEN 1 AND 60),
    email           TEXT NOT NULL UNIQUE,
    phone_wa        TEXT NOT NULL,
    wa_chat_id      TEXT UNIQUE,
    timezone        TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
    active          BOOLEAN NOT NULL DEFAULT true,
    onboarding_step INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_wa ON users (wa_chat_id) WHERE wa_chat_id IS NOT NULL;
CREATE INDEX idx_users_active ON users (active) WHERE active = true;

-- ============================================================
-- 2. MEDICAL_HISTORY — 1:1 con users
-- Dato sensible Ley 25.326 → encriptación en reposo
-- ============================================================
CREATE TABLE medical_history (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    active_injuries         JSONB NOT NULL DEFAULT '[]',
    -- [{description, location, pain_level (0-10), start_date, in_treatment}]
    past_injuries           JSONB NOT NULL DEFAULT '[]',
    -- [{description, type, year}]
    chronic_conditions      JSONB NOT NULL DEFAULT '[]',
    -- ["asma", "diabetes_t1", "hipertension", ...]
    allergies               JSONB NOT NULL DEFAULT '[]',
    -- ["maní", "mariscos", ...]
    medications             JSONB NOT NULL DEFAULT '[]',
    -- [{name, dose, schedule}]
    ecg_file_url            TEXT,
    xray_file_url           TEXT,
    blood_work_url          TEXT,
    medical_clearance_url   TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 3. GOALS — Objetivo deportivo
-- ============================================================
CREATE TABLE goals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL CHECK (event_type IN ('competition', 'recomp', 'performance')),
    event_name      TEXT,
    event_date      DATE NOT NULL,
    distance        TEXT,
    objective_notes TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_goals_user_active ON goals (user_id) WHERE is_active = true;

-- Solo un goal activo por usuario
CREATE UNIQUE INDEX idx_goals_one_active ON goals (user_id) WHERE is_active = true;

-- ============================================================
-- 4. NUTRITION_PLANS — Macros target
-- ============================================================
CREATE TABLE nutrition_plans (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_kcal         INT NOT NULL CHECK (target_kcal BETWEEN 800 AND 8000),
    target_protein_g    INT NOT NULL CHECK (target_protein_g >= 0),
    target_carbs_g      INT NOT NULL CHECK (target_carbs_g >= 0),
    target_fat_g        INT NOT NULL CHECK (target_fat_g >= 0),
    meal_distribution   JSONB,
    -- {desayuno: {kcal: 500}, almuerzo: {kcal: 800}, ...}
    nutritionist_name   TEXT,
    plan_file_url       TEXT,
    -- PDF original + parseo rico (migration 003)
    raw_file_bytes      BYTEA,
    raw_file_mime       TEXT,
    raw_file_name       TEXT,
    raw_file_size       INT,
    parsed_data         JSONB,
    parsed_at           TIMESTAMPTZ,
    parser_version      TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_nutrition_one_active ON nutrition_plans (user_id) WHERE is_active = true;

-- ============================================================
-- 4b. TRAINING_PLAN_FILES — PDF original + parseo rico
-- Complementa training_plans (row-per-day, queries del bot)
-- ============================================================
CREATE TABLE training_plan_files (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    coach_name          TEXT,
    raw_file_bytes      BYTEA,
    raw_file_mime       TEXT,
    raw_file_name       TEXT,
    raw_file_size       INT,
    parsed_data         JSONB NOT NULL,
    parser_version      TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    parsed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_training_plan_files_one_active
  ON training_plan_files (user_id) WHERE is_active = true;
CREATE INDEX idx_training_plan_files_parsed_gin
  ON training_plan_files USING GIN (parsed_data);

-- ============================================================
-- 5. DIETARY_RESTRICTIONS — 1:1 con users
-- ============================================================
CREATE TABLE dietary_restrictions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    no_beef             BOOLEAN NOT NULL DEFAULT false,
    no_chicken          BOOLEAN NOT NULL DEFAULT false,
    no_pork             BOOLEAN NOT NULL DEFAULT false,
    no_fish             BOOLEAN NOT NULL DEFAULT false,
    no_dairy            BOOLEAN NOT NULL DEFAULT false,
    no_eggs             BOOLEAN NOT NULL DEFAULT false,
    vegan               BOOLEAN NOT NULL DEFAULT false,
    vegetarian          BOOLEAN NOT NULL DEFAULT false,
    celiac              BOOLEAN NOT NULL DEFAULT false,
    lactose_intolerant  BOOLEAN NOT NULL DEFAULT false,
    other               TEXT
);

-- ============================================================
-- 6. TRAINING_PLANS — 1 fila por día de semana
-- ============================================================
CREATE TABLE training_plans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day_of_week     INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    -- 0=domingo, 1=lunes ... 6=sábado (ISO dow)
    session_type    TEXT NOT NULL,
    -- gym, natacion, bici, corrida, funcional, crossfit, yoga, descanso, otro
    session_name    TEXT,
    -- "Piernas A", "Intervalos 5x1000"
    approx_time     TIME,
    duration_min    INT CHECK (duration_min > 0),
    coach_name      TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Query del recordatorio matutino:
-- SELECT * FROM training_plans 
-- WHERE user_id = $1 AND day_of_week = EXTRACT(DOW FROM NOW()) AND is_active = true
CREATE INDEX idx_training_user_day ON training_plans (user_id, day_of_week) WHERE is_active = true;

-- ============================================================
-- 7. FREQUENT_MEALS — Comidas pre-armadas del usuario
-- ============================================================
CREATE TABLE frequent_meals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alias               TEXT NOT NULL,
    -- "desayuno 1", "almuerzo gym", "snack post"
    ingredients         JSONB NOT NULL DEFAULT '[]',
    -- [{food_item_id, name, grams, kcal, protein, carbs, fat}]
    total_kcal          INT NOT NULL DEFAULT 0,
    total_protein_g     REAL NOT NULL DEFAULT 0,
    total_carbs_g       REAL NOT NULL DEFAULT 0,
    total_fat_g         REAL NOT NULL DEFAULT 0,
    use_count           INT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup por alias del usuario (el query más frecuente del bot)
CREATE INDEX idx_frequent_meals_alias ON frequent_meals (user_id, lower(alias));

-- ============================================================
-- 8. FOOD_ITEMS — 913 alimentos argentinos (SARA 2)
-- Tabla compartida, no por usuario
-- ============================================================
CREATE TABLE food_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    category            TEXT NOT NULL,
    -- verdura, fruta, proteina_animal, carbohidrato, lacteo, legumbre,
    -- grasa, fruto_seco, dulce, bebida, suplemento, otro
    kcal_per_100g       INT NOT NULL,
    protein_per_100g    REAL NOT NULL DEFAULT 0,
    carbs_per_100g      REAL NOT NULL DEFAULT 0,
    fat_per_100g        REAL NOT NULL DEFAULT 0,
    fiber_per_100g      REAL NOT NULL DEFAULT 0,
    standard_portion_g  INT,
    source              TEXT NOT NULL DEFAULT 'SARA2',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Full-text search en español para el parser de comidas descriptivas
CREATE INDEX idx_food_items_fts ON food_items USING gin (to_tsvector('spanish', name));
-- Fuzzy matching para tolerancia a typos ("pechga" → "pechuga")
CREATE INDEX idx_food_items_trgm ON food_items USING gin (name gin_trgm_ops);
CREATE INDEX idx_food_items_category ON food_items (category);

-- ============================================================
-- 9. MEAL_LOGS — Registro de cada comida
-- ============================================================
CREATE TABLE meal_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    frequent_meal_id    UUID REFERENCES frequent_meals(id),
    input_mode          TEXT NOT NULL CHECK (input_mode IN ('quick', 'descriptive', 'precise')),
    raw_input           TEXT NOT NULL,
    -- Texto original del usuario: "desayuno 1", "almorcé pollo con arroz"
    parsed_items        JSONB NOT NULL DEFAULT '[]',
    -- [{name, grams, kcal, protein, carbs, fat, food_item_id?}]
    total_kcal          INT NOT NULL DEFAULT 0,
    total_protein_g     REAL NOT NULL DEFAULT 0,
    total_carbs_g       REAL NOT NULL DEFAULT 0,
    total_fat_g         REAL NOT NULL DEFAULT 0,
    is_estimate         BOOLEAN NOT NULL DEFAULT false,
    confirmed           BOOLEAN NOT NULL DEFAULT false,
    logged_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Resumen nocturno: sumar todo del día para un usuario
CREATE INDEX idx_meal_logs_user_date ON meal_logs (user_id, logged_at);
-- Para analytics: distribución de input modes
CREATE INDEX idx_meal_logs_mode ON meal_logs (input_mode);

-- ============================================================
-- 10. TRAINING_LOGS — Registro de cada sesión
-- ============================================================
CREATE TABLE training_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    training_plan_id    UUID REFERENCES training_plans(id),
    session_name        TEXT NOT NULL,
    completed           BOOLEAN NOT NULL DEFAULT true,
    rpe                 INT CHECK (rpe BETWEEN 1 AND 10),
    notes               TEXT,
    modifications       TEXT,
    -- "sin sentadilla", "solo 30 min", "bajé peso"
    logged_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_training_logs_user_date ON training_logs (user_id, logged_at);

-- ============================================================
-- 11. EVENTS — Deslices, disrupciones, PRs, milestones
-- La tabla que construye la narrativa del Journey Card
-- ============================================================
CREATE TABLE events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL CHECK (event_type IN ('desliz', 'illness', 'injury', 'pr', 'milestone')),
    description     TEXT NOT NULL,
    severity        INT CHECK (severity BETWEEN 1 AND 10),
    -- Solo para illness/injury
    action_plan     JSONB,
    -- Plan de 3 puntos generado por AI
    context         JSONB,
    -- Datos adicionales del momento (peso, score actual, etc.)
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ
    -- NULL hasta que se resuelva la lesión/enfermedad
);

CREATE INDEX idx_events_user_date ON events (user_id, occurred_at);
CREATE INDEX idx_events_type ON events (user_id, event_type);
-- Journey Card query: todos los eventos del usuario ordenados cronológicamente
CREATE INDEX idx_events_journey ON events (user_id, occurred_at) WHERE event_type IN ('desliz', 'illness', 'injury', 'pr', 'milestone');

-- ============================================================
-- 12. DAILY_SUMMARIES — Generado automáticamente a las 21h
-- ============================================================
CREATE TABLE daily_summaries (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    summary_date            DATE NOT NULL,
    total_kcal              INT NOT NULL DEFAULT 0,
    total_protein_g         REAL NOT NULL DEFAULT 0,
    total_carbs_g           REAL NOT NULL DEFAULT 0,
    total_fat_g             REAL NOT NULL DEFAULT 0,
    kcal_adherence_pct      REAL,
    protein_adherence_pct   REAL,
    training_completed      BOOLEAN,
    training_rpe            INT,
    performance_score       INT CHECK (performance_score BETWEEN 0 AND 100),
    alert_sent              BOOLEAN NOT NULL DEFAULT false,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un resumen por usuario por día
CREATE UNIQUE INDEX idx_daily_summaries_unique ON daily_summaries (user_id, summary_date);
-- Journey Card semanal: últimos 7 días
CREATE INDEX idx_daily_summaries_range ON daily_summaries (user_id, summary_date DESC);

-- ============================================================
-- 13. JOURNEY_CARDS — Tarjetas visuales generadas
-- ============================================================
CREATE TABLE journey_cards (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_type           TEXT NOT NULL CHECK (card_type IN ('weekly', 'eve', 'post_race')),
    week_number         INT NOT NULL,
    total_weeks         INT NOT NULL,
    stats_snapshot      JSONB NOT NULL,
    -- {sessions_completed, sessions_total, nutrition_pct, score, weight, ...}
    narrative_text      TEXT,
    -- Generado por AI para víspera/post-race
    image_url           TEXT,
    shared              BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_journey_cards_user ON journey_cards (user_id, created_at DESC);

-- ============================================================
-- 14. CONSENTS — Obligatorio Ley 25.326
-- ============================================================
CREATE TABLE consents (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    data_processing         BOOLEAN NOT NULL DEFAULT false,
    international_transfer  BOOLEAN NOT NULL DEFAULT false,
    nutrition_disclaimer    BOOLEAN NOT NULL DEFAULT false,
    ip_address              TEXT,
    user_agent              TEXT,
    consented_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- FUNCIÓN: Actualizar updated_at automáticamente
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- FUNCIÓN: Calcular Performance Score del día
-- Fórmula: (nutrición_adherence * 0.5) + (entrenamiento * 0.35) + (no_desliz * 0.15)
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_performance_score(
    p_user_id UUID,
    p_date DATE
) RETURNS INT AS $$
DECLARE
    v_kcal_pct REAL;
    v_protein_pct REAL;
    v_training_done BOOLEAN;
    v_had_desliz BOOLEAN;
    v_nutrition_score REAL;
    v_training_score REAL;
    v_desliz_score REAL;
BEGIN
    -- Nutrición: promedio de adherencia kcal y proteína
    SELECT kcal_adherence_pct, protein_adherence_pct
    INTO v_kcal_pct, v_protein_pct
    FROM daily_summaries
    WHERE user_id = p_user_id AND summary_date = p_date;

    IF v_kcal_pct IS NULL THEN RETURN NULL; END IF;

    -- Cap at 100%
    v_nutrition_score := LEAST(((COALESCE(v_kcal_pct, 0) + COALESCE(v_protein_pct, 0)) / 2.0), 100);

    -- Entrenamiento: ¿completó la sesión del día?
    SELECT training_completed INTO v_training_done
    FROM daily_summaries
    WHERE user_id = p_user_id AND summary_date = p_date;

    v_training_score := CASE WHEN v_training_done = true THEN 100 ELSE 0 END;

    -- Desliz: ¿hubo desliz ese día?
    SELECT EXISTS(
        SELECT 1 FROM events
        WHERE user_id = p_user_id
          AND event_type = 'desliz'
          AND occurred_at::date = p_date
    ) INTO v_had_desliz;

    v_desliz_score := CASE WHEN v_had_desliz THEN 0 ELSE 100 END;

    -- Fórmula ponderada
    RETURN ROUND(
        (v_nutrition_score * 0.50) +
        (v_training_score * 0.35) +
        (v_desliz_score * 0.15)
    )::INT;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- VIEWS útiles para el bot
-- ============================================================

-- Vista: macros restantes del día para un usuario
CREATE OR REPLACE VIEW v_daily_remaining AS
SELECT
    u.id AS user_id,
    u.wa_chat_id,
    np.target_kcal,
    np.target_protein_g,
    np.target_carbs_g,
    np.target_fat_g,
    COALESCE(SUM(ml.total_kcal), 0) AS consumed_kcal,
    COALESCE(SUM(ml.total_protein_g), 0) AS consumed_protein,
    COALESCE(SUM(ml.total_carbs_g), 0) AS consumed_carbs,
    COALESCE(SUM(ml.total_fat_g), 0) AS consumed_fat,
    np.target_kcal - COALESCE(SUM(ml.total_kcal), 0) AS remaining_kcal,
    np.target_protein_g - COALESCE(SUM(ml.total_protein_g), 0) AS remaining_protein,
    np.target_carbs_g - COALESCE(SUM(ml.total_carbs_g), 0) AS remaining_carbs,
    np.target_fat_g - COALESCE(SUM(ml.total_fat_g), 0) AS remaining_fat
FROM users u
JOIN nutrition_plans np ON np.user_id = u.id AND np.is_active = true
LEFT JOIN meal_logs ml ON ml.user_id = u.id
    AND ml.logged_at::date = CURRENT_DATE
    AND ml.confirmed = true
WHERE u.active = true
GROUP BY u.id, u.wa_chat_id, np.target_kcal, np.target_protein_g, np.target_carbs_g, np.target_fat_g;

-- Vista: qué entrena hoy cada usuario activo (para recordatorio 6AM)
CREATE OR REPLACE VIEW v_today_training AS
SELECT
    u.id AS user_id,
    u.wa_chat_id,
    u.name,
    tp.session_type,
    tp.session_name,
    tp.approx_time,
    tp.duration_min
FROM users u
JOIN training_plans tp ON tp.user_id = u.id
    AND tp.day_of_week = EXTRACT(DOW FROM NOW() AT TIME ZONE u.timezone)::INT
    AND tp.is_active = true
WHERE u.active = true AND u.wa_chat_id IS NOT NULL;

-- ============================================================
-- FIN DEL SCHEMA
-- ============================================================
