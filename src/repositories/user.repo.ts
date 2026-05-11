import { query } from "../config/db.js";
import type { User } from "../types/user.types.js";
import { jidToPhone } from "../utils/phone.js";

export async function findByJid(jid: string): Promise<User | null> {
  const { rows } = await query<User>(
    `SELECT * FROM users WHERE wa_chat_id = $1 LIMIT 1`,
    [jid],
  );
  return rows[0] ?? null;
}

export async function findByPhone(phone: string): Promise<User | null> {
  const { rows } = await query<User>(
    `SELECT * FROM users WHERE phone_wa = $1 LIMIT 1`,
    [phone],
  );
  return rows[0] ?? null;
}

/**
 * Vincula un JID a un usuario existente identificado por phone_wa,
 * o crea un placeholder si no existe (caso: user escribio antes de hacer onboarding).
 */
export async function linkOrCreateByJid(jid: string, pushName?: string): Promise<User> {
  const phone = jidToPhone(jid);

  const existing = await findByPhone(phone);
  if (existing) {
    if (existing.wa_chat_id !== jid) {
      const { rows } = await query<User>(
        `UPDATE users SET wa_chat_id = $1, updated_at = now()
         WHERE id = $2 RETURNING *`,
        [jid, existing.id],
      );
      return rows[0];
    }
    return existing;
  }

  const { rows } = await query<User>(
    `INSERT INTO users (name, phone_wa, wa_chat_id, onboarding_step, active)
     VALUES ($1, $2, $3, 0, true)
     ON CONFLICT (wa_chat_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [pushName ?? null, phone, jid],
  );
  return rows[0];
}
