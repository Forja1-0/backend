import { config } from 'dotenv';
config();
import { resolveFood } from './src/bot/parser/food-resolve.js';

async function test(query) {
  const res = await resolveFood(query);
  if (res.kind === "resolved") {
    console.log(`[${query}] RESOLVED: ${res.food.name} (state: ${res.state})`);
  } else if (res.kind === "ambiguous") {
    console.log(`[${query}] AMBIGUOUS:`, res.options.map(o => o.name));
  } else {
    console.log(`[${query}] NONE`);
  }
}

await test("milanesa");
await test("huevos");
await test("pollo");
await test("pan");
process.exit(0);
