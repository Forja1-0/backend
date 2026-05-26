import pg from 'pg';
import 'dotenv/config';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const queries = [
  "SELECT id, name FROM food_items WHERE name ILIKE '%asado%' LIMIT 10",
  "SELECT id, name FROM food_items WHERE name ILIKE '%lomo%' LIMIT 10",
  "SELECT id, name FROM food_items WHERE name ILIKE '%ternera%' LIMIT 10",
  "SELECT id, name FROM food_items WHERE name ILIKE '%novillo%' LIMIT 10"
];

for (const q of queries) {
  console.log('---', q);
  const res = await client.query(q);
  console.table(res.rows.map(r => r.name));
}

await client.end();
