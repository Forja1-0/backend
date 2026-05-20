import type { User } from "../../types/user.types.js";
import { sendText } from "../../services/evolution.service.js";
import { logBotEvent, EventTypes } from "../../services/events.service.js";
import * as T from "../personality/templates.js";

export async function handleGreeting(user: User): Promise<void> {
  logBotEvent(user.id, EventTypes.GREETING, { jid: user.wa_chat_id });
  await sendText(user.wa_chat_id!, T.greeting(user.name), {
    userId: user.id,
    category: "greeting",
  });
}

export async function handleGratitude(user: User): Promise<void> {
  logBotEvent(user.id, EventTypes.GRATITUDE, { jid: user.wa_chat_id });
  await sendText(user.wa_chat_id!, T.gratitude(), {
    userId: user.id,
    category: "gratitude",
  });
}

export async function handleUnknown(user: User): Promise<void> {
  logBotEvent(user.id, EventTypes.WA_UNKNOWN, { jid: user.wa_chat_id });
  await sendText(user.wa_chat_id!, T.unknown(), {
    userId: user.id,
    category: "unknown",
  });
}

export async function handleNonText(user: User): Promise<void> {
  logBotEvent(user.id, EventTypes.NON_TEXT, { jid: user.wa_chat_id });
  await sendText(user.wa_chat_id!, T.nonText(), {
    userId: user.id,
    category: "non_text",
  });
}
