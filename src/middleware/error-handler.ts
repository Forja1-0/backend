import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import multer from "multer";
import { HttpError } from "../utils/errors.js";
import { PdfParseError } from "../services/plan-pdf-parser.service.js";
import { logger } from "../config/logger.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "validation_error", issues: err.issues });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof multer.MulterError) {
    const map: Record<string, string> = {
      LIMIT_FILE_SIZE: "archivo demasiado grande",
      LIMIT_FILE_COUNT: "solo se permite un archivo",
      LIMIT_UNEXPECTED_FILE: "campo de archivo inesperado (esperado: 'file')",
    };
    res.status(400).json({ error: map[err.code] ?? "upload_error", details: { code: err.code } });
    return;
  }
  if (err instanceof PdfParseError) {
    res.status(422).json({ error: err.message });
    return;
  }
  logger.error("unhandled error", { err });
  res.status(500).json({ error: "internal_error" });
};
