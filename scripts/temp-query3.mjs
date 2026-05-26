import pg from 'pg';
import 'dotenv/config';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const res = await client.query("SELECT id, name FROM food_items WHERE name ILIKE '%promedio%' LIMIT 20");
console.table(res.rows.map(r => r.name));

await client.end();
