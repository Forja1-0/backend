import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

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
    logger.error({ url, status: res.status, body: text }, "evolution api error");
    throw new Error(`evolution ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function sendText(jid: string, text: string): Promise<void> {
  await evoFetch(`/message/sendText/${instance}`, {
    method: "POST",
    body: JSON.stringify({ number: jid, text }),
  });
}

export async function getInstanceStatus(): Promise<unknown> {
  return evoFetch(`/instance/connectionState/${instance}`);
}
