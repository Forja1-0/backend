import fs from 'fs';

const path = 'sql/seeds/recipes.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));

for (const recipe of data) {
  for (const comp of recipe.components) {
    if (
      comp.food_query === 'carne picada' ||
      comp.food_query === 'carne nalga' ||
      comp.food_query === 'falda de vaca' ||
      comp.food_query === 'vacio de vaca' ||
      comp.food_query === 'peceto' ||
      comp.food_query === 'bife de carne' ||
      comp.food_query === 'carne de res'
    ) {
      comp.food_query = 'Vacuno, PROMEDIO';
    }
    if (comp.food_query === 'masa para canelones') {
      comp.food_query = 'Pastas secas';
    }
  }
}

fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log('Fixed recipes.json');
