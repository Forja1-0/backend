import { Router } from "express";
import { z } from "zod";
import { stepSchemas, consentSchema } from "../schemas/onboarding.schema.js";
import * as repo from "../repositories/onboarding.repo.js";
import { BadRequest, NotFound } from "../utils/errors.js";
import { logger } from "../config/logger.js";

export const onboardingRoutes = Router();

const startBody = z.object({
  email: z.string().email().max(200).nullable().optional(),
  phone_wa: z.string().min(8).max(20).nullable().optional(),
});

// POST /api/onboarding/start
onboardingRoutes.post("/start", async (req, res, next) => {
  try {
    const body = startBody.parse(req.body ?? {});
    const user = await repo.createUser(body);
    logger.info({ userId: user.id }, "onboarding started");
    res.status(201).json({
      user_id: user.id,
      onboarding_step: user.onboarding_step,
      active: user.active,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/onboarding/:userId/step/:n
onboardingRoutes.put("/:userId/step/:n", async (req, res, next) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const stepNum = z.coerce.number().int().min(1).max(7).parse(req.params.n);

    const user = await repo.getUser(userId);
    if (!user) throw NotFound("user not found");

    const schema = stepSchemas[stepNum];
    if (!schema) throw BadRequest(`invalid step: ${stepNum}`);
    const data = schema.parse(req.body);

    let result: unknown;
    switch (stepNum) {
      case 1: result = await repo.saveStep1(userId, data as any); break;
      case 2: result = await repo.saveStep2(userId, data as any); break;
      case 3: result = await repo.saveStep3(userId, data as any); break;
      case 4: result = await repo.saveStep4(userId, data as any); break;
      case 5: result = await repo.saveStep5(userId, data as any); break;
      case 6: result = await repo.saveStep6(userId, data as any); break;
      case 7: result = await repo.saveStep7(userId, data as any); break;
    }

    logger.info({ userId, step: stepNum }, "onboarding step saved");
    res.json({ ok: true, step: stepNum, result });
  } catch (err) {
    next(err);
  }
});

// POST /api/onboarding/:userId/consent
onboardingRoutes.post("/:userId/consent", async (req, res, next) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const user = await repo.getUser(userId);
    if (!user) throw NotFound("user not found");

    const data = consentSchema.parse(req.body);
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";
    const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;

    const consent = await repo.saveConsent(userId, data, ip, userAgent);
    logger.info({ userId }, "consent saved");

    res.json({ ok: true, consented_at: consent.consented_at });
  } catch (err) {
    next(err);
  }
});

// GET /api/onboarding/:userId
onboardingRoutes.get("/:userId", async (req, res, next) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const user = await repo.getUser(userId);
    if (!user) throw NotFound("user not found");
    res.json({
      user_id: user.id,
      name: user.name,
      email: user.email,
      phone_wa: user.phone_wa,
      onboarding_step: user.onboarding_step,
      active: user.active,
    });
  } catch (err) {
    next(err);
  }
});
