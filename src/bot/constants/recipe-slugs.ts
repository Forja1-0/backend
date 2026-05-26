/**
 * Slugs canónicos de recetas compuestas. Espejo del campo `slug` en la
 * tabla `recipes` (seed sql/seeds/recipes.json). Se inyecta como enum en
 * el responseSchema del interpreter de Gemini para que el LLM SOLO pueda
 * elegir recetas que efectivamente sabemos hidratar.
 *
 * Si agregas una receta al seed, agregala aca tambien.
 */
export const RECIPE_SLUGS = [
  "tuco",
  "milanesa_napolitana",
  "locro",
  "empanada_carne",
  "guiso_lentejas",
  "pastel_papa",
  "pizza_muzzarella",
  "noquis_salsa",
  "tarta_jamon_queso",
  "asado_vacio",
  "lasagna",
  "canelones_carne",
  "ravioles_salsa",
  "choripan",
  "matambre_pizza",
  "revuelto_gramajo",
  "hamburguesa_casera",
  "tortilla_papa",
  "sandwich_milanesa",
  "albondigas_pure",
  "pollo_horno_papas",
  "arroz_con_pollo",
  "bife_caballo",
  "fideos_bolognesa",
  "provoleta",
  "pollo_verdeo",
  "milanesa_comun",
  "puchero",
  "carbonada",
  "vitel_tone",
  "pizza_fugazzeta",
  "ensalada_rusa",
  "tarta_acelga",
] as const;

export type RecipeSlug = (typeof RECIPE_SLUGS)[number];
