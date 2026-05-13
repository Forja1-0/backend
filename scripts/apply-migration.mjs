#!/usr/bin/env node
// Aplica un archivo .sql de migracion contra DATABASE_URL.
// Uso: node scripts/apply-migration.mjs sql/migrations/003_plan_uploads.sql
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import "dotenv/config";
import pg from "pg";

const file = process.argv[2];
if (!file) {
  console.error("uso: node scripts/apply-migration.mjs <ruta-al-sql>");
  process.exit(1);
}
const sqlPath = resolve(file);
const sql = await readFile(sqlPath, "utf8");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL no esta seteada");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
console.log(`[migration] aplicando ${file} contra ${url.replace(/:[^:@]+@/, ":***@")}`);
try {
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  console.log("[migration] OK");
} catch (err) {
  await client.query("ROLLBACK");
  console.error("[migration] FALLO:", err.message);
  process.exit(1);
} finally {
  await client.end();
}
