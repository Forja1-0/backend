/**
 * Store en memoria para sesiones de conversación multi-paso.
 * Cada usuario puede estar en el medio de un flujo (ej: captura de RPE,
 * check-in nocturno, confirmación de comida). Guardamos el estado por JID.
 *
 * En prod esto alcanza para MVP — si el proceso se reinicia se pierden las
 * sesiones activas (máx 1-2 min de inconveniencia).
 */

export interface PendingMeal {
  parsed_items: Array<{
    name: string;
    grams: number;
    kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    food_item_id: string | null;
    matched_db_name: string | null;
  }>;
  totals: { kcal: number; protein: number; carbs: number; fat: number };
  is_estimate: boolean;
  raw_input: string;
}

export interface MealStateClarify {
  item_index: number;
  food_label: string;
  grams: number;
  crudo: { food_item_id: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  cocido: { food_item_id: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number };
}

export type SessionState =
  | { flow: "rpe_capture"; training_log_id: string }
  | { flow: "checkin_nutrition"; step: 1 }
  | { flow: "checkin_sleep"; step: 2; nutrition_ok: boolean }
  | { flow: "checkin_pain"; step: 3; nutrition_ok: boolean; sleep: number }
  | { flow: "meal_confirm"; meal: PendingMeal }
  | { flow: "meal_clarify"; raw_original: string; normalized_original: string; food_hint: string }
  | {
      flow: "meal_state_clarify";
      items: PendingMeal["parsed_items"];
      clarify: MealStateClarify;
      is_estimate: boolean;
      raw_input: string;
    }
  | { flow: "meal_food_clarify"; clarify: FoodClarify }
  | { flow: "weight_capture" }
  | { flow: "baja_confirm" };

/**
 * Cola de desambiguación: items ya resueltos + items pendientes de elegir.
 * Importado por meal-parser.ts que lo genera, y por meal.handler.ts que lo consume.
 */
export interface FoodClarify {
  resolved: PendingMeal["parsed_items"];
  queue: FoodClarifyEntry[];
  raw_input: string;
  is_estimate: boolean;
}

export interface FoodClarifyEntry {
  item: { raw: string; mode: string; qty: number; measure?: string; food: string };
  options: { food_item_id: string; name: string }[];
}

const store = new Map<string, SessionState>();

const DEFAULT_TTL_MS = 10 * 60 * 1000;

// Flujos iniciados por cron: el usuario contesta cuando ve el mensaje, no en
// el momento. Con el TTL corto, un "no" media hora despues del check-in caia
// al fallback generico ("se me escapo...") porque la sesion ya habia expirado.
const CRON_FLOW_TTL_MS = 3 * 60 * 60 * 1000;
const FLOW_TTL_MS: Partial<Record<SessionState["flow"], number>> = {
  checkin_nutrition: CRON_FLOW_TTL_MS,
  checkin_sleep: CRON_FLOW_TTL_MS,
  checkin_pain: CRON_FLOW_TTL_MS,
  weight_capture: CRON_FLOW_TTL_MS,
};

const expirations = new Map<string, ReturnType<typeof setTimeout>>();

function resetTtl(jid: string, flow: SessionState["flow"]) {
  const prev = expirations.get(jid);
  if (prev) clearTimeout(prev);
  expirations.set(
    jid,
    setTimeout(() => {
      store.delete(jid);
      expirations.delete(jid);
    }, FLOW_TTL_MS[flow] ?? DEFAULT_TTL_MS),
  );
}

export function getSession(jid: string): SessionState | null {
  return store.get(jid) ?? null;
}

export function setSession(jid: string, state: SessionState): void {
  store.set(jid, state);
  resetTtl(jid, state.flow);
}

export function clearSession(jid: string): void {
  const timer = expirations.get(jid);
  if (timer) clearTimeout(timer);
  store.delete(jid);
  expirations.delete(jid);
}
