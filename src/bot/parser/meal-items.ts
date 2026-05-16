/**
 * Parseo PURO (sin DB) de un mensaje de comida a items con cantidad.
 *
 * Resuelve el bug central: "2 milanesas" debe ser 2 UNIDADES, no 2 gramos.
 *
 * Orden de patrones por item (spec 3b):
 *   1. Gramos explícitos:  "200g de arroz"      → {mode:'grams'}
 *   2. Medida casera:      "un plato de fideos" → {mode:'measure'}
 *   3. Unidades:           "2 milanesas"        → {mode:'units'}
 *   4. Solo alimento:      "puré"               → {mode:'bare', qty:1}
 */

export type ItemMode = "grams" | "measure" | "units" | "bare";

export interface ParsedItem {
  /** segmento original (para logs / clarify). */
  raw: string;
  mode: ItemMode;
  /** grams: gramos. units/measure: cantidad. bare: 1. */
  qty: number;
  /** solo mode 'measure': "plato" | "feta" | "cucharada" | ... */
  measure?: string;
  /** texto del alimento, ya sin cantidad/medida/verbo. */
  food: string;
}

const NUM_WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  medio: 0.5, media: 0.5, "½": 0.5, "¼": 0.25, "¾": 0.75,
};

const MASS_UNIT_RE = "g|gr|grs|gs|gramos?|kg|kgs|kilos?|ml|cc|lts?|litros?";
const MASS_KILO_RE = /^(kg|kgs|kilos?|lts?|litros?)$/;

// Medidas caseras reconocidas (singular y plural colapsados al buscar).
const MEASURES = [
  "plato playo", "plato hondo", "plato",
  "cucharada sopera", "cucharadita", "cucharada",
  "taza", "vaso", "pocillo", "pote", "lata",
  "feta", "rodaja", "porcion", "punado", "rulo", "puñado",
];

const VERB_NOISE_RE =
  /^(?:me\s+|te\s+|se\s+|hoy\s+|ayer\s+|anoche\s+|recien\s+|ahora\s+)*(?:comi|come|comer|comiendo|cene|ceno|cenar|cenando|desayune|desayuno|desayunar|almorce|almorzo|almorzar|almorzando|merende|merendar|merende|tome|tomo|tomar|probe|probar|morfe|engulli|me clave|me mande|me hice|me prepare)\s+/;

/** Quita verbo de comer / adverbios temporales del comienzo. */
function stripVerb(seg: string): string {
  let s = seg.trim();
  let prev;
  do {
    prev = s;
    s = s.replace(VERB_NOISE_RE, "").trim();
  } while (s !== prev);
  return s || seg.trim();
}

/** Separa el mensaje en items por "y", "con", ",", "+", "mas". */
export function splitItems(text: string): string[] {
  return text
    .split(/\s+y\s+|\s+e\s+|\s+con\s+|\s*,\s*|\s*\+\s*|\s+mas\s+|\s+más\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseQtyToken(tok: string): number | null {
  if (NUM_WORDS[tok] !== undefined) return NUM_WORDS[tok];
  if (/^\d+(?:[.,]\d+)?$/.test(tok)) return parseFloat(tok.replace(",", "."));
  return null;
}

function matchMeasure(s: string): { measure: string; rest: string } | null {
  for (const m of MEASURES) {
    // permite plural: "platos", "fetas", "cucharadas"
    const re = new RegExp(`^${m}s?\\b\\s*(?:de\\s+)?(.*)$`, "i");
    const hit = s.match(re);
    if (hit) return { measure: m.replace("ñ", "n"), rest: hit[1].trim() };
  }
  return null;
}

/** Parsea UN segmento ya sin verbo. */
function parseSegment(seg: string): ParsedItem | null {
  const s = seg.trim().toLowerCase();
  if (!s) return null;

  // ── 1. Gramos explícitos ──────────────────────────────────
  const g = s.match(
    new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*(${MASS_UNIT_RE})\\b\\s*(?:de\\s+)?(.+)$`, "i"),
  );
  if (g) {
    let qty = parseFloat(g[1].replace(",", "."));
    if (MASS_KILO_RE.test(g[2].toLowerCase())) qty *= 1000;
    const food = g[3].trim();
    if (food) return { raw: seg, mode: "grams", qty: Math.round(qty), food };
  }

  // ── 2. Medida casera ("un plato de fideos", "2 fetas de jamon") ──
  const qm = s.match(/^([\wáéíóú½¼¾]+)\s+(.+)$/i);
  if (qm) {
    const qty = parseQtyToken(qm[1]);
    if (qty !== null) {
      const mm = matchMeasure(qm[2]);
      if (mm && mm.rest) {
        return { raw: seg, mode: "measure", qty, measure: mm.measure, food: mm.rest };
      }
    }
  }
  // medida sin cantidad explícita ("plato de fideos")
  const m0 = matchMeasure(s);
  if (m0 && m0.rest) {
    return { raw: seg, mode: "measure", qty: 1, measure: m0.measure, food: m0.rest };
  }

  // ── 3. Unidades (número/palabra + alimento, SIN unidad de masa) ──
  if (qm) {
    const qty = parseQtyToken(qm[1]);
    if (qty !== null && qm[2].trim()) {
      return { raw: seg, mode: "units", qty, food: qm[2].trim() };
    }
  }

  // ── 4. Solo alimento ──────────────────────────────────────
  const food = s.replace(/^(de|del|la|el|los|las|un|una|unos|unas)\s+/i, "").trim();
  if (food.length >= 2) return { raw: seg, mode: "bare", qty: 1, food };
  return null;
}

/** Pipeline completo: strip verbo → split → parse cada item. */
export function parseMealItems(normalized: string): ParsedItem[] {
  const cleaned = stripVerb(normalized);
  const segments = splitItems(cleaned);
  const items: ParsedItem[] = [];
  for (const seg of segments) {
    const parsed = parseSegment(stripVerb(seg));
    if (parsed) items.push(parsed);
  }
  return items;
}
