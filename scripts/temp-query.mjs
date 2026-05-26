import pg from 'pg';
import 'dotenv/config';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const queries = [
  "SELECT id, name FROM food_items WHERE name ILIKE '%vacuna%' LIMIT 20",
  "SELECT id, name FROM food_items WHERE name ILIKE '%carne%' LIMIT 20",
  "SELECT id, name FROM food_items WHERE name ILIKE '%fideo%' LIMIT 20",
  "SELECT id, name FROM food_items WHERE name ILIKE '%pasta%' LIMIT 20",
  "SELECT id, name FROM food_items WHERE name ILIKE '%masa%' LIMIT 20"
];

for (const q of queries) {
  console.log('---', q);
  const res = await client.query(q);
  console.table(res.rows.map(r => r.name));
}

await client.end();
