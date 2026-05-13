/**
 * Diccionarios de keywords y regex por intent.
 * Todo asume texto ya pasado por normalize() (lowercase, sin acentos, sin emoji).
 *
 * Estructura:
 * - KEYWORDS_* : sets de palabras unicas para fuzzy match (tolerancia a typos)
 * - REGEX_*   : patrones regex para captura de contexto (ej: extraer session_name)
 *
 * Reglas para agregar entradas:
 * 1. Probar sin tildes (ya las strippeamos).
 * 2. Probar con typos comunes (intercambio de letras, faltante de 1 letra).
 * 3. Probar abreviaciones de WhatsApp ("grcs", "xfa", "tmb").
 */

// ════════════════════════════════════════════════════════════
// COMMANDS — slash o palabra exacta
// ════════════════════════════════════════════════════════════

export const REGEX_HELP = /^\/?(ayuda|help|ayudame|que podes hacer|comandos|menu)\??$/;
export const REGEX_BAJA = /^\/?(baja|cancelar( ?cuenta)?|darme de baja|salir|chau forja)$/;
export const REGEX_PERFIL = /^\/?(perfil|mi perfil|datos|mis datos|mi info)$/;

// ════════════════════════════════════════════════════════════
// GREETING / GRATITUDE / AFFIRMATION / NEGATION
// ════════════════════════════════════════════════════════════

export const KEYWORDS_GREETING = [
  "hola", "holi", "holis", "hello", "hi", "hey", "ey",
  "buenas", "buen dia", "buendia", "buenos dias",
  "buenas tardes", "buenas noches",
  "que tal", "que onda", "que hace", "que haces", "como va",
  "qonda", "konda",
] as const;

export const KEYWORDS_GRATITUDE = [
  "gracias", "grcs", "grax", "graxias", "thx", "thanks",
  "ty", "agradecido", "agradecida", "te re agradezco",
  "muchas gracias", "mil gracias", "groso",
] as const;

export const KEYWORDS_AFFIRMATION = [
  "si", "sii", "sip", "yep", "yes", "ok", "oka", "okey", "okay",
  "dale", "claro", "obvio", "obvi", "joya", "perfecto", "perfe",
  "bien", "bueno", "buenisimo", "barbaro", "barbara",
  "confirmo", "afirmativo", "correcto", "exacto",
  "va", "vale", "listo", "hecho",
] as const;

export const KEYWORDS_NEGATION = [
  "no", "nop", "nope", "nones", "ni",
  "para nada", "ni ahi", "obvio no", "negativo",
  "ninguno", "nada", "tampoco", "incorrecto", "mal",
] as const;

// ════════════════════════════════════════════════════════════
// TRAINING — completado / salteado / consulta
// ════════════════════════════════════════════════════════════

export const KEYWORDS_TRAINING_NOUN = [
  "gym", "gimnasio", "gimnacio", "musculacion", "pesas", "fierros",
  "piernas", "pecho", "espalda", "hombros", "brazos", "biceps",
  "triceps", "core", "abs", "abdominales", "gluteos",
  "running", "correr", "trote", "fondo", "tirada", "interval", "intervalos",
  "rodaje", "regenerativo", "carrera",
  "natacion", "natación", "pileta", "nado", "nadar",
  "bici", "bike", "ciclismo", "ciclism", "rolo", "spinning", "indoor",
  "funcional", "crossfit", "wod", "amrap", "emom",
  "yoga", "movilidad", "stretching", "flex", "elongacion",
  "entreno", "entrenamiento", "entrenam", "sesion", "sesión",
  "workout", "training", "wod",
] as const;

// "completé/listo/terminé X" — verbos de COMPLETION
// Importante: "hice" suelto NO esta aca (causa falso positivo con "hice una llamada").
// Lo tomamos solo si va seguido de algo que parezca training.
export const REGEX_TRAINING_COMPLETE_STRONG = new RegExp(
  "\\b(complet[ae]|complete|completo|completado|completada|" +
  "termin[ae]|terminado|terminada|terminamos|" +
  "finalice|finalizado|finalizada|" +
  "acabe|acab[eo]|recien acabe|recien termine|" +
  "ya esta|ya termine|ya hice|ya entrene|" +
  "listo el|listo la|listo|" +
  "hecho|hecho el|hecha la|" +
  "cerrado|cerrada|cerrad[ae])\\b",
);

export const REGEX_TRAINING_COMPLETE_WEAK = /\b(hice|hicimos|cumpli|completado)\b/;

// "no pude / salté / descansé"
export const REGEX_TRAINING_SKIP = new RegExp(
  "\\b(no pude|no llegue|no fui|no entrene|no entrene hoy|" +
  "salte|saltee|me salte|me lo saltee|" +
  "descanse|tome descanso|dia de descanso|recovery|" +
  "no me banco|no di mas|no fui al gym)\\b",
);

// "qué entreno hoy", "qué toca", "cuál es la sesión"
export const REGEX_TRAINING_QUERY = new RegExp(
  "\\b(que (entreno|hago|tengo|toca|me toca|hay|sesion|sesión)|" +
  "cual es (la|el|mi) (sesion|sesión|entreno|entrenam|workout)|" +
  "que workout|cual workout|" +
  "mi (entreno|sesion|sesión|plan) (de )?hoy|" +
  "que (debo|tengo que) hacer (hoy|en el gym))\\b",
);

// ════════════════════════════════════════════════════════════
// MEAL — registro de comida
// ════════════════════════════════════════════════════════════

export const KEYWORDS_MEAL_VERB = [
  "comi", "almorce", "almorzar", "almuerzo",
  "desayune", "desayunar", "desayuno",
  "cene", "cenar", "cena",
  "merende", "merendar", "merienda",
  "tome", "tomar", "trague",
  "snackee", "snack",
  "picotie", "picotear", "picada",
  "engulli", "morfe", "papee", "manduque",
  "me clave", "me mande", "me hice", "me cocine", "me prepare",
  "comer", "ingeri", "consumi",
] as const;

export const KEYWORDS_MEAL_TIME = [
  "desayuno", "almuerzo", "merienda", "cena", "snack",
  "pre entreno", "preentreno", "pre workout", "preworkout",
  "post entreno", "postentreno", "post workout", "postworkout",
  "media tarde", "media mañana", "media manana",
  "antes de dormir", "antes de entrenar",
] as const;

// Alimentos comunes — NO exhaustivo (el match real va contra food_items).
// Sirve solo como heuristica del intent classifier para confirmar "es comida".
export const KEYWORDS_FOOD_HINT = [
  "pollo", "carne", "vaca", "cerdo", "pescado", "atun", "salmon", "merluza",
  "milanesa", "milanga", "bondiola", "lomo", "asado", "chorizo", "morcilla",
  "huevo", "huevos", "tortilla", "omelette", "revuelto", "clara", "claras",
  "queso", "muzza", "muzzarella", "ricota", "yogur", "yogurt", "yog",
  "leche", "manteca", "crema", "dulce de leche",
  "pan", "tostada", "tostadas", "galletita", "galletitas", "pan integral",
  "arroz", "fideo", "fideos", "pasta", "ñoqui", "ravioles", "tallarines",
  "papa", "papas", "papa frita", "batata", "zapallo", "calabaza",
  "ensalada", "lechuga", "tomate", "zanahoria", "cebolla", "pepino", "rucula",
  "manzana", "banana", "naranja", "mandarina", "pera", "uva", "frutilla",
  "ananas", "kiwi", "palta",
  "almendra", "nuez", "almendras", "nueces", "mani", "manies",
  "avena", "granola", "barrita", "barra",
  "proteina", "shake", "batido", "whey", "wpc",
  "mate", "mates", "tereré", "tereré", "cafe", "te", "infusion",
  "agua", "gaseosa", "jugo", "bebida",
  "chocolate", "alfajor", "torta", "tortita", "facturas", "factura",
  "helado", "postre", "dulce", "azucar",
  "porcion", "plato", "vasito",
] as const;

// Numeros en palabras (para "dos huevos", "tres tostadas")
export const KEYWORDS_QUANTITY_WORD = [
  "un", "una", "uno", "dos", "tres", "cuatro", "cinco", "seis",
  "siete", "ocho", "nueve", "diez", "medio", "media",
  "varios", "varias", "algunos", "algunas", "poco", "poca", "mucho", "mucha",
] as const;

// "200g de pollo", "2kg arroz", "una porcion"
export const REGEX_QUANTITY_UNIT = /\b(\d+(?:[.,]\d+)?)\s*(g|gr|gs|grs|grms|gramos|kg|kgs|kilos?|ml|cc|lts?|litros?|porcion(?:es)?|plato|plat[oi]s|vaso(?:s)?|tasa(?:s)?|cuchar(?:ada|adita|on))\b/;

// ════════════════════════════════════════════════════════════
// QUERIES — nutricion / progreso
// ════════════════════════════════════════════════════════════

export const KEYWORDS_QUERY_VERB = [
  "cuanto", "cuanta", "cuantos", "cuantas",
  "como voy", "como estoy", "como vamos",
  "que me falta", "me falta", "cuanto me falta", "cuanto queda", "cuanto resta",
  "llevo", "consumi", "comi hasta ahora",
  "que llevo", "que comi hoy",
] as const;

export const KEYWORDS_MACRO_NOUN = [
  "kcal", "cal", "cals", "calorias", "caloria",
  "prote", "proteina", "proteinas", "protein", "proteins", "wpc",
  "carbo", "carbos", "carb", "carbs", "carbohidrato", "carbohidratos", "hidrato", "hidratos", "hc",
  "grasa", "grasas", "grasita", "fat", "fats",
  "fibra", "fibras",
  "macro", "macros",
  "agua",
] as const;

export const KEYWORDS_PROGRESS = [
  "score", "performance", "puntaje", "puntos", "rendimiento",
  "resumen", "como va la semana", "semana", "semanal",
  "racha", "streak",
  "mi progreso", "progreso",
  "como voy con el objetivo",
] as const;

// ════════════════════════════════════════════════════════════
// DISRUPTION — injuries / illness / desliz
// ════════════════════════════════════════════════════════════

export const KEYWORDS_INJURY = [
  "lesion", "lesione", "me lesione", "me lastime", "lastimadura",
  "esguince", "me esguince", "torcedura", "me torci",
  "dolor", "duele", "dolio", "me duele", "molesta", "molestia",
  "tendinitis", "contractura", "desgarro", "tiron", "me tiroñe",
  "fisura", "fractura", "rotura",
  "kine", "kinesiologo", "kinesiologa", "tengo turno con el kine",
] as const;

export const KEYWORDS_ILLNESS = [
  "enfermo", "enferma", "me enferme",
  "resfriado", "resfriada", "gripe", "gripado", "gripada",
  "fiebre", "tos", "angina", "anginas",
  "estomago", "panza", "diarrea", "vomito", "vomite",
  "covid", "dengue", "indispuesto", "indispuesta",
  "antibiotico", "medicado", "medicada",
  "me siento mal", "estoy bajoneado", "estoy bajoneada",
] as const;

// "Desliz" — separado en STRONG (siempre cuenta) y TRIGGER (necesita contexto)
//
// STRONG: frases explicitas de indulgencia. Si aparece, es desliz si o si.
export const KEYWORDS_DESLIZ_STRONG = [
  "atracon", "atracón", "me pase", "me re pase", "fiaca",
  "no me cuide", "me descuide", "se me fue de las manos",
  "tomamos algo", "salimos a tomar", "salida a comer",
  "fui a comer afuera", "fuimos a comer", "salimos a comer",
  "festejo", "cumple", "cumpleanos", "casamiento", "evento",
  "asadazo", "asado con amigos", "asadito con",
  "se nos fue de las manos", "me clave todo",
] as const;

// TRIGGER: palabras de alcohol/chatarra. Son ambiguas:
//   - "me tome 1 copa de vino con la cena" → NO desliz (meal con nota)
//   - "tome 6 birras" → SI desliz (cantidad alta)
//   - "comi pizza" sin contexto saludable → SI desliz
// El classifier decide en base a cantidad + presencia de meal_log signals.
export const KEYWORDS_DESLIZ_TRIGGER_ALCOHOL = [
  "birra", "birras", "cerveza", "cervezas", "fernet",
  "vino", "vinos", "champagne", "champan", "espumante",
  "gin", "ron", "vodka", "whisky", "whiskey", "tequila",
  "trago", "tragos", "alcohol", "copa", "copas",
] as const;

export const KEYWORDS_DESLIZ_TRIGGER_JUNK = [
  "pizza", "hamburguesa", "hamburguesas", "burguer",
  "mcdonald", "mcdo", "burger king",
  "alfajor", "alfajores",
  "torta", "facturas", "factura", "donut", "donuts",
  "helado", "helados",
  "papas fritas", "papitas",
  "choripan", "chorip[áa]n", "panchos", "pancho",
] as const;

// ════════════════════════════════════════════════════════════
// FEEDBACK / CORRECTION (para flow de confirmacion de comida)
// ════════════════════════════════════════════════════════════

export const KEYWORDS_CORRECTION = [
  "corregir", "corregi", "corregilo", "esta mal", "incorrecto",
  "no era", "no eran", "fueron", "fue", "cambiar", "cambialo",
  "modifica", "modificar", "edit", "editar",
  "borrar", "borralo", "elimina", "eliminalo", "cancelar", "cancela",
] as const;
