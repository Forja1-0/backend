import { query } from "../config/db.js";

export interface ReminderRow {
  id: string;
  user_id: string;
  label: string;
  message: string;
  cron_expr: string;
  active: boolean;
  last_fired_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateReminderInput {
  user_id: string;
  label: string;
  message: string;
  cron_expr: string;
  active?: boolean;
}

export interface UpdateReminderInput {
  label?: string;
  message?: string;
  cron_expr?: string;
  active?: boolean;
}

export async function listForUser(userId: string): Promise<ReminderRow[]> {
  const { rows } = await query<ReminderRow>(
    `SELECT id, user_id, label, message, cron_expr, active,
            last_fired_at, created_at, updated_at
     FROM user_reminders
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

export async function create(input: CreateReminderInput): Promise<ReminderRow> {
  const { rows } = await query<ReminderRow>(
    `INSERT INTO user_reminders (user_id, label, message, cron_expr, active)
     VALUES ($1, $2, $3, $4, COALESCE($5, true))
     RETURNING id, user_id, label, message, cron_expr, active,
               last_fired_at, created_at, updated_at`,
    [input.user_id, input.label, input.message, input.cron_expr, input.active],
  );
  return rows[0];
}

export async function update(
  id: string,
  userId: string,
  patch: UpdateReminderInput,
): Promise<ReminderRow | null> {
  // Patch dinamico: solo las columnas presentes en el body.
  const sets: string[] = [];
  const params: unknown[] = [id, userId];
  let i = 3;
  if (patch.label !== undefined) {
    sets.push(`label = $${i++}`);
    params.push(patch.label);
  }
  if (patch.message !== undefined) {
    sets.push(`message = $${i++}`);
    params.push(patch.message);
  }
  if (patch.cron_expr !== undefined) {
    sets.push(`cron_expr = $${i++}`);
    params.push(patch.cron_expr);
  }
  if (patch.active !== undefined) {
    sets.push(`active = $${i++}`);
    params.push(patch.active);
  }
  if (sets.length === 0) return getById(id, userId);
  sets.push(`updated_at = NOW()`);

  const { rows } = await query<ReminderRow>(
    `UPDATE user_reminders SET ${sets.join(", ")}
     WHERE id = $1 AND user_id = $2
     RETURNING id, user_id, label, message, cron_expr, active,
               last_fired_at, created_at, updated_at`,
    params,
  );
  return rows[0] ?? null;
}

export async function getById(id: string, userId: string): Promise<ReminderRow | null> {
  const { rows } = await query<ReminderRow>(
    `SELECT id, user_id, label, message, cron_expr, active,
            last_fired_at, created_at, updated_at
     FROM user_reminders
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function remove(id: string, userId: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM user_reminders WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Devuelve recordatorios activos para evaluacion del tick del cron.
 * El cron evalua el cron_expr en memoria con node-cron (matchea HH:MM
 * del momento actual), por eso aca solo filtramos por active=true.
 * Incluye datos del usuario destinatario para que el cron mande WA.
 */
export interface ActiveReminderForTick {
  id: string;
  user_id: string;
  label: string;
  message: string;
  cron_expr: string;
  last_fired_at: Date | null;
  wa_chat_id: string | null;
  phone_wa: string | null;
  timezone: string | null;
}

export async function getActiveForTick(): Promise<ActiveReminderForTick[]> {
  const { rows } = await query<ActiveReminderForTick>(
    `SELECT r.id, r.user_id, r.label, r.message, r.cron_expr, r.last_fired_at,
            u.wa_chat_id, u.phone_wa, u.timezone
     FROM user_reminders r
     JOIN users u ON u.id = r.user_id
     WHERE r.active = true
       AND u.active = true
       AND (u.wa_chat_id IS NOT NULL OR u.phone_wa IS NOT NULL)`,
  );
  return rows;
}

export async function markFired(id: string): Promise<void> {
  await query(
    `UPDATE user_reminders SET last_fired_at = NOW() WHERE id = $1`,
    [id],
  );
}
