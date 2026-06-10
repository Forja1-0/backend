/**
 * Templates de mensajes del bot — UNICO lugar donde viven strings de cara al user.
 * Tono: argentino, cercano, directo, sin diminutivos infantiles. Coach que sabe.
 *
 * Para variar el mensaje (que no suene robot), las funciones usan `pick()`
 * que elige random de un set de variantes.
 */

import type {
  CoachAssessment,
  FoodSuggestion,
  MacroKey,
  RecoMacro,
} from "./coach.js";

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

// ════════════════════════════════════════════════════════════
// PESO CORPORAL (modo amateur — señal de progreso)
// ════════════════════════════════════════════════════════════

/** Pregunta semanal del cron de peso. */
export function weightAsk(name: string | null): string {
  const n = firstName(name);
  return pick([
    `¿Cuánto pesás esta semana${n ? ", " + n : ""}? Subite a la balanza y mandame el número (ej: 82.5).`,
    `Momento balanza${n ? ", " + n : ""} 📏. Pesate y mandame el número — así veo cómo venís.`,
    `¿Te pesaste esta semana${n ? ", " + n : ""}? Pasame el dato en kg y lo registro.`,
  ]);
}

/** Pide el número cuando no se entendió el peso. */
export function weightNeedNumber(): string {
  return pick([
    "Mandame solo el número en kg, ej: *82.5* o *peso 82.5*.",
    "No te agarré el número. Tirámelo en kg, tipo *81* o *81.4*.",
  ]);
}

/**
 * Confirmación tras registrar peso + lectura de tendencia.
 *  - deltaFromPrevious: kg vs el registro anterior (negativo = bajó).
 *  - deltaFromFirst: kg desde el arranque.
 */
export function weightRegistered(
  kg: number,
  trend: { deltaFromPrevious: number | null; deltaFromFirst: number; count: number },
): string {
  const head = pick([
    `Anotado: *${kg} kg*.`,
    `Listo, *${kg} kg* registrado.`,
    `Quedó: *${kg} kg*.`,
  ]);

  // Primer registro real (count<=1 o sin anterior): sin tendencia todavía.
  if (trend.count <= 1 || trend.deltaFromPrevious == null) {
    return `${head} Es tu punto de partida — desde acá medimos. 💪`;
  }

  const dPrev = trend.deltaFromPrevious;
  const dFirst = trend.deltaFromFirst;
  const absFirst = Math.abs(dFirst).toFixed(1).replace(/\.0$/, "");

  let line: string;
  if (dPrev < 0) {
    line = pick([`Vas para abajo 👇`, `Seguís bajando, bien ahí.`, `Menos que la vez pasada. Así se hace.`]);
  } else if (dPrev > 0) {
    line = pick([`Subió un toque — pasa, mirá la tendencia, no el día.`, `Arriba de la última, nada grave. Lo importante es el promedio.`]);
  } else {
    line = `Igual que la última. Estable.`;
  }

  const since =
    dFirst < 0 ? ` Desde que arrancaste: *-${absFirst} kg*.`
    : dFirst > 0 ? ` Desde que arrancaste: *+${absFirst} kg*.`
    : "";

  return `${head} ${line}${since}`;
}

export function help(name: string | null, amateur = false): string {
  const n = firstName(name);
  if (amateur) {
    return (
      `*¿Cómo me usás${n ? ", " + n : ""}?*\n\n` +
      `Hablame natural por acá y yo llevo la cuenta. No hay formularios ni comandos rígidos.\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `💬 *LO QUE ME PODÉS DECIR*\n\n` +
      `🥗 *Qué comiste*\n` +
      `   _"comí 200g de pollo y arroz"_, _"dos medialunas y un café"_\n` +
      `   Estimo las calorías y los macros. Si la estimación no te cierra, escribime *corregir* y lo rehacemos.\n\n` +
      `⚖️ *Tu peso*\n` +
      `   _"peso 82"_, _"hoy me pesé 79.5"_\n` +
      `   Lo registro y te muestro la tendencia (que es lo que importa, no el número de un día).\n\n` +
      `💪 *Si entrenaste*\n` +
      `   _"hoy fui al gym"_, _"entrené piernas"_\n\n` +
      `📊 *Consultar*\n` +
      `   _"cuánto me queda hoy?"_, _"cómo vengo?"_, _"mi perfil"_\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🎯 *EL NÚMERO QUE USO*\n` +
      `Calculo un objetivo de calorías *estimado* a partir de tu peso, altura, edad y qué tan seguido entrenás. Es una guía para orientarte — *no reemplaza a un nutricionista*. Cada vez que registrás tu peso, lo recalculo.\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🔧 Cambió algo → decímelo (_"ahora peso 78"_). Baja → escribime *baja*.\n\n` +
      `Hablame como a un amigo que sabe del tema. 💪`
    );
  }
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
export function welcome(name: string | null, amateur = false): string {
  const n = firstName(name);
  if (amateur) {
    return (
      `🟢 *Bienvenido${n ? ", " + n : ""}.*\n` +
      `Soy *Forja*. Desde acá te ayudo a comer mejor y moverte más, sin complicarte.\n\n` +
      `💬 *Hablame natural cuando pase algo:*\n` +
      `_"comí 200g de pollo"_ → estimo calorías y macros\n` +
      `_"peso 82"_ → registro tu peso y la tendencia\n` +
      `_"hoy fui al gym"_ → lo anoto\n` +
      `_"cuánto me queda hoy?"_ → te oriento\n\n` +
      `🎯 Calculo un objetivo de calorías *estimado* para tu meta (es una guía, no reemplaza a un nutri). Lo ajusto solo a medida que cambia tu peso.\n\n` +
      `Si te perdés, escribime *ayuda*.\n` +
      `Arrancamos. 💪`
    );
  }
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

export function trainingQueryRest(amateur = false): string {
  if (amateur) {
    return "No tenés un plan de entrenos cargado — entrenás libre. Cuando vayas al gym, avisame con _\"fui al gym\"_ y lo registro. 💪";
  }
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
const n1 = (x: number): string => (Math.round(x * 10) / 10).toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

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

// Flujo "corregir": borramos de verdad el último registro y pedimos la versión
// nueva (antes la corrección contaba doble). Mostramos qué se borró para que sea
// transparente.
export function correctionDeleted(rawInput: string, kcal: number): string {
  const label = rawInput.trim().replace(/\s+/g, " ").slice(0, 60);
  return [
    `🧽 Listo, borré tu último registro de hoy:`,
    `_“${label}” (${n0(kcal)} kcal)_`,
    "",
    "Mandame la versión corregida y la anoto de nuevo. 👍",
  ].join("\n");
}

export function correctionNothingToFix(): string {
  return "No encuentro un registro de hoy para corregir 🤔 Si querés anotar una comida, mandámela y la registro.";
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

function cleanFoodName(name: string): string {
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
  return capitalized
    .replace(/-\s*$/, "")              // trailing hyphen
    .replace(/\s*\([^)]*$/, "")        // open paren never closed
    .replace(/^[^A-ZÁÉÍÓÚÜÑ]+/, "")    // leading lowercase fragment
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

export function nutritionNoPlan(amateur = false): string {
  if (amateur) {
    return "Todavía estoy armando tu objetivo estimado. Registrá tu peso (_\"peso 80\"_) o una comida y lo activo para mostrarte cuánto te queda.";
  }
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

function headlineLine(a: CoachAssessment, amateur = false): string {
  if (amateur) {
    // El target amateur es una ESTIMACIÓN, no una prescripción: nada de rojo de
    // reproche ni "el plan". Tono orientativo.
    switch (a.headline) {
      case "over":
        return "🟡 *Vas un poco por encima de tu estimado de hoy.*";
      case "tight":
        return "🟡 *Te queda poco margen del estimado.*";
      default:
        return "🟢 *Vas bien para tu estimado de hoy.*";
    }
  }
  switch (a.headline) {
    case "over":
      return "🔴 *Te pasaste del plan hoy.*";
    case "tight":
      return "🟡 *Vas justo* — ojo con lo que queda.";
    default:
      return "🟢 *Vas en línea con el plan.*";
  }
}

function remainingBlock(a: CoachAssessment, amateur = false): string {
  const m = a.macros;
  return [
    amateur ? "📊 *Estimado, te queda hoy:*" : "📊 *Te queda hoy:*",
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

/** Recomendación de comida para cerrar el macro más atrasado (coach v2). */
export interface CoachReco {
  macro: RecoMacro;
  remaining: number;
  suggestions: FoodSuggestion[];
}

function suggestionChunk(s: FoodSuggestion): string {
  const hint = s.portionHint ? ` (${s.portionHint})` : "";
  return `*${n0(s.grams)}g de ${cleanFoodName(s.name)}*${hint}`;
}

function recoLine(reco: CoachReco): string | null {
  if (reco.suggestions.length === 0) return null;
  const label = MACRO_LABEL[reco.macro];
  const [first, second] = reco.suggestions;
  const head = first.closesGap
    ? `💡 Te faltan *~${n0(reco.remaining)}g de ${label}*. Lo cerrás con ${suggestionChunk(first)}`
    : `💡 Te faltan *~${n0(reco.remaining)}g de ${label}*. Te acerca ${suggestionChunk(first)} _(+${n0(first.addsMacro)}g)_`;
  const alt = second ? ` — o ${suggestionChunk(second)}.` : ".";
  return head + alt;
}

/** Reporte standalone para la consulta "macros" / "cuánta prote me falta". */
export function coachReport(a: CoachAssessment, reco?: CoachReco | null, amateur = false): string {
  const parts = [headlineLine(a, amateur), "", remainingBlock(a, amateur)];
  const alerts = alertLines(a);
  if (alerts.length) parts.push("", ...alerts);
  const rec = reco ? recoLine(reco) : null;
  if (rec) parts.push("", rec);
  return parts.join("\n");
}

/** Bloque que se adjunta al "✅ Registrado" tras cada comida. */
export function coachAfterMeal(a: CoachAssessment, reco?: CoachReco | null, amateur = false): string {
  return `\n━━━━━━━━━━━━━━━\n${coachReport(a, reco, amateur)}`;
}

/**
 * "Cómo voy?" en modo amateur. La señal NO es un score de adherencia (eso es
 * elite) sino la TENDENCIA de peso + la consistencia del hábito. Lideramos con
 * peso; si todavía no se pesó, lo invitamos. Nunca inventamos un "/100".
 */
export interface ProgressAmateurView {
  weight: { first: number; latest: number; deltaFromFirst: number; count: number } | null;
  daysLogged: number;
  trainingDays: number;
}
export function progressReportAmateur(v: ProgressAmateurView): string {
  const parts: string[] = ["📈 *Cómo venís*", ""];

  if (v.weight && v.weight.count >= 2) {
    const d = v.weight.deltaFromFirst;
    const verb = d < 0 ? "Bajaste" : d > 0 ? "Subiste" : "Te mantuviste en";
    const mag = d === 0 ? `${n1(v.weight.latest)} kg` : `*${n1(Math.abs(d))} kg*`;
    parts.push(
      `⚖️ ${verb} ${mag} desde que arrancaste _(${n1(v.weight.first)} → ${n1(v.weight.latest)} kg, ${v.weight.count} pesadas)_.`,
    );
  } else if (v.weight && v.weight.count === 1) {
    parts.push(`⚖️ Tenés tu primer peso anotado (${n1(v.weight.latest)} kg). Con la próxima pesada te muestro la tendencia.`);
  } else {
    parts.push(`⚖️ Todavía no registraste tu peso. Mandame _"peso 80"_ y empiezo a seguir tu tendencia (es la señal que más importa).`);
  }

  parts.push(`📝 Registros esta semana: *${v.daysLogged}/7 días*`);
  if (v.trainingDays > 0) parts.push(`💪 Entrenamientos: *${v.trainingDays}*`);

  parts.push("", "_La constancia es lo que mueve la aguja. Seguí así._ 💪");
  return parts.join("\n");
}

/**
 * Línea motivadora corta que SE APPENDEA de vez en cuando al "Registrado",
 * conectando con la meta o celebrando un hito de racha. Devuelve null cuando no
 * hay nada para decir. El ejemplo de Pedro: "cada día más cerca de esos 80kg".
 */
export interface RegistrationNudgeGoal {
  goal_kind: string | null;
  goal_metric_value: number | null;
  goal_metric_unit: string | null;
  goal_metric_label: string | null;
}
const STREAK_MILESTONES = new Set([2, 3, 5, 7, 10, 14, 21, 30, 50, 100]);
export function registrationMotivationLine(
  goal: RegistrationNudgeGoal | null,
  dayStreak: number,
): string | null {
  // 1) Hito de racha: lo más fuerte, tiene prioridad.
  if (STREAK_MILESTONES.has(dayStreak)) {
    return pick([
      `🔥 *${dayStreak} días seguidos* reportando. Así se construye — seguí para tu meta.`,
      `🔥 Llevás *${dayStreak} días seguidos*. La constancia es exactamente lo que te lleva a tu objetivo.`,
    ]);
  }
  // 2) Conexión con la meta (si hay un número de meta).
  if (goal && goal.goal_metric_value != null && goal.goal_metric_unit) {
    const target = `${n0(goal.goal_metric_value)}${goal.goal_metric_unit}`;
    return pick([
      `Cada registro te acerca a esos *${target}* tan deseados. Seguí así que va a llegar. 💪`,
      `Un paso más hacia tus *${target}*. Cada día te acercás. 💪`,
      `Esto suma para tu meta de *${target}*. Vamos que se puede.`,
    ]);
  }
  if (goal && goal.goal_metric_label) {
    return `Cada registro te acerca a tu meta: *${goal.goal_metric_label}*. Seguí así. 💪`;
  }
  return null;
}

// ════════════════════════════════════════════════════════════
// CHECKIN
// ════════════════════════════════════════════════════════════

export function checkinStart(name: string | null, amateur = false): string {
  const n = firstName(name);
  // Amateur: el target es un estimado, no un plan que se "cumple". Preguntamos
  // por cómo le fue, no por adherencia binaria a una prescripción.
  const q = amateur
    ? "¿Cómo venís con la comida hoy? ¿La llevaste bien? (*sí* / *no*)"
    : "¿Cumpliste con la nutrición hoy? (*sí* / *no*)";
  return `🌙 *Cierre del día${n ? ", " + n : ""}.*\n\n${q}`;
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
}, link: string): string {
  const n = firstName(u.name);
  return (
    `*Tu perfil${n ? ", " + n : ""}:*\n` +
    `• Nombre: ${u.name ?? "—"}\n` +
    `• Edad: ${u.age ?? "—"}\n` +
    `• Peso: ${u.weight_kg ? u.weight_kg + " kg" : "—"}\n` +
    `• Altura: ${u.height_cm ? u.height_cm + " cm" : "—"}\n\n` +
    `🔗 *Centro de control* — tocá acá para abrir tu perfil completo:\n` +
    `${link}\n\n` +
    `_El link vale por 15 minutos. Si se vence, escribime *perfil* de nuevo y te genero uno nuevo._`
  );
}
