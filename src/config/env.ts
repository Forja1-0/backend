import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  EVOLUTION_API_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_INSTANCE: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  CORS_ORIGINS: z.string().default(""),
  LANDING_URL: z.string().url().optional(),
  ONBOARDING_URL: z.string().url().optional(),
  WEB_PROFILE_URL: z.string().url().default("https://pedro-proyecto-web-profile.l7on3x.easypanel.host"),
  TZ: z.string().default("America/Argentina/Buenos_Aires"),
  UPLOAD_DIR: z.string().default("./data/uploads"),
  MAX_FILE_SIZE: z.coerce.number().default(10485760),
});

export const env = schema.parse(process.env);
