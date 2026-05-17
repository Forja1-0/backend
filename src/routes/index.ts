import { Router } from "express";
import { healthRoutes } from "./health.routes.js";
import { onboardingRoutes } from "./onboarding.routes.js";
import { foodRoutes } from "./food.routes.js";
import { profileRoutes } from "./profile.routes.js";

export const apiRouter = Router();

apiRouter.use(healthRoutes);
apiRouter.use("/api/onboarding", onboardingRoutes);
apiRouter.use("/api/food", foodRoutes);
apiRouter.use("/api/profile", profileRoutes);
