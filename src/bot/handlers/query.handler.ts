import type { User } from "../../types/user.types.js";
import { query } from "../../config/db.js";
import { sendText } from "../../services/evolution.service.js";
import * as T from "../personality/templates.js";

/**
 * "Cuanta prote me falta", "cuantas kcal llevo", "macros del dia".
 * Lee de la vista v_daily_remaining (definida en schema.sql).
 */
export async function handleNutritionQuery(user: User): Promise<void> {
  const jid = user.wa_chat_id!;
  const { rows } = await query<{
    target_kcal: number | null;
    remaining_kcal: number;
    remaining_protein: number;
    remaining_carbs: number;
    remaining_fat: number;
  }>(
    `SELECT target_kcal, remaining_kcal, remaining_protein, remaining_carbs, remaining_fat
     FROM v_daily_remaining WHERE user_id = $1 LIMIT 1`,
    [user.id],
  );
  const r = rows[0];
  if (!r || r.target_kcal === null) {
    await sendText(jid, T.nutritionNoPlan());
    return;
  }
  await sendText(jid, T.remainingMacros(r));
}

/**
 * Stub para "como voy esta semana", "mi score" — sumariza los ultimos 7 dias.
 */
export async function handleProgressQuery(user: User): Promise<void> {
  const jid = user.wa_chat_id!;
  const { rows } = await query<{
    avg_score: number | null;
    days_logged: number;
    training_days: number;
  }>(
    `SELECT
       AVG(performance_score)::INT     AS avg_score,
       COUNT(*)::INT                    AS days_logged,
       SUM(CASE WHEN training_completed THEN 1 ELSE 0 END)::INT AS training_days
     FROM daily_summaries
     WHERE user_id = $1
       AND summary_date >= CURRENT_DATE - INTERVAL '7 days'`,
    [user.id],
  );
  const r = rows[0];
  if (!r || r.days_logged === 0) {
    await sendText(jid, "Todavía no tengo datos de esta semana. Cargá tus comidas y entrenamientos y la próxima te respondo con números.");
    return;
  }
  await sendText(
    jid,
    `📈 *Últimos 7 días*\n\n` +
      `• Score promedio: *${r.avg_score ?? "—"}/100*\n` +
      `• Días con registro: ${r.days_logged}/7\n` +
      `• Entrenamientos: ${r.training_days}`,
  );
}
