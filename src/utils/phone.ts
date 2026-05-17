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

// Clave nacional para matchear el MISMO numero escrito en formatos distintos.
// El onboarding suele guardar "2645267544" (cod area + abonado, 10 digitos);
// WhatsApp/Evolution manda "5492645267544" (54 + 9 movil + nacional).
// Ambos colapsan a los ultimos 10 digitos del numero nacional argentino.
export function arPhoneKey(raw: string): string {
  let d = (raw || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);          // prefijo internacional
  if (d.startsWith("54")) d = d.slice(2);          // codigo de pais
  if (d.length > 10 && d.startsWith("9")) d = d.slice(1); // prefijo movil
  if (d.startsWith("0")) d = d.slice(1);           // prefijo interurbano
  return d.slice(-10);
}

// Forma canonica para guardar/enviar por WhatsApp: 549 + nacional(10).
export function normalizeArPhone(raw: string): string {
  return `549${arPhoneKey(raw)}`;
}
