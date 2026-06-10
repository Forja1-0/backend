import { query } from "../config/db.js";
import type { User } from "../types/user.types.js";
import { jidToPhone, arPhoneKey } from "../utils/phone.js";

// findByPhone es interna (la usa linkOrCreateByJid). El bot resuelve al usuario
// vía linkOrCreateByJid, no por JID directo.
async function findByPhone(phone: string): Promise<User | null> {
  // Match por clave nacional (ultimos 10 digitos), no exacto: el onboarding
  // guarda "2645267544" y WhatsApp manda "5492645267544". Ante varias filas
  // (ej: shell de WA + perfil real) preferimos el mas avanzado en onboarding.
  const key = arPhoneKey(phone);
  const { rows } = await query<User>(
    `SELECT * FROM users
     WHERE RIGHT(regexp_replace(phone_wa, '[^0-9]', '', 'g'), 10) = $1
     ORDER BY onboarding_step DESC, created_at ASC
     LIMIT 1`,
    [key],
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
