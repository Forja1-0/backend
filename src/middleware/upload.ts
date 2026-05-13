// Multer en memoria para subidas de planes (PDF / imagen). El archivo nunca
// toca disco: se guarda como BYTEA en Postgres. Limite y mimes vienen de env.

import multer from "multer";
import { env } from "../config/env.js";
import { BadRequest } from "../utils/errors.js";

const ACCEPTED_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export const planFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_FILE_SIZE, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ACCEPTED_MIMES.has(file.mimetype)) cb(null, true);
    else cb(BadRequest(`tipo no soportado: ${file.mimetype}`));
  },
}).single("file");
