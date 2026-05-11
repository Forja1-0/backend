import type { User } from "../../types/user.types.js";
import { sendText } from "../../services/evolution.service.js";
import * as T from "../personality/templates.js";

export async function handleGreeting(user: User): Promise<void> {
  await sendText(user.wa_chat_id!, T.greeting(user.name));
}

export async function handleGratitude(user: User): Promise<void> {
  await sendText(user.wa_chat_id!, T.gratitude());
}

export async function handleUnknown(user: User): Promise<void> {
  await sendText(user.wa_chat_id!, T.unknown());
}

export async function handleNonText(user: User): Promise<void> {
  await sendText(user.wa_chat_id!, T.nonText());
}
