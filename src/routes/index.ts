import { Router } from "express";
import { healthRoutes } from "./health.routes.js";
import { onboardingRoutes } from "./onboarding.routes.js";
import { foodRoutes } from "./food.routes.js";
import { profileRoutes } from "./profile.routes.js";
import { authRoutes } from "./auth.routes.js";
import { reminderRoutes } from "./reminder.routes.js";

export const apiRouter = Router();

apiRouter.use(healthRoutes);
apiRouter.use("/api/auth", authRoutes);
apiRouter.use("/api/onboarding", onboardingRoutes);
apiRouter.use("/api/food", foodRoutes);
apiRouter.use("/api/profile", profileRoutes);
apiRouter.use("/api/users", reminderRoutes);
