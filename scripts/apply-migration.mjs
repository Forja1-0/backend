#!/usr/bin/env node
// Aplica migrations contra DATABASE_URL.
//   node scripts/apply-migration.mjs                          -> aplica TODAS las sql/migrations/*.sql en orden
//   node scripts/apply-migration.mjs sql/migrations/003_*.sql -> aplica una sola
//
// Las migrations son idempotentes (IF NOT EXISTS / DO blocks) asi que
// re-correr no rompe nada.
import { readFile, readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import "dotenv/config";
import pg from "pg";

const arg = process.argv[2];
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL no esta seteada");
  process.exit(1);
}

async function listAll() {
  const dir = resolve("sql/migrations");
  const files = await readdir(dir);
  return files
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => resolve(dir, f));
}

const files = arg ? [resolve(arg)] : await listAll();
if (files.length === 0) {
  console.error("no hay migrations para aplicar");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
console.log(`[migration] target: ${url.replace(/:[^:@]+@/, ":***@")}`);

let failed = false;
for (const path of files) {
  const name = basename(path);
  const sql = await readFile(path, "utf8");
  console.log(`[migration] ▶ ${name}`);
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log(`[migration] ✓ ${name}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[migration] ✗ ${name}: ${err.message}`);
    failed = true;
    break;
  }
}
await client.end();
process.exit(failed ? 1 : 0);
