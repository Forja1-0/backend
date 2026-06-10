import { query } from "../config/db.js";

/**
 * Snapshot liviano del progreso del usuario para alimentar el mensaje motivador
 * que genera la AI. Una sola query. La racha cuenta días distintos con comida O
 * entreno reportado en los últimos 90 días (coherente con "días reportando tu
 * nutrición/entrenamiento").
 */
export interface ProgressSnapshot {
  dayStreak: number;
  mealsThisWeek: number;
  trainingsThisWeek: number;
  weightLatest: number | null;
  weightFirst: number | null;
  weightDelta: number | null;
  weightCount: number;
}

export async function getProgressSnapshot(userId: string): Promise<ProgressSnapshot> {
  const { rows } = await query<{
    run: number;
    last_day: string | null;
    today: string;
    meals_7d: number;
    trainings_7d: number;
    w_latest: number | null;
    w_first: number | null;
    w_count: number;
  }>(
    `WITH days AS (
       SELECT DISTINCT logged_at::date AS day FROM meal_logs
         WHERE user_id = $1 AND confirmed = true AND logged_at >= now() - interval '90 days'
       UNION
       SELECT DISTINCT logged_at::date AS day FROM training_logs
         WHERE user_id = $1 AND logged_at >= now() - interval '90 days'
     ),
     anchored AS (
       SELECT day, (SELECT max(day) FROM days) AS last_day,
              row_number() OVER (ORDER BY day DESC) AS rn
       FROM days
     )
     SELECT
       (SELECT COUNT(*)::int FROM anchored a
          WHERE a.day = (a.last_day - (a.rn - 1) * interval '1 day')::date) AS run,
       (SELECT max(day) FROM days)::text AS last_day,
       CURRENT_DATE::text AS today,
       (SELECT COUNT(*)::int FROM meal_logs
          WHERE user_id = $1 AND confirmed = true AND logged_at >= now() - interval '7 days') AS meals_7d,
       (SELECT COUNT(*)::int FROM training_logs
          WHERE user_id = $1 AND logged_at >= now() - interval '7 days') AS trainings_7d,
       (SELECT weight_kg FROM weight_logs WHERE user_id = $1 ORDER BY logged_at DESC, created_at DESC LIMIT 1) AS w_latest,
       (SELECT weight_kg FROM weight_logs WHERE user_id = $1 ORDER BY logged_at ASC, created_at ASC LIMIT 1) AS w_first,
       (SELECT COUNT(*)::int FROM weight_logs WHERE user_id = $1) AS w_count`,
    [userId],
  );
  const r = rows[0];
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    dayStreak: computeActiveStreak(r?.run ?? 0, r?.last_day ?? null, r?.today ?? null),
    mealsThisWeek: r?.meals_7d ?? 0,
    trainingsThisWeek: r?.trainings_7d ?? 0,
    weightLatest: r?.w_latest ?? null,
    weightFirst: r?.w_first ?? null,
    weightDelta: r?.w_latest != null && r?.w_first != null ? round1(r.w_latest - r.w_first) : null,
    weightCount: r?.w_count ?? 0,
  };
}

// La racha sigue activa solo si el último día reportado es hoy o ayer.
function computeActiveStreak(run: number, lastDay: string | null, today: string | null): number {
  if (!run || !lastDay || !today) return 0;
  const t = new Date(today + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() - 1);
  const yesterday = t.toISOString().slice(0, 10);
  return lastDay === today || lastDay === yesterday ? run : 0;
}

// ── Planificador semanal ──────────────────────────────────
export type NudgeKind = "morning" | "midday" | "night";

export interface NudgeSlot {
  scheduled_for: Date;
  kind: NudgeKind;
}

export async function isWeekPlanned(userId: string, weekStart: string): Promise<boolean> {
  const { rows } = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM motivation_nudges WHERE user_id = $1 AND week_start = $2`,
    [userId, weekStart],
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function insertNudges(
  userId: string,
  weekStart: string,
  slots: NudgeSlot[],
): Promise<number> {
  if (slots.length === 0) return 0;
  // Construimos un VALUES multi-fila parametrizado.
  const values: string[] = [];
  const params: unknown[] = [userId, weekStart];
  let i = 3;
  for (const s of slots) {
    values.push(`($1, $2, $${i++}, $${i++})`);
    params.push(s.scheduled_for, s.kind);
  }
  const { rowCount } = await query(
    `INSERT INTO motivation_nudges (user_id, week_start, scheduled_for, kind) VALUES ${values.join(", ")}`,
    params,
  );
  return rowCount ?? 0;
}

/** Usuarios activos con WhatsApp y onboarding terminado (candidatos a motivación). */
export async function getEligibleUsers(): Promise<
  Array<{ id: string; name: string | null; wa_chat_id: string }>
> {
  const { rows } = await query<{ id: string; name: string | null; wa_chat_id: string }>(
    `SELECT id, name, wa_chat_id FROM users
     WHERE active = true AND wa_chat_id IS NOT NULL AND onboarding_step >= 7`,
  );
  return rows;
}

// ── Tick ──────────────────────────────────────────────────
export interface DueNudge {
  id: string;
  user_id: string;
  kind: NudgeKind;
  scheduled_for: Date;
  name: string | null;
  wa_chat_id: string;
  timezone: string | null;
}

export async function getDueNudges(): Promise<DueNudge[]> {
  const { rows } = await query<DueNudge>(
    `SELECT n.id, n.user_id, n.kind, n.scheduled_for, u.name, u.wa_chat_id, u.timezone
     FROM motivation_nudges n
     JOIN users u ON u.id = n.user_id
     WHERE n.status = 'pending'
       AND n.scheduled_for <= now()
       AND u.active = true
       AND u.wa_chat_id IS NOT NULL
     ORDER BY n.scheduled_for ASC
     LIMIT 50`,
  );
  return rows;
}

export async function markSent(id: string): Promise<void> {
  await query(`UPDATE motivation_nudges SET status = 'sent', sent_at = now() WHERE id = $1`, [id]);
}

export async function markSkipped(id: string): Promise<void> {
  await query(`UPDATE motivation_nudges SET status = 'skipped' WHERE id = $1`, [id]);
}
