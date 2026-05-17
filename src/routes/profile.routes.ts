import { Router } from "express";
import { z } from "zod";
import * as repo from "../repositories/profile.repo.js";
import { NotFound } from "../utils/errors.js";
import { logger } from "../config/logger.js";

/**
 * API del perfil web (centro de control del atleta). Lecturas agregadas +
 * escrituras de alto valor (comidas frecuentes, restricciones, datos
 * corporales, lesiones activas). Todo mapeado al schema canónico — sin
 * tablas nuevas. Lo que la Fase Toyota no modela (suscripción, recordatorios,
 * tono del bot, privacidad) no se expone acá por coherencia con la DB.
 */
export const profileRoutes = Router();

const uuid = z.string().uuid();

const ingredientSchema = z.object({
  food_item_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  grams: z.number().nonnegative(),
  kcal: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  carbs: z.number().nonnegative(),
  fat: z.number().nonnegative(),
});
const mealBody = z.object({
  alias: z.string().min(1).max(80),
  ingredients: z.array(ingredientSchema).min(1),
});

async function ensureUser(userId: string) {
  const u = await repo.getUser(userId);
  if (!u) throw NotFound("user not found");
  return u;
}

// GET /api/profile/:userId — identidad básica
profileRoutes.get("/:userId", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    const u = await ensureUser(userId);
    res.json({
      user_id: u.id,
      name: u.name,
      age: u.age,
      sex: u.sex,
      email: u.email,
      phone_wa: u.phone_wa,
      wa_connected: u.wa_chat_id != null,
      timezone: u.timezone,
      onboarding_step: u.onboarding_step,
      member_since: u.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/:userId/overview — Inicio / Mi Semana
profileRoutes.get("/:userId/overview", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    res.json(await repo.getOverview(userId));
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/:userId/nutrition
profileRoutes.get("/:userId/nutrition", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    res.json(await repo.getNutrition(userId));
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/:userId/frequent-meals
profileRoutes.get("/:userId/frequent-meals", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    res.json({ meals: await repo.listFrequentMeals(userId) });
  } catch (err) {
    next(err);
  }
});

// POST /api/profile/:userId/frequent-meals
profileRoutes.post("/:userId/frequent-meals", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    const { alias, ingredients } = mealBody.parse(req.body);
    const meal = await repo.createFrequentMeal(userId, alias, ingredients);
    logger.info("frequent meal created", { userId, id: meal.id });
    res.status(201).json(meal);
  } catch (err) {
    next(err);
  }
});

// PUT /api/profile/:userId/frequent-meals/:id
profileRoutes.put("/:userId/frequent-meals/:id", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    const id = uuid.parse(req.params.id);
    await ensureUser(userId);
    const { alias, ingredients } = mealBody.parse(req.body);
    const meal = await repo.updateFrequentMeal(userId, id, alias, ingredients);
    if (!meal) throw NotFound("frequent meal not found");
    res.json(meal);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/profile/:userId/frequent-meals/:id
profileRoutes.delete("/:userId/frequent-meals/:id", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    const id = uuid.parse(req.params.id);
    await ensureUser(userId);
    const ok = await repo.deleteFrequentMeal(userId, id);
    if (!ok) throw NotFound("frequent meal not found");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/profile/:userId/restrictions
profileRoutes.put("/:userId/restrictions", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    const body = z
      .object({
        flags: z.record(z.boolean()).default({}),
        other: z.string().max(500).nullable().optional(),
      })
      .parse(req.body);
    const row = await repo.upsertRestrictions(userId, body.flags, body.other ?? null);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/:userId/training
profileRoutes.get("/:userId/training", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    res.json(await repo.getTraining(userId));
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/:userId/health
profileRoutes.get("/:userId/health", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    res.json(await repo.getHealth(userId));
  } catch (err) {
    next(err);
  }
});

// PUT /api/profile/:userId/body
profileRoutes.put("/:userId/body", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    const patch = z
      .object({
        weight_kg: z.number().positive().max(400).optional(),
        body_fat_pct: z.number().min(1).max(60).optional(),
        height_cm: z.number().positive().max(260).optional(),
      })
      .parse(req.body);
    res.json(await repo.updateBody(userId, patch));
  } catch (err) {
    next(err);
  }
});

// PUT /api/profile/:userId/injuries — reemplaza active_injuries
profileRoutes.put("/:userId/injuries", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    const body = z.object({ active_injuries: z.array(z.unknown()) }).parse(req.body);
    res.json(await repo.updateActiveInjuries(userId, body.active_injuries));
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/:userId/journey
profileRoutes.get("/:userId/journey", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    res.json(await repo.getJourney(userId));
  } catch (err) {
    next(err);
  }
});
