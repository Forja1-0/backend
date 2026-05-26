#!/usr/bin/env node
// Seedea recipes + recipe_components resolviendo food_id contra food_items
// con el mismo cascade (prefix/fts/trgm) + score de cobertura de tokens que
// usa scripts/seed-food-portions.mjs. Idempotente: DELETE+INSERT por source.
//
//   node scripts/seed-recipes.mjs --dry-run
//   node scripts/seed-recipes.mjs --min-coverage 0.6
//   node scripts/seed-recipes.mjs --verbose
//
// Componentes sin match seguro -> se insertan con food_id NULL (el hidratador
// del meal-parser los marca como estimate y los lista para revisar).
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import "dotenv/config";
import pg from "pg";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");
const cIdx = args.indexOf("--min-coverage");
const MIN_COVERAGE = cIdx >= 0 ? parseFloat(args[cIdx + 1]) : 0.5;
const SOURCE = "forja_v1";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL no esta seteada"); process.exit(1); }

const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const STOPWORDS = new Set(["de","del","la","el","los","las","con","y","e","a","al","en"]);
const sing = (w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);

function tokens(q) {
  return strip(q).split(/[\s,()/]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t)).map(sing);
}
function coverage(query, name) {
  const qs = tokens(query);
  if (qs.length === 0) return 0;
  const n = strip(name);
  return qs.filter((t) => n.includes(t) || sing(n).includes(t)).length / qs.length;
}

const CAND_SQL = `
  WITH
    prefix AS (
      SELECT id, name, 1.0::real AS s FROM food_items
      WHERE lower(name) LIKE $1 || '%' LIMIT 10),
    fts AS (
      SELECT fi.id, fi.name,
             LEAST(ts_rank(to_tsvector('spanish', fi.name),
                           plainto_tsquery('spanish', $1)) * 4, 1.0)::real AS s
      FROM food_items fi
      WHERE to_tsvector('spanish', fi.name) @@ plainto_tsquery('spanish', $1)
      ORDER BY s DESC LIMIT 15),
    trgm AS (
      SELECT fi.id, fi.name, similarity(lower(fi.name), $1)::real AS s
      FROM food_items fi
      WHERE similarity(lower(fi.name), $1) > 0.2
      ORDER BY s DESC LIMIT 15)
  SELECT DISTINCT id, name, s FROM (
    SELECT * FROM prefix UNION ALL SELECT * FROM fts UNION ALL SELECT * FROM trgm
  ) u`;

const seedPath = resolve("sql/seeds/recipes.json");
const recipes = JSON.parse(await readFile(seedPath, "utf8"));

const client = new pg.Client({ connectionString: url });
await client.connect();
console.log(`[seed] target: ${url.replace(/:[^:@]+@/, ":***@")}`);
console.log(`[seed] ${recipes.length} recetas · min-coverage ${MIN_COVERAGE}${DRY_RUN ? " · DRY RUN" : ""}\n`);

let totalComp = 0, resolvedComp = 0, unmatchedComp = 0;
const reviewed = [], unmatched = [];

// Resolver food_id de TODOS los componentes antes de tocar la DB.
for (const r of recipes) {
  for (const c of r.components) {
    totalComp++;
    const q = c.food_query.trim().toLowerCase();
    const { rows: cand } = await client.query(CAND_SQL, [q]);
    const scored = cand
      .map((x) => ({ ...x, cov: coverage(q, x.name) }))
      .sort((a, b) => b.cov - a.cov || a.name.length - b.name.length || b.s - a.s);
    const top = scored[0];
    if (top && top.cov >= MIN_COVERAGE) {
      c._food_id = top.id;
      c._food_name = top.name;
      c._cov = top.cov;
      resolvedComp++;
      if (top.cov < 1) reviewed.push({ recipe: r.slug, q, top, alts: scored.slice(1, 3) });
    } else {
      c._food_id = null;
      c._top3 = scored.slice(0, 3);
      unmatchedComp++;
      unmatched.push({ recipe: r.slug, q, top3: scored.slice(0, 3) });
    }
  }
}

if (!DRY_RUN) {
  try {
    await client.query("BEGIN");
    // Borrar recetas viejas del mismo source. CASCADE limpia components.
    await client.query(`DELETE FROM recipes WHERE source = $1`, [SOURCE]);
    for (const r of recipes) {
      const { rows: ins } = await client.query(
        `INSERT INTO recipes (slug, display_name, aliases, default_portion_g, source_url, source)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [r.slug, r.display_name, r.aliases, r.default_portion_g, r.source_url ?? null, SOURCE],
      );
      const recipeId = ins[0].id;
      let order = 0;
      for (const c of r.components) {
        await client.query(
          `INSERT INTO recipe_components
             (recipe_id, food_id, food_query, grams_per_portion, state, display_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [recipeId, c._food_id, c.food_query, c.grams_per_portion, c.state ?? null, order++],
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[seed] ✗ fallo, rollback: ${err.message}`);
    await client.end();
    process.exit(1);
  }
}

console.log(`✓ Recetas: ${recipes.length}`);
console.log(`✓ Componentes resueltos: ${resolvedComp}/${totalComp}`);
console.log(`✗ Componentes sin match (food_id NULL): ${unmatchedComp}`);

if (VERBOSE) {
  console.log(`\n— Componentes resueltos —`);
  for (const r of recipes) {
    console.log(`  ${r.slug}:`);
    for (const c of r.components) {
      if (c._food_id) console.log(`    "${c.food_query}" → "${c._food_name}" (cov ${c._cov.toFixed(2)})`);
    }
  }
}
if (reviewed.length) {
  console.log(`\n⚠ Revisar (cobertura < 1.0):`);
  for (const x of reviewed) {
    console.log(`   [${x.recipe}] "${x.q}" → "${x.top.name}" (cov ${x.top.cov.toFixed(2)})`);
    for (const a of x.alts) console.log(`        alt: "${a.name}" (cov ${a.cov.toFixed(2)})`);
  }
}
if (unmatched.length) {
  console.log(`\n✗ SIN match (food_id NULL) — top-3 candidatos:`);
  for (const x of unmatched) {
    console.log(`   [${x.recipe}] "${x.q}"`);
    for (const c of x.top3) console.log(`        ${c.name}  (cov ${coverage(x.q, c.name).toFixed(2)})`);
    if (x.top3.length === 0) console.log(`        (sin candidatos)`);
  }
}
console.log(`\n${DRY_RUN ? "DRY RUN — no se escribió nada." : "Listo."}`);

await client.end();
process.exit(0);
