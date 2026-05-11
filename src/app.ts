import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { apiRouter } from "./routes/index.js";
import { evolutionWebhook } from "./webhooks/evolution.webhook.js";
import { errorHandler } from "./middleware/error-handler.js";

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS.split(",").filter(Boolean) }));
app.use(compression());
app.use(express.json({ limit: "2mb" }));

app.use((req, _res, next) => {
  logger.debug("request", { method: req.method, path: req.path });
  next();
});

app.use("/webhook", evolutionWebhook);
app.use("/", apiRouter);

app.use(errorHandler);
