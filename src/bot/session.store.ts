/**
 * Store en memoria para sesiones de conversación multi-paso.
 * Cada usuario puede estar en el medio de un flujo (ej: captura de RPE post-sesión,
 * check-in nocturno). Guardamos el estado por JID.
 *
 * En prod esto es suficiente para MVP — si el proceso se reinicia se pierden las
 * sesiones activas (máx 1-2 min de inconveniencia).
 */

export type SessionState =
  | { flow: "rpe_capture"; training_log_id: string }
  | { flow: "checkin_nutrition"; step: 1 }
  | { flow: "checkin_sleep"; step: 2; nutrition_ok: boolean }
  | { flow: "checkin_pain"; step: 3; nutrition_ok: boolean; sleep: number };

const store = new Map<string, SessionState>();

const TTL_MS = 10 * 60 * 1000; // 10 minutos sin respuesta → limpiar sesión
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
