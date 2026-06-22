-- ============================================================
-- Migration 014: sleep_metric — el sueño se mueve a la mañana y entra al score
-- ============================================================
-- Antes el sueño se preguntaba en el check-in NOCTURNO y NO se guardaba: iba
-- solo como evento + input del mensaje AI de cierre. Ahora se pregunta a la
-- MAÑANA (junto al "inicio del día": apenas te levantás sabés qué te toca hoy y
-- registrás cómo dormiste) y se PERSISTE acá, en escala 1-10, para que alimente
-- el performance_score y las métricas del perfil.
ALTER TABLE daily_summaries
  ADD COLUMN IF NOT EXISTS sleep INT CHECK (sleep BETWEEN 1 AND 10);

-- ============================================================
-- Performance Score con sueño como input.
-- Con sueño cargado:  nutrición 0.40 + entreno 0.30 + sueño 0.15 + no_desliz 0.15
-- Sin sueño (NULL):   fórmula histórica (nutrición 0.50 + entreno 0.35 + no_desliz 0.15)
-- El sueño 1-10 se normaliza a 0-100 (sleep*10). NULL no penaliza: cae a la
-- fórmula vieja para no romper días sin registro (compat hacia atrás).
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
    v_sleep INT;
    v_nutrition_score REAL;
    v_training_score REAL;
    v_desliz_score REAL;
    v_sleep_score REAL;
BEGIN
    -- Nutrición + entreno + sueño del día (todo vive en daily_summaries)
    SELECT kcal_adherence_pct, protein_adherence_pct, training_completed, sleep
    INTO v_kcal_pct, v_protein_pct, v_training_done, v_sleep
    FROM daily_summaries
    WHERE user_id = p_user_id AND summary_date = p_date;

    IF v_kcal_pct IS NULL THEN RETURN NULL; END IF;

    -- Nutrición: promedio de adherencia kcal y proteína, cap 100%
    v_nutrition_score := LEAST(((COALESCE(v_kcal_pct, 0) + COALESCE(v_protein_pct, 0)) / 2.0), 100);

    -- Entrenamiento: ¿completó la sesión del día?
    v_training_score := CASE WHEN v_training_done = true THEN 100 ELSE 0 END;

    -- Desliz: ¿hubo desliz ese día?
    SELECT EXISTS(
        SELECT 1 FROM events
        WHERE user_id = p_user_id
          AND event_type = 'desliz'
          AND occurred_at::date = p_date
    ) INTO v_had_desliz;
    v_desliz_score := CASE WHEN v_had_desliz THEN 0 ELSE 100 END;

    IF v_sleep IS NOT NULL THEN
        -- Sueño 1-10 -> 0-100
        v_sleep_score := LEAST(v_sleep * 10, 100);
        RETURN ROUND(
            (v_nutrition_score * 0.40) +
            (v_training_score  * 0.30) +
            (v_sleep_score     * 0.15) +
            (v_desliz_score    * 0.15)
        )::INT;
    END IF;

    -- Sin sueño cargado: fórmula histórica
    RETURN ROUND(
        (v_nutrition_score * 0.50) +
        (v_training_score  * 0.35) +
        (v_desliz_score    * 0.15)
    )::INT;
END;
$$ LANGUAGE plpgsql;
