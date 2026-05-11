import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  stepSchemas, consentSchema,
} from '../schemas/onboarding.schema';
import * as repo from '../repositories/onboarding.repo';
import { BadRequest, NotFound } from '../utils/errors';
import { logger } from '../config/logger';

const router = Router();

// ── POST /api/onboarding/start ────────────────────────────
// Creates a user shell. Optionally pass phone_wa if known.
router.post('/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      phone_wa: z.string().min(8).max(20).nullable().optional(),
    }).parse(req.body);

    const user = await repo.createUser(body.phone_wa ?? null);
    logger.info({ userId: user.id }, 'Onboarding started');

    res.status(201).json({
      user_id: user.id,
      onboarding_step: user.onboarding_step,
      status: user.status,
    });
  } catch (err) { next(err); }
});

// ── PUT /api/onboarding/:userId/step/:n ───────────────────
// Saves data for step 1-7. Validates with the step-specific Zod schema.
router.put('/:userId/step/:n', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const stepNum = z.coerce.number().int().min(1).max(7).parse(req.params.n);

    // Validate user exists
    const user = await repo.getUser(userId);
    if (!user) throw new NotFound('User not found');

    // Validate body against step schema
    const schema = stepSchemas[stepNum];
    if (!schema) throw new BadRequest(`Invalid step: ${stepNum}`);
    const data = schema.parse(req.body);

    // Save step
    let result: unknown;
    switch (stepNum) {
      case 1: result = await repo.saveStep1(userId, data); break;
      case 2: result = await repo.saveStep2(userId, data); break;
      case 3: result = await repo.saveStep3(userId, data); break;
      case 4: result = await repo.saveStep4(userId, data); break;
      case 5: result = await repo.saveStep5(userId, data); break;
      case 6: result = await repo.saveStep6(userId, data); break;
      case 7: result = await repo.saveStep7(userId, data); break;
    }

    logger.info({ userId, step: stepNum }, 'Onboarding step saved');
    res.json({ ok: true, step: stepNum, result });
  } catch (err) { next(err); }
});

// ── POST /api/onboarding/:userId/consent ──────────────────
router.post('/:userId/consent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const user = await repo.getUser(userId);
    if (!user) throw new NotFound('User not found');

    const data = consentSchema.parse(req.body);
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || 'unknown';

    const consent = await repo.saveConsent(userId, data, ip);
    logger.info({ userId }, 'Consent saved, user activated');

    res.json({ ok: true, consented_at: consent.consented_at });
  } catch (err) { next(err); }
});

// ── GET /api/onboarding/:userId ───────────────────────────
// Returns current onboarding progress
router.get('/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const user = await repo.getUser(userId);
    if (!user) throw new NotFound('User not found');

    res.json({
      user_id: user.id,
      name: user.name,
      onboarding_step: user.onboarding_step,
      status: user.status,
    });
  } catch (err) { next(err); }
});

export default router;
