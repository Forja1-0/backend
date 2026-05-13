/**
 * Templates de mensajes del bot — UNICO lugar donde viven strings de cara al user.
 * Tono: argentino, cercano, directo, sin diminutivos infantiles. Coach que sabe.
 *
 * Para variar el mensaje (que no suene robot), las funciones usan `pick()`
 * que elige random de un set de variantes.
 */

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const firstName = (full: string | null): string =>
  full ? full.split(" ")[0] : "";

// ════════════════════════════════════════════════════════════
// GREETING / HELP / UNKNOWN
// ════════════════════════════════════════════════════════════

export function greeting(name: string | null): string {
  const n = firstName(name);
  return pick([
    `¡Hola${n ? " " + n : ""}! ¿Cómo va el día?`,
    `¡Qué hacés${n ? " " + n : ""}! Acá estoy.`,
    `Buenas${n ? " " + n : ""}. ¿En qué andás?`,
    `Hola${n ? " " + n : ""} 💪`,
  ]);
}

export function gratitude(): string {
  return pick([
    "Cuando quieras 💪",
    "De una.",
    "A mandar.",
    "Para eso estoy.",
  ]);
}

export function help(name: string | null): string {
  const n = firstName(name);
  return (
    `*¿Qué puedo hacer${n ? ", " + n : ""}?*\n\n` +
    `🥗 *Registrar comida*\n` +
    `   _Ej: "comí 200g de pollo y arroz", "desayuno 1"_\n\n` +
    `💪 *Registrar entrenamiento*\n` +
    `   _Ej: "completé piernas", "terminé el running"_\n\n` +
    `📊 *Consultar*\n` +
    `   _"cuánta prote me falta", "cómo voy esta semana"_\n\n` +
    `🤕 *Avisar lesión o desliz*\n` +
    `   _Te ayudo a ajustar el plan_\n\n` +
    `Hablame normal, yo me arreglo.`
  );
}

export function unknown(): string {
  return pick([
    "No te re entendí. ¿Me lo decís de otra forma?",
    "Mmm, no pude interpretar eso. Probá *ayuda* para ver qué puedo hacer.",
    "Se me escapó. ¿Podés ser un toque más específico?",
  ]);
}

export function nonText(): string {
  return "Por ahora solo proceso texto. Mandame en palabras lo que querés registrar.";
}

// ════════════════════════════════════════════════════════════
// TRAINING
// ════════════════════════════════════════════════════════════

export function trainingComplete(sessionName: string): string {
  return (
    `🔥 *${sessionName}* registrado.\n\n` +
    `¿Qué tan duro fue? Mandame un número del *1 al 10* (1 = paseo, 10 = al límite).`
  );
}

export function trainingDaySwapped(doneSession: string, todayPlanSession: string): string {
  return (
    `🔥 *${doneSession}* registrado.\n\n` +
    `_Ojo che, hoy en el plan tenías *${todayPlanSession}*. Si los cambiaste de orden está perfecto, sino acomodá la semana._\n\n` +
    `¿RPE? Tirame un número del *1 al 10*.`
  );
}

export function trainingNeedsNumber(): string {
  return "Mandame un número entre *1 y 10* para el esfuerzo (RPE).";
}

export function trainingRpeSaved(rpe: number): string {
  const emoji = rpe >= 8 ? "🔴" : rpe >= 5 ? "🟡" : "🟢";
  const tail =
    rpe >= 9 ? "Gran esfuerzo. Recuperá bien." :
    rpe >= 7 ? "Sesión exigente. Hidratate y dormí." :
    rpe >= 4 ? "Bien ahí. Constancia." :
    "Día liviano, perfecto para soltar.";
  return `${emoji} RPE *${rpe}/10* guardado. ${tail}`;
}

export function trainingSkip(): string {
  return pick([
    "Anotado. Hoy descansamos. Mañana retomamos.",
    "Tranqui. El descanso también entrena. Mañana le metemos.",
    "Está. Lo registro como día libre.",
  ]);
}

export function trainingQuery(session: { name: string | null; type: string; time: string | null }): string {
  const what = session.name ?? session.type;
  const when = session.time ? ` a las *${session.time.slice(0, 5)}*` : "";
  return `Hoy toca *${what}*${when}.`;
}

export function trainingQueryRest(): string {
  return "Hoy no tenés sesión programada. Día de descanso.";
}

// ════════════════════════════════════════════════════════════
// MEAL
// ════════════════════════════════════════════════════════════

export interface MealSummaryItem {
  name: string;
  grams: number;
  kcal: number;
  matched_db_name?: string | null;
}

export function mealRegistered(
  items: MealSummaryItem[],
  totals: { kcal: number; protein: number; carbs: number; fat: number },
  isEstimate: boolean,
): string {
  const lines = ["✅ *Registrado.*\n"];
  for (const it of items) {
    const nm = it.matched_db_name ?? it.name;
    const qty = it.grams > 0 ? `${it.grams}g de ` : "";
    lines.push(`• ${qty}${nm} (${it.kcal} kcal)`);
  }
  lines.push(
    `\n*Total:* ${Math.round(totals.kcal)} kcal · ` +
    `P ${Math.round(totals.protein)}g · ` +
    `C ${Math.round(totals.carbs)}g · ` +
    `G ${Math.round(totals.fat)}g`,
  );
  if (isEstimate) lines.push("\n_Valores estimados — si no es preciso, escribime *corregir*._");
  return lines.join("\n");
}

export function mealConfirmAsk(
  items: MealSummaryItem[],
  totals: { kcal: number; protein: number; carbs: number; fat: number },
): string {
  const lines = ["🤔 Detecté:\n"];
  for (const it of items) {
    const nm = it.matched_db_name ?? it.name;
    const qty = it.grams > 0 ? `${it.grams}g de ` : "";
    lines.push(`• ${qty}${nm}`);
  }
  lines.push(`\n~ *${Math.round(totals.kcal)} kcal* · P${Math.round(totals.protein)} C${Math.round(totals.carbs)} G${Math.round(totals.fat)}`);
  lines.push("\n¿Lo guardo así? Respondé *sí* o *corregir*.");
  return lines.join("\n");
}

export function mealConfirmCancelled(): string {
  return "Cancelado. Mandame de nuevo la comida como te quede más cómodo.";
}

export function mealFailed(): string {
  return "Se me complicó procesar esa comida. ¿La podés decir de otra forma o con cantidades?";
}

export function mealClarify(foodHint: string): string {
  return pick([
    `Dale. ¿Cuántos gramos de *${foodHint}*? ¿Qué tipo fue? ¿Comiste algo más?`,
    `Necesito un toque más de info. ¿Cuántos gramos de *${foodHint}* y qué tipo? Si comiste algo más, decímelo también.`,
    `Para registrarlo bien: ¿qué cantidad (en gramos) de *${foodHint}*, qué tipo, y si lo acompañaste con algo?`,
  ]);
}

export function mealRegisteredEstimated(
  items: MealSummaryItem[],
  totals: { kcal: number; protein: number; carbs: number; fat: number },
): string {
  const lines = ["✅ *Registrado* (con cantidad estimada).\n"];
  for (const it of items) {
    const nm = it.matched_db_name ?? it.name;
    const qty = it.grams > 0 ? `~${it.grams}g de ` : "";
    lines.push(`• ${qty}${nm} (${it.kcal} kcal)`);
  }
  lines.push(
    `\n*Total estimado:* ${Math.round(totals.kcal)} kcal · ` +
    `P ${Math.round(totals.protein)}g · ` +
    `C ${Math.round(totals.carbs)}g · ` +
    `G ${Math.round(totals.fat)}g`,
  );
  lines.push("\n_Si la cantidad no es precisa, escribime *corregir*._");
  return lines.join("\n");
}

// ════════════════════════════════════════════════════════════
// QUERIES
// ════════════════════════════════════════════════════════════

export function remainingMacros(r: {
  remaining_kcal: number;
  remaining_protein: number;
  remaining_carbs: number;
  remaining_fat: number;
}): string {
  const lines = ["📊 *Te queda hoy:*\n"];
  lines.push(`• ${Math.max(0, Math.round(r.remaining_kcal))} kcal`);
  lines.push(`• ${Math.max(0, Math.round(r.remaining_protein))}g proteína`);
  lines.push(`• ${Math.max(0, Math.round(r.remaining_carbs))}g carbos`);
  lines.push(`• ${Math.max(0, Math.round(r.remaining_fat))}g grasas`);
  return lines.join("\n");
}

export function nutritionNoPlan(): string {
  return "Todavía no tenés plan nutricional activo. Completá el onboarding o pedile a tu nutri que cargue los targets.";
}

// ════════════════════════════════════════════════════════════
// CHECKIN
// ════════════════════════════════════════════════════════════

export function checkinStart(name: string | null): string {
  const n = firstName(name);
  return `🌙 *Cierre del día${n ? ", " + n : ""}.*\n\n¿Cumpliste con la nutrición hoy? (*sí* / *no*)`;
}

export function checkinAskSleep(prevOk: boolean): string {
  const intro = prevOk ? "✅ Joya." : "Anotado. Mañana arrancamos limpios.";
  return `${intro}\n\n¿Cómo dormiste? Del *1 al 5* (1 = pésimo, 5 = perfecto).`;
}

export function checkinAskPain(): string {
  return "Última: ¿dolor o molestia hoy? Del *0 al 10* (0 = nada, 10 = muy fuerte).";
}

export function checkinNeedYesNo(): string {
  return "Respondé *sí* o *no*.";
}

export function checkinNeedNumberRange(min: number, max: number): string {
  return `Tirame un número del *${min} al ${max}*.`;
}

export function checkinFallback(): string {
  return "✅ Check-in guardado. Hasta mañana 💪";
}

// ════════════════════════════════════════════════════════════
// DISRUPTION
// ════════════════════════════════════════════════════════════

export function disruptionInjuryAck(): string {
  return (
    "Lamento eso. Lo registro y te ayudo a ajustar el plan.\n\n" +
    "Si querés contame: zona del cuerpo, intensidad (0-10) y si estás en tratamiento."
  );
}

export function disruptionIllnessAck(): string {
  return (
    "Anotado, cuidate. Suspendo recordatorios hasta que estés mejor.\n\n" +
    "Cuando te sientas para retomar mandame *listo*."
  );
}

export function disruptionDeslizAck(): string {
  return pick([
    "Pasa. Un día no te corre el plan. Mañana volvemos al ritmo.",
    "Anotado. La consistencia se mide en semanas, no en cenas.",
    "Está. Mañana retomamos. No es drama.",
  ]);
}

// ════════════════════════════════════════════════════════════
// COMMANDS
// ════════════════════════════════════════════════════════════

export function bajaConfirm(): string {
  return (
    "¿Seguro querés darte de baja? Esto desactiva tu cuenta y deja de mandarte recordatorios.\n\n" +
    "Respondé *confirmar baja* para proceder, o cualquier otra cosa para cancelar."
  );
}

export function bajaDone(): string {
  return "Listo, te di de baja. Si querés volver, escribíme cuando quieras.";
}

export function profile(u: {
  name: string | null;
  age: number | null;
  weight_kg: number | null;
  height_cm: number | null;
}): string {
  return (
    `*Tu perfil:*\n` +
    `• Nombre: ${u.name ?? "—"}\n` +
    `• Edad: ${u.age ?? "—"}\n` +
    `• Peso: ${u.weight_kg ? u.weight_kg + " kg" : "—"}\n` +
    `• Altura: ${u.height_cm ? u.height_cm + " cm" : "—"}`
  );
}
