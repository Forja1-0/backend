import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

type Source = "body" | "query" | "params";

export const validate = (schema: ZodSchema, source: Source = "body"): RequestHandler =>
  (req, _res, next) => {
    const parsed = schema.parse(req[source]);
    (req as any)[source] = parsed;
    next();
  };
