// Subset del payload de Evolution v2 para event "messages.upsert".
export interface EvolutionWebhookEvent {
  event: string;
  instance: string;
  data: EvolutionMessage;
  destination?: string;
  date_time?: string;
  sender?: string;
  server_url?: string;
  apikey?: string;
}

export interface EvolutionMessage {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
    participant?: string;
  };
  pushName?: string;
  message?: EvolutionMessageContent;
  messageType?: string;
  messageTimestamp?: number | string;
  instanceId?: string;
}

export interface EvolutionMessageContent {
  conversation?: string;
  extendedTextMessage?: { text: string };
  imageMessage?: { caption?: string; mimetype?: string };
  audioMessage?: { mimetype?: string; seconds?: number };
  documentMessage?: { caption?: string; mimetype?: string; fileName?: string };
}

export function extractText(msg: EvolutionMessage): string | null {
  const c = msg.message;
  if (!c) return null;
  return (
    c.conversation ??
    c.extendedTextMessage?.text ??
    c.imageMessage?.caption ??
    c.documentMessage?.caption ??
    null
  );
}
