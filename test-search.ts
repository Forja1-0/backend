import { config } from 'dotenv';
config();
import { searchFoodCandidates } from './src/repositories/food.repo.js';

async function test(query) {
  const res = await searchFoodCandidates(query, 25);
  console.log(`[${query}] Top candidates:`);
  res.slice(0, 10).forEach(r => console.log(`  - ${r.name} (score: ${r.base_score})`));
}

await test("pan");
process.exit(0);
