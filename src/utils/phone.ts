// JID de WhatsApp: "549XXXXXXXXXX@s.whatsapp.net"
// phone_wa: numero limpio sin "+", ej "5491155551234"

export function jidToPhone(jid: string): string {
  return jid.split("@")[0].replace(/\D/g, "");
}

export function phoneToJid(phone: string): string {
  const clean = phone.replace(/\D/g, "");
  return `${clean}@s.whatsapp.net`;
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}
