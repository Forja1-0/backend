/**
 * Extrae IP y User-Agent del request. Respeta X-Forwarded-For (un proxy/nginx
 * delante en prod). Devuelve null cuando no se pudo determinar — null va
 * directo a la columna INET/TEXT sin romper INSERTs.
 */
import type { Request } from "express";

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export function getClientInfo(req: Request): ClientInfo {
  const xff = req.headers["x-forwarded-for"];
  const xffHead = Array.isArray(xff) ? xff[0] : typeof xff === "string" ? xff.split(",")[0] : null;
  const ip = (xffHead ?? req.socket.remoteAddress ?? "").trim() || null;
  const ua = req.headers["user-agent"]?.toString() ?? null;
  return { ip, userAgent: ua };
}
