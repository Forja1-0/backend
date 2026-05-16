#!/usr/bin/env node
// Seedea food_portions resolviendo food_id contra los nombres REALES de
// food_items, usando el MISMO matching del parser (prefix > fts > trgm).
//
//   node scripts/seed-food-portions.mjs            -> seedea (threshold 0.45)
//   node scripts/seed-food-portions.mjs --dry-run  -> no escribe, solo reporta
//   node scripts/seed-food-portions.mjs --threshold 0.6
//
// Idempotente: borra y reinserta SOLO las rows de los sources del JSON
// (ATLAS_UBA / EQUIVALENCIAS_2026 / estimado). Porciones de otro origen
// quedan intactas. Re-correr despues de ajustar food_query es seguro.
//
// Filas que no matchean food_items por encima del threshold se insertan
// igual con food_id = NULL (registro de diagnostico; el parser las ignora
// porque consulta por food_id). El reporte final lista que ajustar.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import "dotenv/config";
import pg from "pg";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const tIdx = args.indexOf("--threshold");
const THRESHOLD = tIdx >= 0 ? parseFloat(args[tIdx + 1]) : 0.45;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL no esta seteada");
  process.exit(1);
}

// Mismo cascade que src/repositories/food.repo.ts::searchFood pero
// devolviendo name + score para poder reportar el match resuelto.
const MATCH_SQL = `
  WITH
    prefix AS (
      SELECT id, 1.0::real AS s, 'prefix'::text AS src
      FROM food_items WHERE lower(name) LIKE $1 || '%' LIMIT 5
    ),
    fts AS (
      SELECT fi.id,
             LEAST(ts_rank(to_tsvector('spanish', fi.name),
                           plainto_tsquery('spanish', $1)) * 4, 1.0)::real AS s,
             'fts'::text AS src
      FROM food_items fi
      WHERE to_tsvector('spanish', fi.name) @@ plainto_tsquery('spanish', $1)
        AND fi.id NOT IN (SELECT id FROM prefix)
      ORDER BY s DESC LIMIT 5
    ),
    trgm AS (
      SELECT fi.id, similarity(lower(fi.name), $1)::real AS s, 'trgm'::text AS src
      FROM food_items fi
      WHERE similarity(lower(fi.name), $1) > 0.25
        AND fi.id NOT IN (SELECT id FROM prefix)
        AND fi.id NOT IN (SELECT id FROM fts)
      ORDER BY s DESC LIMIT 5
    ),
    combined AS (
      SELECT id, s, src, 1 AS p FROM prefix
      UNION ALL SELECT id, s, src, 2 FROM fts
      UNION ALL SELECT id, s, src, 3 FROM trgm
    )
  SELECT fi.id, fi.name, c.s AS score, c.src AS match_source
  FROM combined c JOIN food_items fi ON fi.id = c.id
  ORDER BY c.p, c.s DESC
  LIMIT 1`;

const seedPath = resolve("sql/seeds/food_portions.json");
const rows = JSON.parse(await readFile(seedPath, "utf8"));

const client = new pg.Client({ connectionString: url });
await client.connect();
console.log(`[seed] target: ${url.replace(/:[^:@]+@/, ":***@")}`);
console.log(`[seed] ${rows.length} porciones · threshold ${THRESHOLD}${DRY_RUN ? " · DRY RUN" : ""}\n`);

// ── 1. Resolver food_id por matching ────────────────────────
const resolved = [];
const unmatched = [];
for (const r of rows) {
  const q = r.food_query.trim().toLowerCase();
  const { rows: m } = await client.query(MATCH_SQL, [q]);
  const top = m[0];
  if (top && top.score >= THRESHOLD) {
    resolved.push({ ...r, food_id: top.id, _matched_name: top.name, _score: top.score, _src: top.match_source });
  } else {
    unmatched.push({ ...r, food_id: null, _best: top ? `${top.name} (${top.score.toFixed(2)} ${top.match_source})` : "—" });
  }
}

// ── 2. Demotar defaults duplicados por (food_id, estado) ─────
const demoted = [];
const seenDefault = new Set();
for (const r of resolved) {
  if (!r.is_default) continue;
  const key = `${r.food_id}|${r.portion_state ?? ""}`;
  if (seenDefault.has(key)) {
    r.is_default = false;
    demoted.push(r);
  } else {
    seenDefault.add(key);
  }
}

// ── 3. Escribir (salvo dry-run) ─────────────────────────────
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
        [
          r.food_id,
          r.food_query,
          r.portion_name,
          r.portion_grams,
          r.portion_state,
          r.is_default ?? false,
          r.source,
          r.notes ?? null,
        ],
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

// ── 4. Reporte ──────────────────────────────────────────────
console.log(`✓ Matcheadas: ${resolved.length}`);
console.log(`✗ Sin match (food_id NULL): ${unmatched.length}`);
if (demoted.length) console.log(`↓ Defaults demovidos (ya habia default p/ ese alimento+estado): ${demoted.length}`);

const weak = resolved.filter((r) => r._score < 0.7);
if (weak.length) {
  console.log(`\n⚠ Matches débiles (score < 0.70) — REVISAR que el alimento sea el correcto:`);
  for (const r of weak) {
    console.log(`   "${r.food_query}" → "${r._matched_name}" (${r._score.toFixed(2)} ${r._src})`);
  }
}
if (unmatched.length) {
  console.log(`\n✗ NO matchearon food_items — ajustá "food_query" en el JSON y re-corré:`);
  for (const r of unmatched) {
    console.log(`   "${r.food_query}" [${r.label}] · mejor candidato: ${r._best}`);
  }
}
if (demoted.length) {
  console.log(`\n↓ Demovidos a is_default=false (un alimento+estado solo puede tener 1 default):`);
  for (const r of demoted) {
    console.log(`   ${r.label} · "${r.portion_name}" (${r.portion_grams}g)`);
  }
}
console.log(`\n${DRY_RUN ? "DRY RUN — no se escribió nada." : "Listo."}`);

await client.end();
process.exit(0);
