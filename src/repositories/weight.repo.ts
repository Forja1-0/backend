import { query, tx } from "../config/db.js";

/**
 * Repo de peso corporal (weight_logs, migración 011). Cada peso nuevo:
 *  - inserta una fila en weight_logs (la serie temporal), y
 *  - actualiza users.weight_kg (el "peso actual" que usa el cálculo de BMR).
 * Ambas cosas en una tx para que no queden desincronizadas.
 */

export type WeightSource = "whatsapp" | "onboarding_seed" | "profile";

export interface WeightLogRow {
  id: string;
  weight_kg: number;
  source: string;
  logged_at: Date;
}

/** Guarda un peso y sincroniza users.weight_kg. Devuelve la fila insertada. */
export async function saveWeight(
  userId: string,
  weightKg: number,
  source: WeightSource = "whatsapp",
): Promise<WeightLogRow> {
  return tx(async (client) => {
    const { rows } = await client.query<WeightLogRow>(
      `INSERT INTO weight_logs (user_id, weight_kg, source)
       VALUES ($1, $2, $3)
       RETURNING id, weight_kg, source, logged_at`,
      [userId, weightKg, source],
    );
    await client.query(
      `UPDATE users SET weight_kg = $2, updated_at = now() WHERE id = $1`,
      [userId, weightKg],
    );
    return rows[0];
  });
}

export interface WeightTrend {
  latest: number;
  /** Peso anterior al último (para el delta del último registro). null si es el primero. */
  previous: number | null;
  /** Primer peso registrado (punto de partida). */
  first: number;
  count: number;
  /** latest - first (negativo = bajó). */
  deltaFromFirst: number;
  /** latest - previous, o null si no hay anterior. */
  deltaFromPrevious: number | null;
}

/**
 * Resumen de tendencia para el mensaje de confirmación del bot. Una sola query
 * que trae primero, último y anteúltimo + el conteo.
 */
export async function getWeightTrend(userId: string): Promise<WeightTrend | null> {
  const { rows } = await query<{ weight_kg: number; logged_at: Date }>(
    `SELECT weight_kg, logged_at FROM weight_logs
     WHERE user_id = $1 ORDER BY logged_at DESC, created_at DESC`,
    [userId],
  );
  if (rows.length === 0) return null;

  const latest = rows[0].weight_kg;
  const previous = rows.length > 1 ? rows[1].weight_kg : null;
  const first = rows[rows.length - 1].weight_kg;
  const round1 = (n: number) => Math.round(n * 10) / 10;

  return {
    latest,
    previous,
    first,
    count: rows.length,
    deltaFromFirst: round1(latest - first),
    deltaFromPrevious: previous == null ? null : round1(latest - previous),
  };
}

/**
 * Candidatos al pedido semanal de peso: usuarios activos con WhatsApp y una
 * meta de peso (lose_weight | gain_muscle) que NO se pesaron en los últimos
 * 5 días. Para los demás objetivos el peso no es la señal, así que no se pide.
 */
export async function getWeightAskCandidates(): Promise<
  Array<{ id: string; name: string | null; wa_chat_id: string }>
> {
  const { rows } = await query<{ id: string; name: string | null; wa_chat_id: string }>(
    `SELECT u.id, u.name, u.wa_chat_id
     FROM users u
     JOIN goals g ON g.user_id = u.id AND g.is_active = true
     WHERE u.active = true
       AND u.wa_chat_id IS NOT NULL
       AND g.goal_kind IN ('lose_weight', 'gain_muscle')
       AND NOT EXISTS (
         SELECT 1 FROM weight_logs w
         WHERE w.user_id = u.id AND w.logged_at > now() - interval '5 days'
       )`,
  );
  return rows;
}
