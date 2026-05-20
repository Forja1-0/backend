/**
 * Middleware que valida el `Authorization: Bearer <session_token>` del
 * web_profile. Si la sesion es valida, attachea `req.auth = { userId, sessionId }`
 * y deja seguir. Si no, devuelve 401.
 *
 * Tambien soporta `Authorization` ausente y mando del token via cookie a
 * futuro — por ahora solo header para mantenerlo explicito.
 *
 * Se aplica selectivamente sobre las rutas que tocan datos del usuario
 * (profile.routes etc.). El healthz y el endpoint de consume no lo usan.
 */
import type { Request, Response, NextFunction } from "express";
import { lookupSession } from "../services/auth-token.service.js";
import { getClientInfo } from "../utils/client-info.js";

declare module "express-serve-static-core" {
  interface Request {
    auth?: { userId: string; sessionId: string };
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    res.status(401).json({ error: "unauthorized", details: { reason: "missing_token" } });
    return;
  }
  const { ip, userAgent } = getClientInfo(req);
  const session = await lookupSession(match[1].trim(), { ip, userAgent });
  if (!session) {
    res.status(401).json({ error: "unauthorized", details: { reason: "invalid_or_expired" } });
    return;
  }
  req.auth = session;
  next();
}

/**
 * Guard adicional para rutas que reciben `:userId` en path: el user del
 * path tiene que coincidir con el de la sesion. Sino un atacante con una
 * sesion valida podria pedir /api/profile/<otro-uuid>/... y leer todo.
 */
export function enforcePathUserMatchesSession(req: Request, res: Response, next: NextFunction): void {
  const pathUserId = req.params.userId ?? req.params.id;
  if (!req.auth) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (pathUserId && pathUserId !== req.auth.userId) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}
