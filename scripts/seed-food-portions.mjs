#!/usr/bin/env node
// Seedea food_portions resolviendo food_id contra los nombres REALES de
// food_items. Dos estrategias por fila:
//   1. food_name presente  -> match EXACTO por nombre (case/acentos-insensible)
//   2. solo food_query     -> candidatos (prefix/fts/trgm) + score de
//                             COBERTURA de tokens (cuántas palabras del query
//                             aparecen en el nombre). Mata falsos positivos
//                             tipo "maní"→"Mango".
//
//   node scripts/seed-food-portions.mjs --dry-run
//   node scripts/seed-food-portions.mjs --min-coverage 0.6
//   node scripts/seed-food-portions.mjs --verbose   (lista TODO lo resuelto)
//
// Idempotente: DELETE+INSERT solo de los sources del JSON.
// Sin match seguro -> se inserta con food_id NULL (diagnóstico; el parser
// lo ignora) y se listan los top-3 candidatos para que ajustes el JSON.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import "dotenv/config";
import pg from "pg";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");
const cIdx = args.indexOf("--min-coverage");
const MIN_COVERAGE = cIdx >= 0 ? parseFloat(args[cIdx + 1]) : 0.67;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL no esta seteada");
  process.exit(1);
}

const strip = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "con", "y", "e", "a", "al", "en"]);
const sing = (w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);

function tokens(q) {
  return strip(q)
    .split(/[\s,()/]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(sing);
}

/** Fracción de tokens del query que aparecen en el nombre. */
function coverage(query, name) {
  const qs = tokens(query);
  if (qs.length === 0) return 0;
  const n = strip(name);
  const hit = qs.filter((t) => n.includes(t) || sing(n).includes(t)).length;
  return hit / qs.length;
}

// Candidatos: mismo cascade que el parser, pero traemos varios para
// re-rankear por cobertura en JS.
const CAND_SQL = `
  WITH
    prefix AS (
      SELECT id, name, 1.0::real AS s FROM food_items
      WHERE lower(name) LIKE $1 || '%' LIMIT 10
    ),
    fts AS (
      SELECT fi.id, fi.name,
             LEAST(ts_rank(to_tsvector('spanish', fi.name),
                           plainto_tsquery('spanish', $1)) * 4, 1.0)::real AS s
      FROM food_items fi
      WHERE to_tsvector('spanish', fi.name) @@ plainto_tsquery('spanish', $1)
      ORDER BY s DESC LIMIT 15
    ),
    trgm AS (
      SELECT fi.id, fi.name, similarity(lower(fi.name), $1)::real AS s
      FROM food_items fi
      WHERE similarity(lower(fi.name), $1) > 0.2
      ORDER BY s DESC LIMIT 15
    )
  SELECT DISTINCT id, name, s FROM (
    SELECT * FROM prefix UNION ALL SELECT * FROM fts UNION ALL SELECT * FROM trgm
  ) u`;

const EXACT_SQL = `
  SELECT id, name FROM food_items
  WHERE translate(lower(name),
        'áéíóúüñ','aeiouun') = translate(lower($1),'áéíóúüñ','aeiouun')
  LIMIT 1`;

const seedPath = resolve("sql/seeds/food_portions.json");
const rows = JSON.parse(await readFile(seedPath, "utf8"));

const client = new pg.Client({ connectionString: url });
await client.connect();
console.log(`[seed] target: ${url.replace(/:[^:@]+@/, ":***@")}`);
console.log(`[seed] ${rows.length} porciones · min-coverage ${MIN_COVERAGE}${DRY_RUN ? " · DRY RUN" : ""}\n`);

const resolved = [];   // food_id OK
const unmatched = [];   // food_id NULL
const exactUsed = [];
const reviewed = [];    // matcheado pero cobertura < 1 (revisar)

for (const r of rows) {
  // 1. Exact por food_name
  if (r.food_name) {
    const { rows: ex } = await client.query(EXACT_SQL, [r.food_name]);
    if (ex[0]) {
      resolved.push({ ...r, food_id: ex[0].id, _name: ex[0].name, _how: "exact" });
      exactUsed.push({ q: r.food_name, name: ex[0].name });
      continue;
    }
  }
  // 2. Fuzzy por cobertura
  const q = (r.food_query || r.food_name || r.label).trim().toLowerCase();
  const { rows: cand } = await client.query(CAND_SQL, [q]);
  const scored = cand
    .map((c) => ({ ...c, cov: coverage(q, c.name) }))
    .sort((a, b) => b.cov - a.cov || a.name.length - b.name.length || b.s - a.s);
  const top = scored[0];

  if (top && top.cov >= MIN_COVERAGE) {
    resolved.push({ ...r, food_id: top.id, _name: top.name, _cov: top.cov, _how: "fuzzy" });
    if (top.cov < 1) reviewed.push({ r, top, alts: scored.slice(1, 3) });
  } else {
    unmatched.push({ ...r, food_id: null, _top3: scored.slice(0, 3) });
  }
}

// Demotar defaults duplicados por (food_id, estado).
const demoted = [];
const seen = new Set();
for (const r of resolved) {
  if (!r.is_default) continue;
  const k = `${r.food_id}|${r.portion_state ?? ""}`;
  if (seen.has(k)) { r.is_default = false; demoted.push(r); }
  else seen.add(k);
}

const sources = [...new Set(rows.map((r) => r.source))];
const toInsert = [...resolved, ...unmatched];

if (!DRY_RUN) {
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM food_portions WHERE source = ANY($1)`, [sources]);
    for (const r of toInsert) {
      await client.query(
        `INSERT INTO food_portions
           (food_id, food_query, portion_name, portion_grams,
            portion_state, is_default, source, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.food_id, r.food_query ?? r.food_name ?? r.label, r.portion_name,
         r.portion_grams, r.portion_state, r.is_default ?? false, r.source, r.notes ?? null],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[seed] ✗ fallo, rollback: ${err.message}`);
    await client.end();
    process.exit(1);
  }
}

console.log(`✓ Matcheadas: ${resolved.length}  (exact: ${exactUsed.length}, fuzzy: ${resolved.length - exactUsed.length})`);
console.log(`✗ Sin match (food_id NULL): ${unmatched.length}`);
if (demoted.length) console.log(`↓ Defaults demovidos: ${demoted.length}`);

if (VERBOSE && resolved.length) {
  console.log(`\n— Resueltas —`);
  for (const r of resolved) {
    const tag = r._how === "exact" ? "exact" : `cov ${r._cov.toFixed(2)}`;
    console.log(`   ${r.label} · "${r.portion_name}" → "${r._name}" [${tag}]`);
  }
}
if (reviewed.length) {
  console.log(`\n⚠ Revisar (cobertura < 1.0 — confirmá que el alimento sea el correcto):`);
  for (const { r, top, alts } of reviewed) {
    console.log(`   "${r.food_query}" → "${top.name}" (cov ${top.cov.toFixed(2)})`);
    for (const a of alts) console.log(`        alt: "${a.name}" (cov ${a.cov.toFixed(2)})`);
  }
}
if (unmatched.length) {
  console.log(`\n✗ NO matchearon — poné "food_name" exacto en el JSON (top-3 abajo) y re-corré:`);
  for (const r of unmatched) {
    console.log(`   [${r.label}] query="${r.food_query}"`);
    for (const c of r._top3) console.log(`        ${c.name}  (cov ${c.cov.toFixed(2)}, s ${c.s.toFixed(2)})`);
    if (r._top3.length === 0) console.log(`        (sin candidatos)`);
  }
}
if (demoted.length) {
  console.log(`\n↓ Demovidos a is_default=false:`);
  for (const r of demoted) console.log(`   ${r.label} · "${r.portion_name}"`);
}
console.log(`\n${DRY_RUN ? "DRY RUN — no se escribió nada." : "Listo."}`);

await client.end();
process.exit(0);
