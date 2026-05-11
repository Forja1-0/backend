import { Router } from "express";
import { z } from "zod";
import * as foodRepo from "../repositories/food.repo.js";
import { NotFound } from "../utils/errors.js";

export const foodRoutes = Router();

// GET /api/food/search?q=pollo&limit=10
foodRoutes.get("/search", async (req, res, next) => {
  try {
    const q = z.string().min(2).max(100).parse(req.query.q);
    const limit = z.coerce.number().int().min(1).max(30).default(10).parse(req.query.limit ?? 10);
    const items = await foodRepo.searchFood(q, limit);
    res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/food/:id
foodRoutes.get("/:id", async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const item = await foodRepo.getFoodById(id);
    if (!item) throw NotFound("food item not found");
    res.json(item);
  } catch (err) {
    next(err);
  }
});
