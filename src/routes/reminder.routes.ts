import { Router } from "express";
import { z } from "zod";
import cron from "node-cron";
import * as repo from "../repositories/reminder.repo.js";
import { BadRequest, NotFound } from "../utils/errors.js";
import { requireAuth, enforcePathUserMatchesSession } from "../middleware/require-auth.js";
import { logEventFromRequest, EventTypes } from "../services/events.service.js";

/**
 * CRUD de recordatorios configurables por el usuario.
 *
 * Cada recordatorio es un cron job atado al user: cron_expr libre,
 * mensaje libre, y un cron del backend (reminders.cron.ts) corre cada
 * minuto evaluando que dispara.
 *
 * Validamos cron_expr con node-cron antes de persistir para evitar
 * crons rotos que el tick ignoraria silenciosamente.
 *
 * Auth: igual que profile — Bearer + userId del path debe coincidir
 * con la sesion (sin IDOR).
 */
export const reminderRoutes = Router();

reminderRoutes.use(requireAuth);
reminderRoutes.use("/:userId/reminders", enforcePathUserMatchesSession);

const createBody = z.object({
  label: z.string().min(1).max(80),
  message: z.string().min(1).max(500),
  cron_expr: z.string().min(5).max(120),
  active: z.boolean().optional(),
});

const patchBody = z.object({
  label: z.string().min(1).max(80).optional(),
  message: z.string().min(1).max(500).optional(),
  cron_expr: z.string().min(5).max(120).optional(),
  active: z.boolean().optional(),
});

function assertCron(expr: string) {
  if (!cron.validate(expr)) {
    throw BadRequest(`cron_expr invalida: "${expr}"`);
  }
}

// GET /api/users/:userId/reminders
reminderRoutes.get("/:userId/reminders", async (req, res, next) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const rows = await repo.listForUser(userId);
    logEventFromRequest(req, userId, EventTypes.PROFILE_SECTION_VIEWED, {
      section: "reminders",
      count: rows.length,
    });
    res.json({ ok: true, reminders: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:userId/reminders
reminderRoutes.post("/:userId/reminders", async (req, res, next) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const body = createBody.parse(req.body);
    assertCron(body.cron_expr);
    const row = await repo.create({
      user_id: userId,
      label: body.label,
      message: body.message,
      cron_expr: body.cron_expr,
      active: body.active,
    });
    logEventFromRequest(req, userId, EventTypes.REMINDER_CREATED, {
      reminder_id: row.id,
      cron_expr: row.cron_expr,
    });
    res.status(201).json({ ok: true, reminder: row });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/users/:userId/reminders/:id
reminderRoutes.patch("/:userId/reminders/:id", async (req, res, next) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const id = z.string().uuid().parse(req.params.id);
    const patch = patchBody.parse(req.body);
    if (patch.cron_expr !== undefined) assertCron(patch.cron_expr);
    const row = await repo.update(id, userId, patch);
    if (!row) throw NotFound("reminder not found");
    logEventFromRequest(req, userId, EventTypes.REMINDER_UPDATED, {
      reminder_id: id,
      changed: Object.keys(patch),
    });
    res.json({ ok: true, reminder: row });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/users/:userId/reminders/:id
reminderRoutes.delete("/:userId/reminders/:id", async (req, res, next) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const id = z.string().uuid().parse(req.params.id);
    const ok = await repo.remove(id, userId);
    if (!ok) throw NotFound("reminder not found");
    logEventFromRequest(req, userId, EventTypes.REMINDER_DELETED, {
      reminder_id: id,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
