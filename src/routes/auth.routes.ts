/**
 * Auth routes para el flujo WhatsApp -> web_profile.
 *
 *   POST /api/auth/consume   body: { token }
 *      -> 200 { session_token, expires_at, user_id }
 *      -> 401 { error: "invalid_or_expired", reason }
 *
 *   POST /api/auth/logout    requireAuth
 *      -> 200 { ok: true }   (revoca la sesion actual)
 *
 *   GET  /api/auth/me        requireAuth
 *      -> 200 { user_id, session_id }
 *
 * Rate limit aplicado al consume para evitar enumeracion de tokens.
 * Cada fallo se loguea en `events` (auth.token_failed) — la IP queda
 * registrada para analytics y deteccion de abuso.
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  consumeWhatsappToken,
  revokeSession,
  TokenConsumeError,
} from "../services/auth-token.service.js";
import { logEvent } from "../services/events.service.js";
import { getClientInfo } from "../utils/client-info.js";
import { requireAuth } from "../middleware/require-auth.js";
import { BadRequest } from "../utils/errors.js";

export const authRoutes = Router();

// 10 intentos / IP / 15min. Si alguien quiere brute-forcear el token, vamos
// a notar el spike en `events` mucho antes de que tenga chance.
const consumeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_attempts" },
});

const ConsumeSchema = z.object({
  token: z.string().min(6).max(64),
});

authRoutes.post("/consume", consumeLimiter, async (req, res, next) => {
  try {
    const parsed = ConsumeSchema.safeParse(req.body);
    if (!parsed.success) throw BadRequest("invalid_body", parsed.error.issues);

    const { ip, userAgent } = getClientInfo(req);

    try {
      const out = await consumeWhatsappToken(parsed.data.token, { ip, userAgent });
      await logEvent({
        userId: out.userId,
        type: "auth.token_consumed",
        payload: { session_expires_at: out.sessionExpiresAt.toISOString() },
        ip,
        userAgent,
      });
      await logEvent({
        userId: out.userId,
        type: "auth.session_started",
        payload: {},
        ip,
        userAgent,
      });
      res.json({
        session_token: out.sessionToken,
        expires_at: out.sessionExpiresAt.toISOString(),
        user_id: out.userId,
      });
    } catch (err) {
      if (err instanceof TokenConsumeError) {
        await logEvent({
          userId: null,
          type: "auth.token_failed",
          payload: { reason: err.reason, token_prefix: parsed.data.token.slice(0, 3) },
          ip,
          userAgent,
        });
        res.status(401).json({ error: "invalid_or_expired", details: { reason: err.reason } });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

authRoutes.post("/logout", requireAuth, async (req, res, next) => {
  try {
    if (!req.auth) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    await revokeSession(req.auth.sessionId);
    const { ip, userAgent } = getClientInfo(req);
    await logEvent({
      userId: req.auth.userId,
      type: "auth.session_ended",
      payload: { session_id: req.auth.sessionId },
      ip,
      userAgent,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRoutes.get("/me", requireAuth, (req, res) => {
  res.json({ user_id: req.auth!.userId, session_id: req.auth!.sessionId });
});
