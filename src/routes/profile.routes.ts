import { Router } from "express";
import { z } from "zod";
import * as repo from "../repositories/profile.repo.js";
import { planFileUpload } from "../middleware/upload.js";
import { BadRequest, NotFound } from "../utils/errors.js";
import { logger } from "../config/logger.js";
import { requireAuth, enforcePathUserMatchesSession } from "../middleware/require-auth.js";
import { logEventFromRequest, EventTypes } from "../services/events.service.js";

/**
 * API del perfil web (centro de control del atleta). Lecturas agregadas +
 * escrituras de alto valor (comidas frecuentes, restricciones, datos
 * corporales, lesiones activas). Todo mapeado al schema canónico — sin
 * tablas nuevas. Lo que la Fase Toyota no modela (suscripción, recordatorios,
 * tono del bot, privacidad) no se expone acá por coherencia con la DB.
 *
 * Auth: TODAS las rutas requieren `Authorization: Bearer <session_token>`
 * y el `:userId` del path debe coincidir con el de la sesion (anti-IDOR).
 * Si un atacante consigue una sesion valida, solo puede tocar su propio
 * perfil — nunca el de otro UUID.
 *
 * Instrumentacion BI: cada GET de seccion emite `profile.section_viewed`
 * (la seccion va en el payload) y cada mutacion emite un evento dedicado
 * con un payload que captura QUE cambio sin volcar PII innecesaria.
 */
export const profileRoutes = Router();

profileRoutes.use(requireAuth);
profileRoutes.use("/:userId", enforcePathUserMatchesSession);

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
    logEventFromRequest(req, userId, EventTypes.PROFILE_SECTION_VIEWED, { section: "identity" });
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
    logEventFromRequest(req, userId, EventTypes.PROFILE_SECTION_VIEWED, { section: "overview" });
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
    logEventFromRequest(req, userId, EventTypes.PROFILE_SECTION_VIEWED, { section: "nutrition" });
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
    logEventFromRequest(req, userId, EventTypes.PROFILE_SECTION_VIEWED, { section: "frequent_meals" });
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
    logEventFromRequest(req, userId, EventTypes.PROFILE_FREQUENT_MEAL_CREATED, {
      meal_id: meal.id,
      ingredient_count: ingredients.length,
      alias_length: alias.length,
    });
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
    logEventFromRequest(req, userId, EventTypes.PROFILE_FREQUENT_MEAL_UPDATED, {
      meal_id: id,
      ingredient_count: ingredients.length,
    });
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
    logEventFromRequest(req, userId, EventTypes.PROFILE_FREQUENT_MEAL_DELETED, { meal_id: id });
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
    logEventFromRequest(req, userId, EventTypes.PROFILE_RESTRICTIONS_UPDATED, {
      active_flags: Object.entries(body.flags)
        .filter(([, v]) => v)
        .map(([k]) => k),
      flag_count: Object.values(body.flags).filter(Boolean).length,
      has_other: !!body.other,
    });
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
    logEventFromRequest(req, userId, EventTypes.PROFILE_SECTION_VIEWED, { section: "training" });
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
    logEventFromRequest(req, userId, EventTypes.PROFILE_SECTION_VIEWED, { section: "health" });
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
    const updated = await repo.updateBody(userId, patch);
    logEventFromRequest(req, userId, EventTypes.PROFILE_BODY_UPDATED, {
      fields: Object.keys(patch),
      weight_kg: patch.weight_kg ?? null,
      body_fat_pct: patch.body_fat_pct ?? null,
      height_cm: patch.height_cm ?? null,
    });
    res.json(updated);
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
    const updated = await repo.updateActiveInjuries(userId, body.active_injuries);
    logEventFromRequest(req, userId, EventTypes.PROFILE_INJURIES_UPDATED, {
      active_count: body.active_injuries.length,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/:userId/journey
profileRoutes.get("/:userId/journey", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    logEventFromRequest(req, userId, EventTypes.PROFILE_SECTION_VIEWED, { section: "journey" });
    res.json(await repo.getJourney(userId));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/profile/:userId — datos personales (Settings › Datos)
profileRoutes.patch("/:userId", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    const patch = z
      .object({
        name: z.string().min(1).max(120).optional(),
        age: z.number().int().min(16).max(70).optional(),
        sex: z.enum(["M", "F", "X"]).optional(),
        email: z.string().email().max(200).optional(),
        phone_wa: z.string().min(8).max(20).optional(),
        timezone: z.string().min(1).max(60).optional(),
      })
      .parse(req.body);
    const row = await repo.updateIdentity(userId, patch);
    if (!row) throw BadRequest("nada para actualizar");
    logEventFromRequest(req, userId, EventTypes.PROFILE_IDENTITY_UPDATED, {
      fields: Object.keys(patch),
      // Solo loguear que cambio, no los valores nuevos — PII.
    });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/profile/:userId — baja de cuenta (derecho de supresión)
profileRoutes.delete("/:userId", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    const ok = await repo.deleteUser(userId);
    if (!ok) throw NotFound("user not found");
    logger.info("account deleted", { userId });
    // Loguear ANTES de que la FK ON DELETE SET NULL nulee el user_id en
    // system_events. user_id queda como null pero el evento queda con el
    // UUID en el payload para auditoria.
    logEventFromRequest(req, userId, EventTypes.PROFILE_ACCOUNT_DELETED, {
      target_user_id: userId,
      source: "profile_route",
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/:userId/export — ZIP-able JSON con todos los datos
profileRoutes.get("/:userId/export", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    const data = await repo.exportAll(userId);
    logEventFromRequest(req, userId, EventTypes.PROFILE_EXPORTED, {});
    res
      .setHeader("Content-Disposition", `attachment; filename="forja-export-${userId}.json"`)
      .json(data);
  } catch (err) {
    next(err);
  }
});

// PUT /api/profile/:userId/nutrition/plan — editar macros target
profileRoutes.put("/:userId/nutrition/plan", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    const d = z
      .object({
        target_kcal: z.number().min(800).max(8000),
        target_protein_g: z.number().min(0).max(600),
        target_carbs_g: z.number().min(0).max(1200),
        target_fat_g: z.number().min(0).max(400),
        nutritionist_name: z.string().max(120).nullable().optional(),
      })
      .parse(req.body);
    const updated = await repo.updateNutritionPlan(userId, d);
    logEventFromRequest(req, userId, EventTypes.PROFILE_NUTRITION_PLAN_UPDATED, {
      target_kcal: d.target_kcal,
      target_protein_g: d.target_protein_g,
      target_carbs_g: d.target_carbs_g,
      target_fat_g: d.target_fat_g,
      has_nutritionist: d.nutritionist_name != null,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/profile/:userId/nutrition/plan/file — subir PDF del plan
profileRoutes.post("/:userId/nutrition/plan/file", planFileUpload, async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    if (!req.file) throw BadRequest("falta archivo: enviar campo 'file'");
    const saved = await repo.saveProfileNutritionPlanFile(userId, {
      bytes: req.file.buffer,
      mime: req.file.mimetype,
      name: req.file.originalname,
    });
    logger.info("profile nutrition plan uploaded", { userId, bytes: req.file.size });
    logEventFromRequest(req, userId, EventTypes.PROFILE_PLAN_UPLOADED, {
      file_id: saved.file_id,
      bytes: req.file.size,
      mime: req.file.mimetype,
    });
    res.json({ ok: true, id: saved.file_id });
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/:userId/nutrition/plan/file — descargar PDF del plan
profileRoutes.get("/:userId/nutrition/plan/file", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    const f = await repo.getNutritionPlanFileBytes(userId);
    if (!f || !f.raw_file_bytes) throw NotFound("sin plan cargado");
    logEventFromRequest(req, userId, EventTypes.PROFILE_PLAN_DOWNLOADED, {
      bytes: f.raw_file_bytes.length,
      mime: f.raw_file_mime ?? null,
    });
    res
      .setHeader("Content-Type", f.raw_file_mime ?? "application/octet-stream")
      .setHeader("Content-Disposition", `inline; filename="${f.raw_file_name ?? "plan"}"`)
      .send(f.raw_file_bytes);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/profile/:userId/nutrition/plan/file — eliminar PDF del plan
profileRoutes.delete("/:userId/nutrition/plan/file", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    const ok = await repo.deactivateNutritionPlanFile(userId);
    if (!ok) throw NotFound("sin plan cargado");
    logEventFromRequest(req, userId, EventTypes.PROFILE_PLAN_DELETED, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/profile/:userId/medical — crónicas / medicación / alergias / pasadas
profileRoutes.put("/:userId/medical", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    const body = z
      .object({
        chronic_conditions: z.array(z.string().max(200)).optional(),
        allergies: z.array(z.string().max(200)).optional(),
        medications: z
          .array(z.object({ name: z.string().max(120), dose: z.string().max(80), schedule: z.string().max(120) }))
          .optional(),
        past_injuries: z.array(z.unknown()).optional(),
        active_injuries: z.array(z.unknown()).optional(),
      })
      .parse(req.body);
    const row = await repo.updateMedical(userId, body as Record<string, unknown[]>);
    if (!row) throw BadRequest("nada para actualizar");
    logEventFromRequest(req, userId, EventTypes.PROFILE_MEDICAL_UPDATED, {
      fields: Object.keys(body),
      chronic_count: body.chronic_conditions?.length,
      allergies_count: body.allergies?.length,
      medications_count: body.medications?.length,
      past_injuries_count: body.past_injuries?.length,
      active_injuries_count: body.active_injuries?.length,
    });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/:userId/documents — lista de documentos clínicos
profileRoutes.get("/:userId/documents", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    logEventFromRequest(req, userId, EventTypes.PROFILE_SECTION_VIEWED, { section: "documents" });
    res.json({ documents: await repo.listMedicalDocuments(userId) });
  } catch (err) {
    next(err);
  }
});

const DOC_SLOTS = ["ecg", "xray", "blood_work", "medical_clearance", "other"] as const;

// POST /api/profile/:userId/documents — subir documento clínico
profileRoutes.post("/:userId/documents", planFileUpload, async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    if (!req.file) throw BadRequest("falta archivo: enviar campo 'file'");
    const meta = z
      .object({
        slot: z.enum(DOC_SLOTS),
        doc_type: z.string().min(1).max(80),
      })
      .parse({ slot: req.body.slot, doc_type: req.body.doc_type });
    const doc = await repo.createMedicalDocument(userId, {
      slot: meta.slot,
      doc_type: meta.doc_type,
      bytes: req.file.buffer,
      mime: req.file.mimetype,
      name: req.file.originalname,
      size: req.file.size,
    });
    logger.info("medical document uploaded", { userId, slot: meta.slot, id: doc.id });
    logEventFromRequest(req, userId, EventTypes.PROFILE_DOC_UPLOADED, {
      document_id: doc.id,
      slot: meta.slot,
      doc_type: meta.doc_type,
      bytes: req.file.size,
      mime: req.file.mimetype,
    });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/:userId/documents/:id/file — descargar documento
profileRoutes.get("/:userId/documents/:id/file", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    const id = uuid.parse(req.params.id);
    await ensureUser(userId);
    const f = await repo.getMedicalDocumentBytes(userId, id);
    if (!f) throw NotFound("documento no encontrado");
    logEventFromRequest(req, userId, EventTypes.PROFILE_DOC_DOWNLOADED, {
      document_id: id,
      bytes: f.raw_file_bytes.length,
      mime: f.raw_file_mime,
    });
    res
      .setHeader("Content-Type", f.raw_file_mime)
      .setHeader("Content-Disposition", `inline; filename="${f.raw_file_name}"`)
      .send(f.raw_file_bytes);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/profile/:userId/documents/:id — eliminar documento
profileRoutes.delete("/:userId/documents/:id", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    const id = uuid.parse(req.params.id);
    await ensureUser(userId);
    const ok = await repo.deleteMedicalDocument(userId, id);
    if (!ok) throw NotFound("documento no encontrado");
    logEventFromRequest(req, userId, EventTypes.PROFILE_DOC_DELETED, { document_id: id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/:userId/preferences — recordatorios / tono / privacidad
profileRoutes.get("/:userId/preferences", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    logEventFromRequest(req, userId, EventTypes.PROFILE_SECTION_VIEWED, { section: "preferences" });
    res.json(await repo.getPreferences(userId));
  } catch (err) {
    next(err);
  }
});

// PUT /api/profile/:userId/preferences
profileRoutes.put("/:userId/preferences", async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    await ensureUser(userId);
    const prefs = z.record(z.unknown()).parse(req.body);
    const updated = await repo.upsertPreferences(userId, prefs);
    logEventFromRequest(req, userId, EventTypes.PROFILE_PREFERENCES_UPDATED, {
      keys: Object.keys(prefs),
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});
