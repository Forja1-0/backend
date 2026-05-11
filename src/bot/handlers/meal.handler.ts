import type { User } from "../../types/user.types.js";
import { parseMealText } from "../../services/gemini.service.js";
import * as foodRepo from "../../repositories/food.repo.js";
import * as mealRepo from "../../repositories/meal.repo.js";
import { sendText } from "../../services/evolution.service.js";
import { logger } from "../../config/logger.js";

/**
 * Procesa un mensaje de texto libre que describe una comida.
 * Retorna true si pudo parsear alimentos, false si Gemini dijo que no hay comida.
 */
export async function handleMealLog(
  user: User,
  text: string,
): Promise<boolean> {
  const jid = user.wa_chat_id!;

  // 1. Extraer ítems con Gemini
  const parsedItems = await parseMealText(text);

  // Si Gemini devuelve array vacío o null, no era una comida
  if (!parsedItems || parsedItems.length === 0) {
    return false;
  }

  try {
    // 2. Matchear con la BD y armar el log
    let totalKcal = 0;
    let totalProt = 0;
    let totalCarbs = 0;
    let totalFat = 0;
    let isEstimate = false;

    const finalItems = [];

    for (const item of parsedItems) {
      // Intentamos buscarlo en la BD SARA
      const matches = await foodRepo.searchFood(item.name, 1);
      const dbMatch = matches.length > 0 ? matches[0] : null;

      let kcal = item.kcal;
      let prot = item.protein_g;
      let carbs = item.carbs_g;
      let fat = item.fat_g;
      let dbId = null;

      if (dbMatch) {
        dbId = dbMatch.id;
        // Si no mandó gramos y tenemos porción estándar, la usamos
        const grams = item.grams > 0 ? item.grams : (dbMatch.standard_portion_g ?? 100);
        const factor = grams / 100;

        // Si tenemos el match exacto en BD, usamos los macros de la BD
        // porque SARA es la fuente de verdad.
        kcal = Math.round(dbMatch.kcal_per_100g * factor);
        prot = dbMatch.protein_per_100g * factor;
        carbs = dbMatch.carbs_per_100g * factor;
        fat = dbMatch.fat_per_100g * factor;
      } else {
        // No está en la BD, usamos la estimación de Gemini
        isEstimate = true;
      }

      if (item.is_estimate) isEstimate = true;

      totalKcal += kcal;
      totalProt += prot;
      totalCarbs += carbs;
      totalFat += fat;

      finalItems.push({
        ...item,
        kcal,
        protein_g: prot,
        carbs_g: carbs,
        fat_g: fat,
        food_item_id: dbId,
        matched_db_name: dbMatch?.name,
      });
    }

    // 3. Guardar en la BD
    await mealRepo.saveMealLog({
      user_id: user.id,
      input_mode: "descriptive",
      raw_input: text,
      parsed_items: finalItems,
      total_kcal: totalKcal,
      total_protein_g: totalProt,
      total_carbs_g: totalCarbs,
      total_fat_g: totalFat,
      is_estimate: isEstimate,
      confirmed: true, // Auto-confirmamos por ahora para no trabar el flujo
    });

    // 4. Armar el mensaje de respuesta
    const lines = ["✅ *Comida registrada*\n"];

    for (const fi of finalItems) {
      const name = fi.matched_db_name ? `_${fi.matched_db_name}_` : fi.name;
      const amount = fi.grams > 0 ? `${fi.grams}g` : "1 porción";
      lines.push(`• ${amount} de ${name} (${fi.kcal} kcal)`);
    }

    lines.push(
      `\n📊 *Totales:* ${Math.round(totalKcal)} kcal | ` +
        `P: ${Math.round(totalProt)}g | ` +
        `C: ${Math.round(totalCarbs)}g | ` +
        `G: ${Math.round(totalFat)}g`,
    );

    if (isEstimate) {
      lines.push("\n_(Valores estimados)_");
    }

    await sendText(jid, lines.join("\n"));
    return true;
  } catch (err) {
    logger.error("Error handling meal log", { err, text });
    await sendText(
      jid,
      "Oops, se me complicó procesar esa comida. ¿Podrías escribirla de otra forma?",
    );
    return true; // Devolvemos true para que no caiga en el fallback genérico
  }
}
