import type { User } from "../../types/user.types.js";
import { query } from "../../config/db.js";
import { env } from "../../config/env.js";
import { sendText } from "../../services/evolution.service.js";
import * as dailyRepo from "../../repositories/daily.repo.js";
import * as weightRepo from "../../repositories/weight.repo.js";
import { assessDay, localHour } from "../personality/coach.js";
import { buildCoachReco } from "../coach-reco.js";
import * as T from "../personality/templates.js";
import { logBotEvent, EventTypes } from "../../services/events.service.js";

/**
 * "Cuanta prote me falta", "cuantas kcal llevo", "macros del dia".
 * Misma evaluación de coach que se adjunta tras cada comida: lo que queda
 * + status + alertas de pasado/poco + alerta temprana por hora.
 */
export async function handleNutritionQuery(user: User): Promise<void> {
  const jid = user.wa_chat_id!;
  const amateur = env.FORJA_MODE === "amateur";
  const row = await dailyRepo.getDailyRemaining(user.id);
  if (!row) {
    logBotEvent(user.id, EventTypes.QUERY_NO_PLAN, { kind: "nutrition" });
    await sendText(jid, T.nutritionNoPlan(amateur), {
      userId: user.id,
      category: "nutrition_no_plan",
    });
    return;
  }
  const assessment = assessDay(row, localHour(user.timezone));
  const reco = await buildCoachReco(assessment);
  logBotEvent(user.id, EventTypes.QUERY_NUTRITION, {
    headline: assessment.headline,
    remaining_kcal: row.remaining_kcal ?? null,
    remaining_protein: row.remaining_protein ?? null,
    local_hour: localHour(user.timezone),
    early_alert: assessment.earlyAlert ? true : false,
  });
  await sendText(jid, T.coachReport(assessment, reco, amateur), {
    userId: user.id,
    category: "nutrition_query",
  });
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
  const r = rows[0] ?? { avg_score: null, days_logged: 0, training_days: 0 };

  // Amateur: la señal de progreso es PESO (tendencia) + consistencia, no un
  // score de adherencia. Respondemos con eso aunque no haya days_logged (el
  // peso puede existir sin comidas registradas esta semana).
  if (env.FORJA_MODE === "amateur") {
    const trend = await weightRepo.getWeightTrend(user.id);
    const view: T.ProgressAmateurView = {
      weight: trend
        ? { first: trend.first, latest: trend.latest, deltaFromFirst: trend.deltaFromFirst, count: trend.count }
        : null,
      daysLogged: r.days_logged,
      trainingDays: r.training_days,
    };
    logBotEvent(user.id, EventTypes.QUERY_PROGRESS, {
      has_data: r.days_logged > 0 || trend != null,
      amateur: true,
      weight_count: trend?.count ?? 0,
      days_logged: r.days_logged,
      training_days: r.training_days,
    });
    await sendText(jid, T.progressReportAmateur(view), {
      userId: user.id,
      category: "progress_report_amateur",
    });
    return;
  }

  if (r.days_logged === 0) {
    logBotEvent(user.id, EventTypes.QUERY_PROGRESS, { has_data: false });
    await sendText(
      jid,
      "Todavía no tengo datos de esta semana. Cargá tus comidas y entrenamientos y la próxima te respondo con números.",
      { userId: user.id, category: "progress_no_data" },
    );
    return;
  }
  logBotEvent(user.id, EventTypes.QUERY_PROGRESS, {
    has_data: true,
    avg_score: r.avg_score,
    days_logged: r.days_logged,
    training_days: r.training_days,
  });
  await sendText(
    jid,
    `📈 *Últimos 7 días*\n\n` +
      `• Score promedio: *${r.avg_score ?? "—"}/100*\n` +
      `• Días con registro: ${r.days_logged}/7\n` +
      `• Entrenamientos: ${r.training_days}`,
    { userId: user.id, category: "progress_report" },
  );
}
