/**
 * Store en memoria para sesiones de conversación multi-paso.
 * Cada usuario puede estar en el medio de un flujo (ej: captura de RPE,
 * check-in nocturno, confirmación de comida). Guardamos el estado por JID.
 *
 * En prod esto alcanza para MVP — si el proceso se reinicia se pierden las
 * sesiones activas (máx 1-2 min de inconveniencia).
 */

export interface PendingMeal {
  parsed_items: Array<{
    name: string;
    grams: number;
    kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    food_item_id: string | null;
    matched_db_name: string | null;
  }>;
  totals: { kcal: number; protein: number; carbs: number; fat: number };
  is_estimate: boolean;
  raw_input: string;
}

export type SessionState =
  | { flow: "rpe_capture"; training_log_id: string }
  | { flow: "checkin_nutrition"; step: 1 }
  | { flow: "checkin_sleep"; step: 2; nutrition_ok: boolean }
  | { flow: "checkin_pain"; step: 3; nutrition_ok: boolean; sleep: number }
  | { flow: "meal_confirm"; meal: PendingMeal }
  | { flow: "baja_confirm" };

const store = new Map<string, SessionState>();

const TTL_MS = 10 * 60 * 1000;
const expirations = new Map<string, ReturnType<typeof setTimeout>>();

function resetTtl(jid: string) {
  const prev = expirations.get(jid);
  if (prev) clearTimeout(prev);
  expirations.set(
    jid,
    setTimeout(() => {
      store.delete(jid);
      expirations.delete(jid);
    }, TTL_MS),
  );
}

export function getSession(jid: string): SessionState | null {
  return store.get(jid) ?? null;
}

export function setSession(jid: string, state: SessionState): void {
  store.set(jid, state);
  resetTtl(jid);
}

export function clearSession(jid: string): void {
  const timer = expirations.get(jid);
  if (timer) clearTimeout(timer);
  store.delete(jid);
  expirations.delete(jid);
}
