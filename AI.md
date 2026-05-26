# Funcionamiento de la AI en Forja

Documento integral de cómo la AI participa en el bot de WhatsApp: qué hace, cómo lo hace, qué modelos usa, qué entrada recibe, qué salida produce y a dónde va esa respuesta.

---

## 1. Stack y proveedor

- **Proveedor**: Google Generative AI (`@google/generative-ai`, SDK 0.21).
- **Modelo único**: `gemini-2.5-flash` (no se usa Pro, no se usa lite por inestabilidad — ver `src/services/gemini.service.ts:40-43`).
- **Tres instancias del mismo modelo con configs distintas** (`src/services/gemini.service.ts`):
  - `flash` — uso genérico (`temperature: 0.2`, `maxOutputTokens: 1024`). Cubre `splitMealText` y `parseTrainingPlan`.
  - `flashWarm` — resumen nocturno (`temperature: 0.9`, `maxOutputTokens: 600`). Más creativo para que el mensaje varíe cada día.
  - `flashNlu` — adaptador NLU del router (`temperature: 0`, `maxOutputTokens: 512`, `thinkingBudget: 0`, `responseMimeType: application/json`, `responseSchema` enum). Determinismo total y JSON forzado.
- **Clave**: `env.GEMINI_API_KEY`.
- **Self-check al boot**: `pingGemini()` corre al arrancar el server (`src/server.ts`). Si falla, queda logueado pero el bot sigue vivo y cae al classifier local. Además dispara un *warmup* fire-and-forget del modelo NLU para evitar cold-start de 6-8 s en el primer mensaje real.

---

## 2. Dónde entra la AI en el pipeline

La AI **no responde al usuario directamente nunca**. Es una capa de comprensión/extracción cuyo output alimenta handlers determinísticos que son los que arman el texto final con templates (`src/bot/personality/templates.ts`).

Hay **cuatro puntos** donde se invoca la AI:

| Uso | Función | Cuándo corre | Salida | Consumidor |
|---|---|---|---|---|
| NLU del router | `parseUserMessage` | En **cada mensaje** del bot (salvo sesión activa o slash exacto) | `{ intent, standardized_text, entities }` | `routeMessage` → handler |
| Split de comida | `splitMealText` | Fallback del meal-parser cuando regex local no separa items | Array `[{food, qty, unit, measure, state}]` | `meal-parser.ts` → resolver SARA2 |
| Parse de plan | `parseTrainingPlan` | One-shot en el onboarding (PDF del coach) | `{coach_name, days[]}` | `repositories/training.repo.ts` |
| Resumen nocturno | `generateNightlySummary` | Cron nocturno (`src/cron/night.cron.ts`) | Texto plano (60-120 palabras) | WhatsApp directo |

---

## 3. Flujo end-to-end de un mensaje del usuario

```
WhatsApp → Evolution API → POST /webhooks/evolution
       → evolutionWebhook handler (src/webhooks/evolution.webhook.ts)
       → linkOrCreateByJid (crea/recupera User)
       → routeMessage(user, text)  (src/bot/router.ts)
```

### Orden de decisión del router (`src/bot/router.ts`)

1. **Sesión activa** — si hay un `session.flow` en memoria (`rpe_capture`, `meal_confirm`, `checkin_*`, etc.), se despacha al handler de esa sesión y la AI **no se invoca**. La sesión ya sabe qué espera.
2. **Slash command exacto** (`/ayuda`, `/perfil`, `/baja`, …) — bypass AI por velocidad. Va directo a `dispatchByIntent`.
3. **NLU adapter (AI)** — corre `parseUserMessage` con Gemini. Si devuelve `intent !== "unknown"`, despacha directo. **Este es el camino que toma la mayoría del tráfico libre.**
4. **Classifier local de rescate** (`src/bot/parser/intent-classifier.ts`) — solo si NLU falló (timeout >8s, error de red, budget agotado, o devolvió `unknown`). Reglas regex + fuzzy match con `confidence ≥ 0.7` para dispatch directo.
5. **Training matcher** — si hay verbo de completado ("hice/terminé X") matchea X contra el plan del user.
6. **Meal fallback** — si el classifier dijo `meal_log` o si hay ≥3 tokens sin clasificar, intenta `handleMealLog`.
7. **Fallback final** — `handleUnknown` (template educado).

> Por qué NLU primero: el classifier local tiene falsos positivos confiados (ej. "unos" matchea fuzzy con "puntos" → progress_query con 0.85), que mandan comidas al handler equivocado.

---

## 4. NLU adapter — el corazón AI del bot

**Archivo**: `src/services/gemini.service.ts` → `parseUserMessage`.

### Entrada
- `rawText: string` (mensaje crudo del user, máx. 500 chars).
- `userId: string` (para budget).

### Configuración del modelo (`flashNlu`)
```ts
model: "gemini-2.5-flash",
generationConfig: {
  temperature: 0,
  maxOutputTokens: 512,
  thinkingConfig: { thinkingBudget: 0 },   // sin thinking → -5-8s latencia
  responseMimeType: "application/json",
  responseSchema: { ... enum de intents ... }
}
```

### Prompt
Corto a propósito (los intents válidos vienen forzados por `responseSchema`, no por texto):
```
Clasifica el mensaje de un atleta argentino de WhatsApp (puede tener typos/modismos/abreviaciones) segun el schema.

Reglas:
- standardized_text: version canonica en español argentino sin typos ni emojis.
- entities.activity: solo si training_complete (ej "piernas", "pecho", "running"), si no null.
- entities.value: solo si numeric, si no null.
- entities.raw_food_input: solo si meal_log, texto limpio de los alimentos con cantidades sin verbos.
- entities.macro_target: solo si nutrition_query y se menciona un macro: "kcal"|"protein"|"carbs"|"fat".
- entities.description: solo si disruption_*, resumen corto.
- Si no entendes nada, intent="unknown".

Mensaje: "<texto>"
```

### Salida (validada con Zod en `src/schemas/bot.schema.ts`)
```ts
{
  intent: "command_help" | "command_baja" | "command_perfil"
        | "greeting" | "gratitude" | "affirmation" | "negation" | "correction"
        | "numeric"
        | "training_complete" | "training_skip" | "training_query"
        | "meal_log" | "nutrition_query" | "progress_query"
        | "disruption_injury" | "disruption_illness" | "disruption_desliz"
        | "unknown",
  standardized_text: string,
  entities: {
    activity?:        string | null,
    value?:           number | null,
    raw_food_input?:  string | null,
    macro_target?:    "kcal" | "protein" | "carbs" | "fat" | null,
    description?:     string | null,
  }
}
```

### Robustez
- **Timeout**: 8 s; si no responde, se aborta y cae al classifier local.
- **Cold start**: warmup al boot (ver `pingGemini`).
- **Budget**: 200 llamadas NLU/user/día (`src/services/ai-budget.service.ts`, `NLU_DAILY_LIMIT`). Contador en memoria, se resetea al restart.
- **Parsing resiliente**: `extractJsonObject` tolera prefijos ("Here is the JSON:") y fences markdown que Gemini a veces antepone aun con `responseMimeType: application/json`. Busca el primer objeto JSON balanceado.
- **Validación Zod**: si la respuesta no parsea o no respeta el schema, se descarta y se cae al classifier local. Nada de respuestas malformadas llega al handler.
- **Sin error visible al user**: cualquier fallo es invisible — el router pasa al siguiente paso.

### A dónde va la respuesta
`routeMessage` toma `intent` + `entities` y los pasa a `dispatchByIntent`. Si es `meal_log` y trae `raw_food_input`, ese texto limpio se usa como input al meal-parser (mejor que el original con typos).

---

## 5. Split de comida (AI auxiliar del meal-parser)

**Archivo**: `src/bot/parser/meal-parser.ts` → `tryAi` → `splitMealText` (en `gemini.service.ts`).

### Cuándo se llama
Solo si los pasos 1 y 2 del parser fallaron:
1. **Alias** — match contra `frequent_meals` del user (comidas que repite).
2. **Quick parse** — regex + tokenizer (`parseMealItems`) + resolver determinístico contra `food_items` (SARA2).
3. **AI** — si los anteriores no resolvieron items.

### Qué hace y qué NO hace
- ✅ Solo **separa** el texto libre en items con cantidad/unidad/estado.
- ❌ **Nunca** estima kcal ni macros. La fuente de verdad es siempre la tabla SARA2 (`food_items` + `food_portions`).
- ❌ **Nunca** inventa alimentos que el user no nombró.

### Salida
```ts
[
  {
    food: "milanesa de cerdo",
    qty: 2,
    unit: "g" | "units" | "measure" | null,
    measure: "plato" | "feta" | "cucharada" | ... | null,
    state: "crudo" | "cocido" | null
  }
]
```

Esos items se mandan al resolver (`resolveItems` → `resolveFood`), que matchea contra la DB. Si un alimento tiene varias variedades (ambiguo) o ambos estados crudo/cocido, **se le pregunta al user con lista numerada** — la AI no decide.

### Budget
5 llamadas/user/día (`DAILY_LIMIT`). Si se agota, cae a `source: "none"` y el handler responde un fallback templado.

---

## 6. Parse de plan de entrenamiento (one-shot)

**Función**: `parseTrainingPlan` (`src/services/gemini.service.ts`).

- **Cuándo**: durante onboarding, cuando el user manda el PDF o texto del plan de su coach.
- **Input**: texto plano del plan (máx. 8000 chars).
- **Output**: JSON estructurado con `coach_name`, `days[]` (cada día con `day_of_week`, `session_type`, `exercises[]` con `name`, `aliases`, `sets`, `reps`, `load_kg`, `notes`).
- **Aliases**: la AI genera variantes en argentino (slang, inglés, abreviaciones) para que después el `training-matcher` pueda reconocer "hice press" o "termine sentadillas" como ese ejercicio.
- **No pasa por budget** — es one-shot.
- **Persistencia**: el resultado se guarda en `training_plans`/`training_sessions`/`training_exercises` (ver `repositories/training.repo.ts`).

---

## 7. Resumen nocturno (cron)

**Función**: `generateNightlySummary` (`src/services/gemini.service.ts`).

- **Cuándo**: cron nocturno (`src/cron/night.cron.ts`).
- **Modelo**: `flashWarm` (`temperature: 0.9`) para que el mensaje **varíe cada día**.
- **Input**: `DailySummaryRow` agregado del día (kcal, adherencia, RPE, sueño, dolor, performance_score).
- **Prompt**: tono "Forja, coach argentino", reglas estrictas (sin diminutivos infantiles, vos/dale/che, 60-120 palabras, sin bullets, variar arranque, sugerir kine si dolor ≥ 7, no inventar datos).
- **Output**: texto plano que se manda **tal cual** al user vía WhatsApp.
- **Fallback**: si la AI falla, mensaje hardcodeado mínimo (`Cerramos el día, {name}. Score X/100. Mañana seguimos.`).

Este es **el único caso** en que el output de la AI llega al user sin pasar por un template — pero está acotado por system prompt fuerte y un fallback determinístico.

---

## 8. Cómo "responde" el bot

**El bot no usa la AI para componer respuestas conversacionales** (excepto el resumen nocturno). El patrón es:

```
mensaje del user
   → AI extrae intent + entities (NLU)  o  split de comida
   → handler determinístico hace su trabajo (DB, cálculos, sesión)
   → template en src/bot/personality/templates.ts arma el texto
   → sendText() → Evolution API → WhatsApp
```

Por qué esto importa:
- **Consistencia**: el tono y formato vienen de templates revisados, no de un modelo que improvisa.
- **Auditabilidad**: cada mensaje saliente queda logueado con su `category` (ver `logBotEvent` + `events.service.ts`).
- **Resiliencia**: si la AI cae, los templates siguen funcionando porque el classifier local cubre la mayoría de intents.

### Coach nutricional (`src/bot/personality/coach.ts`)
La lógica de evaluación post-comida ("vas bien", "te queda poco de proteína", "es temprano y ya consumiste mucho") es **100% determinística**, basada en umbrales (`OVER_TOLERANCE`, `LOW_REMAINING_PCT`, `EARLY_HOUR_CUTOFF`). La AI no participa en esa decisión.

---

## 9. Persistencia, logs y observabilidad

- **`system_events`** — cada paso del pipeline emite un evento (`logBotEvent`):
  - `wa.webhook_received`, `wa.message_received`, `wa.session_dispatch`
  - `wa.nlu_classified` (NLU AI hit) o `wa.intent_classified` con `via: "nlu_fallback"` (AI no resolvió)
  - `meal.parsed` con `source: "alias" | "quick" | "ai" | ...`
  - `meal.clarify_requested`, `meal.state_clarify`, `meal.food_clarify`
- **Logger**: `pino` (`src/config/logger.ts`). `nlu ok` / `nlu failed, falling back` con `latency_ms` y razón.
- **Budgets** son in-memory y se loguean warn cuando se topa el límite.

---

## 10. Resumen de garantías

| Garantía | Cómo se logra |
|---|---|
| Macros de comida no inventados | SARA2 es la única fuente; AI solo separa texto |
| Intents acotados | `responseSchema` enum + Zod validation |
| Sin alucinaciones en respuestas | Templates determinísticos, no LLM-as-writer (salvo nightly summary acotado) |
| Resiliencia a caída de Gemini | Classifier local fallback + warmup + timeouts + budgets |
| Determinismo del NLU | `temperature: 0`, `thinkingBudget: 0`, schema forzado |
| Cost cap | Budgets por user/día (200 NLU, 5 meal-split) |
| Latencia controlada | Timeout 8 s NLU, warmup al boot, sin thinking |

---

## 11. Archivos clave

- `src/services/gemini.service.ts` — toda la integración con Gemini.
- `src/services/ai-budget.service.ts` — rate limits per user.
- `src/schemas/bot.schema.ts` — schema Zod del NLU (espejo del enum del SDK).
- `src/bot/router.ts` — orden de decisión NLU-first.
- `src/bot/parser/intent-classifier.ts` — classifier local de rescate.
- `src/bot/parser/meal-parser.ts` — pipeline alias → quick → AI.
- `src/bot/personality/templates.ts` — todas las respuestas que ve el user.
- `src/bot/personality/coach.ts` — evaluación nutricional determinística.
- `src/cron/night.cron.ts` — disparo del resumen nocturno.
- `src/webhooks/evolution.webhook.ts` — entrypoint del mensaje WhatsApp.
