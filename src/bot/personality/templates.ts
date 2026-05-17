/**
 * Templates de mensajes del bot — UNICO lugar donde viven strings de cara al user.
 * Tono: argentino, cercano, directo, sin diminutivos infantiles. Coach que sabe.
 *
 * Para variar el mensaje (que no suene robot), las funciones usan `pick()`
 * que elige random de un set de variantes.
 */

import type { CoachAssessment, MacroKey } from "./coach.js";

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
    `*¿Cómo me usás${n ? ", " + n : ""}?*\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🧠 *LO QUE YA SÉ DE VOS*\n` +
    `Tengo tu perfil completo del onboarding: objetivo, plan de entrenos con horarios, targets de kcal y macros, restricciones, lesiones, comidas frecuentes. *No tenés que recargar nada.*\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `💬 *LO QUE ME PODÉS DECIR*\n\n` +
    `🥗 *Registrar comida*\n` +
    `   _"comí 200g de pollo y arroz"_\n` +
    `   _"desayuno 1" (si la cargaste como frecuente)_\n\n` +
    `💪 *Registrar entrenamiento*\n` +
    `   _"completé piernas", "listo el gym"_\n` +
    `   Te pregunto el RPE (1 a 10). Respondé con el número.\n\n` +
    `⏭️ *Saltear o cambiar*\n` +
    `   _"hoy no entreno", "me salto"_\n\n` +
    `📊 *Consultar*\n` +
    `   _"qué me toca hoy?"_\n` +
    `   _"cuánta prote me falta?"_\n` +
    `   _"cómo voy esta semana?"_\n` +
    `   _"mi perfil"_\n\n` +
    `🤕 *Lesión / enfermedad / desliz*\n` +
    `   _"me lesioné la rodilla"_, _"estoy enfermo"_, _"me comí 3 hamburguesas"_\n` +
    `   Ajusto el plan o suspendo recordatorios.\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🔔 *LO QUE HAGO SOLO*\n\n` +
    `• *Recordatorio matutino* (lun a sáb, 6 AM) con la sesión del día — *no me tenés que avisar cuándo entrenás, ya lo sé*\n` +
    `• *Check-in nocturno* — nutrición, sueño, dolor\n` +
    `• *Resumen semanal* los domingos\n` +
    `• Respeto los protocolos de rehab y alertas que cargó tu coach\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🔧 *RECONFIGURAR*\n` +
    `Plan nuevo del coach → subilo de nuevo en el perfil.\n` +
    `Cambio puntual → decímelo (_"ahora peso 78"_, _"ya no como gluten"_).\n` +
    `Baja → escribime *baja*.\n\n` +
    `Hablame natural. No hay comandos rígidos.`
  );
}

/**
 * Mensaje de bienvenida que se manda automaticamente cuando el usuario termina
 * el onboarding (POST /consent). Es el "tutorial" inicial del bot. Mas corto
 * que help() porque va sin pedirlo y queremos no abrumar.
 */
export function welcome(name: string | null): string {
  const n = firstName(name);
  return (
    `🟢 *Bienvenido${n ? ", " + n : ""}.*\n` +
    `Soy *Forja*. Desde acá entrenamos juntos todos los días.\n\n` +
    `🧠 *Ya tengo todo:* tu objetivo, tu plan de entrenos con horarios, tus targets de kcal/macros, tus restricciones y tus comidas frecuentes. No tenés que recargar nada.\n\n` +
    `🔔 *Yo me encargo de avisarte:*\n` +
    `• Cada mañana (lun a sáb, 6 AM) te paso qué te toca y a qué hora\n` +
    `• A la noche te hago un check-in rápido (nutri, sueño, dolor)\n` +
    `• Los domingos, resumen semanal\n\n` +
    `💬 *Vos me hablás natural cuando pase algo:*\n` +
    `_"comí 200g de pollo"_ → registro macros\n` +
    `_"completé piernas"_ → te pido RPE\n` +
    `_"qué me toca hoy?"_ → te digo la sesión\n` +
    `_"me lesioné la rodilla"_ → ajusto el plan\n` +
    `_"hoy no entreno"_ → anoto y mañana retomamos\n\n` +
    `No hay comandos rígidos. Hablame como a un coach.\n` +
    `Si te perdés, escribime *ayuda* y te paso el menú completo.\n\n` +
    `Empezamos. 💪`
  );
}

export function unknown(): string {
  return pick([
    "No te re entendí. ¿Me lo decís de otra forma? Probá *ayuda* para ver qué puedo hacer.",
    "Mmm, no pude interpretar eso. Probá *ayuda* para ver qué puedo hacer.",
    "Se me escapó. ¿Podés ser un toque más específico? Probá *ayuda* para ver qué puedo hacer.",
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
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  matched_db_name?: string | null;
  note?: string | null;
  state?: "crudo" | "cocido" | null;
}

/** Entero con separador de miles es-AR ("1239" → "1.239"). */
const n0 = (x: number): string => Math.round(x).toLocaleString("es-AR");

function itemLine(it: MealSummaryItem): string {
  const nm = cleanFoodName(it.matched_db_name ?? it.name);
  const st = it.state ? ` (${it.state})` : "";
  const qty = it.grams > 0 ? `${n0(it.grams)}g de ` : "";
  const head = `• ${qty}${nm}${st} → ${n0(it.kcal)} kcal`;
  const macro =
    it.protein_g != null && it.carbs_g != null && it.fat_g != null
      ? ` · P ${n0(it.protein_g)}g · C ${n0(it.carbs_g)}g · G ${n0(it.fat_g)}g`
      : "";
  const note = it.note ? `\n  _${it.note}_` : "";
  return head + macro + note;
}

function totalLine(t: { kcal: number; protein: number; carbs: number; fat: number }): string {
  return (
    `\n*Total:* ${n0(t.kcal)} kcal · ` +
    `P ${n0(t.protein)}g · C ${n0(t.carbs)}g · G ${n0(t.fat)}g`
  );
}

export function mealRegistered(
  items: MealSummaryItem[],
  totals: { kcal: number; protein: number; carbs: number; fat: number },
  isEstimate: boolean,
): string {
  const lines = ["✅ *Registrado.*\n", ...items.map(itemLine), totalLine(totals)];
  if (isEstimate) lines.push("\n_Valores estimados — si no es preciso, escribime *corregir*._");
  return lines.join("\n");
}

export function mealConfirmAsk(
  items: MealSummaryItem[],
  totals: { kcal: number; protein: number; carbs: number; fat: number },
): string {
  return [
    "🍽 Detecté:\n",
    ...items.map(itemLine),
    totalLine(totals),
    "\n¿Lo guardo así? Respondé *sí* o *corregir*.",
  ].join("\n");
}

export interface StateClarifyView {
  food_label: string;
  grams: number;
  crudo: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  cocido: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
}

export function mealStateClarify(c: StateClarifyView): string {
  const macro = (m: { kcal: number; protein_g: number; carbs_g: number; fat_g: number }) =>
    `${n0(m.kcal)} kcal · P ${n0(m.protein_g)}g · C ${n0(m.carbs_g)}g · G ${n0(m.fat_g)}g`;
  return [
    `🤔 *${n0(c.grams)}g de ${c.food_label}* — ¿lo comiste *crudo* o ya *cocido*?`,
    "",
    `• Si crudo: ${macro(c.crudo)}`,
    `• Si cocido: ${macro(c.cocido)}`,
    "",
    'Respondé "crudo" o "cocido".',
  ].join("\n");
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

/** Limpia nombres SARA2 para mostrar al usuario (quita truncados, paréntesis rotos, etc). */
function cleanFoodName(name: string): string {
  return name
    .replace(/-\s*$/, "")              // trailing hyphen
    .replace(/\s*\([^)]*$/, "")        // open paren never closed
    .replace(/^[^A-ZÁÉÍÓÚÜ]+/, "")     // leading lowercase fragment
    .replace(/\s{2,}/g, " ")           // double spaces
    .trim() || name.trim();
}

export function mealFoodClarify(foodLabel: string, options: { name: string }[]): string {
  const lines = [`🤔 *¿Qué tipo de ${foodLabel}?*\n`];
  options.forEach((o, i) => {
    lines.push(`  *${i + 1}.* ${cleanFoodName(o.name)}`);
  });
  lines.push(`\nRespondé con el *número*.`);
  return lines.join("\n");
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

export function nutritionNoPlan(): string {
  return "Todavía no tenés plan nutricional activo. Completá el onboarding o pedile a tu nutri que cargue los targets.";
}

// ════════════════════════════════════════════════════════════
// COACH — feedback determinístico tras cada comida / consulta
// ════════════════════════════════════════════════════════════

const MACRO_LABEL: Record<MacroKey, string> = {
  kcal: "kcal",
  protein: "proteína",
  carbs: "carbos",
  fat: "grasas",
};

/** "120g" para macros en gramos, "120 kcal" para energía. */
function macroAmount(key: MacroKey, value: number): string {
  return key === "kcal" ? `${n0(value)} kcal` : `${n0(value)}g`;
}

function headlineLine(a: CoachAssessment): string {
  switch (a.headline) {
    case "over":
      return "🔴 *Te pasaste del plan hoy.*";
    case "tight":
      return "🟡 *Vas justo* — ojo con lo que queda.";
    default:
      return "🟢 *Vas en línea con el plan.*";
  }
}

function remainingBlock(a: CoachAssessment): string {
  const m = a.macros;
  return [
    "📊 *Te queda hoy:*",
    `• ${macroAmount("kcal", m.kcal.remaining)}`,
    `• ${n0(m.protein.remaining)}g proteína`,
    `• ${n0(m.carbs.remaining)}g carbos`,
    `• ${n0(m.fat.remaining)}g grasas`,
  ].join("\n");
}

function alertLines(a: CoachAssessment): string[] {
  const out: string[] = [];
  for (const key of ["kcal", "protein", "carbs", "fat"] as MacroKey[]) {
    const m = a.macros[key];
    if (m.status === "over") {
      out.push(
        key === "kcal"
          ? `⚠️ Te pasaste *${macroAmount(key, m.overBy)}* del objetivo.`
          : `⚠️ Te pasaste *${macroAmount(key, m.overBy)}* de ${MACRO_LABEL[key]}.`,
      );
    } else if (m.status === "low") {
      out.push(
        key === "kcal"
          ? `🟡 Te quedan pocas calorías (*${macroAmount(key, m.remaining)}*).`
          : `🟡 Te queda poco margen de ${MACRO_LABEL[key]} (*${macroAmount(key, m.remaining)}*).`,
      );
    }
  }
  if (a.earlyAlert) {
    const label = a.earlyAlert.key === "kcal" ? "las kcal" : "la proteína";
    const pct = Math.round(a.earlyAlert.pctConsumed * 100);
    out.push(
      `⏰ Son las ${a.earlyAlert.hour}h y ya vas por el *${pct}%* de ${label} del día. ` +
        `Aflojá con el resto de las comidas o te vas a pasar.`,
    );
  }
  return out;
}

/** Reporte standalone para la consulta "macros" / "cuánta prote me falta". */
export function coachReport(a: CoachAssessment): string {
  const parts = [headlineLine(a), "", remainingBlock(a)];
  const alerts = alertLines(a);
  if (alerts.length) parts.push("", ...alerts);
  return parts.join("\n");
}

/** Bloque que se adjunta al "✅ Registrado" tras cada comida. */
export function coachAfterMeal(a: CoachAssessment): string {
  return `\n━━━━━━━━━━━━━━━\n${coachReport(a)}`;
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
