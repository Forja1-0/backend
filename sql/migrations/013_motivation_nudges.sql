-- ============================================================
-- Migration 013: motivation_nudges — motor de motivación dinámico
-- ============================================================
-- El bot no debe esperar a que el usuario entre a la web para sentir que
-- avanza: le habla solo. Mensajes motivadores ESPONTÁNEOS, no a horario fijo.
--
-- Cada fila es un "slot" one-shot: un momento futuro (scheduled_for) y un tipo
-- (kind) que le da color al prompt. El MENSAJE no se guarda acá: lo genera la
-- AI en el momento de enviar, fresco y con el contexto del día (meta, racha,
-- tendencia de peso). Así dos "morning" nunca salen iguales.
--
-- Frecuencia dinámica: un planificador semanal elige un N aleatorio de slots
-- por semana (3 una semana, 2 otra, 6 otra...) y los reparte en días/horas
-- random. week_start ancla la semana planificada (idempotencia: no re-planear).
CREATE TABLE IF NOT EXISTS motivation_nudges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('morning', 'midday', 'night')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped')),
  week_start    DATE NOT NULL,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El tick busca los vencidos pendientes: índice por status+scheduled_for.
CREATE INDEX IF NOT EXISTS idx_motivation_nudges_due
  ON motivation_nudges (status, scheduled_for)
  WHERE status = 'pending';

-- El planificador chequea si ya planeó la semana de un usuario.
CREATE INDEX IF NOT EXISTS idx_motivation_nudges_user_week
  ON motivation_nudges (user_id, week_start);
