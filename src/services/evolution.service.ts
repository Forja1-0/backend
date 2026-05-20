import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { logBotEvent, EventTypes } from "./events.service.js";

const base = env.EVOLUTION_API_URL.replace(/\/$/, "");
const instance = env.EVOLUTION_INSTANCE;

async function evoFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const url = `${base}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: env.EVOLUTION_API_KEY,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    logger.error("evolution api error", { url, status: res.status, body: text });
    throw new Error(`evolution ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Manda texto al usuario por WhatsApp. Loguea `wa.message_sent` en
 * `system_events` para que cada salida del bot quede registrada con
 * jid, longitud, y (si el caller lo pasa) la categoria semantica
 * (meal_registered, training_complete, checkin_ask_sleep, etc.) y el
 * user_id. La categoria sirve para slicear analytics sin parsear texto.
 */
export interface SendTextMeta {
  userId?: string | null;
  category?: string;
  extra?: Record<string, unknown>;
}

export async function sendText(
  jid: string,
  text: string,
  meta: SendTextMeta = {},
): Promise<void> {
  await evoFetch(`/message/sendText/${instance}`, {
    method: "POST",
    body: JSON.stringify({ number: jid, text }),
  });
  logBotEvent(meta.userId ?? null, EventTypes.WA_MESSAGE_SENT, {
    jid,
    length: text.length,
    category: meta.category ?? null,
    ...(meta.extra ?? {}),
  });
}

export async function getInstanceStatus(): Promise<unknown> {
  return evoFetch(`/instance/connectionState/${instance}`);
}
