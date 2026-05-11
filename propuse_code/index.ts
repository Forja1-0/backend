import { Router } from 'express';
import onboardingRoutes from './onboarding.routes';
import foodRoutes from './food.routes';
import healthRoutes from './health.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/api/onboarding', onboardingRoutes);
router.use('/api/food', foodRoutes);

export default router;
