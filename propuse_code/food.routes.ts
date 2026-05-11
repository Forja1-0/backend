import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as foodRepo from '../repositories/food.repo';

const router = Router();

// GET /api/food/search?q=pollo&limit=10
router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = z.string().min(2).max(100).parse(req.query.q);
    const limit = z.coerce.number().int().min(1).max(30).default(10).parse(req.query.limit ?? 10);

    const items = await foodRepo.searchFood(q, limit);
    res.json({ items, count: items.length });
  } catch (err) { next(err); }
});

// GET /api/food/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const item = await foodRepo.getFoodById(id);
    if (!item) {
      res.status(404).json({ error: 'Food item not found' });
      return;
    }
    res.json(item);
  } catch (err) { next(err); }
});

export default router;
