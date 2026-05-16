import { config } from 'dotenv';
config();
import { parseMealItems } from './src/bot/parser/meal-items.js';

async function test(text) {
  const res = await parseMealItems(text);
  console.log(`[${text}]`);
  console.log(JSON.stringify(res, null, 2));
}

await test("comi 2 pollos y 4 pan");
process.exit(0);
