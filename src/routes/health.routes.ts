import { Router } from "express";
import { query } from "../config/db.js";
import { getInstanceStatus } from "../services/evolution.service.js";

export const healthRoutes = Router();

const healthHandler = (_req: any, res: any) => res.json({ ok: true, ts: new Date().toISOString() });
healthRoutes.get("/health", healthHandler);
healthRoutes.get("/healthz", healthHandler);

healthRoutes.get("/health/deep", async (_req, res) => {
  const out: Record<string, unknown> = { ok: true };
  try {
    const r = await query<{ now: Date }>("SELECT now()");
    out.db = { ok: true, now: r.rows[0].now };
  } catch (err) {
    out.ok = false;
    out.db = { ok: false, error: (err as Error).message };
  }
  try {
    out.evolution = await getInstanceStatus();
  } catch (err) {
    out.ok = false;
    out.evolution = { ok: false, error: (err as Error).message };
  }
  res.status(out.ok ? 200 : 503).json(out);
});
