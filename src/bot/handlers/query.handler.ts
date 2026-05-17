import type { User } from "../../types/user.types.js";
import { query } from "../../config/db.js";
import { sendText } from "../../services/evolution.service.js";
import * as dailyRepo from "../../repositories/daily.repo.js";
import { assessDay, localHour } from "../personality/coach.js";
import { buildCoachReco } from "../coach-reco.js";
import * as T from "../personality/templates.js";

/**
 * "Cuanta prote me falta", "cuantas kcal llevo", "macros del dia".
 * Misma evaluación de coach que se adjunta tras cada comida: lo que queda
 * + status + alertas de pasado/poco + alerta temprana por hora.
 */
export async function handleNutritionQuery(user: User): Promise<void> {
  const jid = user.wa_chat_id!;
  const row = await dailyRepo.getDailyRemaining(user.id);
  if (!row) {
    await sendText(jid, T.nutritionNoPlan());
    return;
  }
  const assessment = assessDay(row, localHour(user.timezone));
  const reco = await buildCoachReco(assessment);
  await sendText(jid, T.coachReport(assessment, reco));
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
