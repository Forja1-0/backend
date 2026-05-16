import { describe, expect, it } from "vitest";
import {
  rawToCooked,
  cookedToRaw,
  isStatefulFood,
} from "../../src/bot/parser/cooking-factors.js";

describe("cooking-factors", () => {
  it("arroz 70g crudo → ~230g cocido (Atlas UBA)", () => {
    expect(rawToCooked("Arroz blanco crudo", 70)).toBe(230);
  });

  it("fideos secos genéricos 100g → 250g cocido (factor moñitos 2.5)", () => {
    expect(rawToCooked("Fideos secos de trigo", 100)).toBe(250);
  });

  it("tallarines secos 100g → 270g cocido (factor 2.7)", () => {
    expect(rawToCooked("Fideos tallarines secos", 100)).toBe(270);
  });

  it("ñoquis factor 1.2", () => {
    expect(rawToCooked("noquis de papa", 200)).toBe(240);
  });

  it("cookedToRaw es la inversa aproximada", () => {
    expect(cookedToRaw("arroz blanco", 230)).toBe(70);
  });

  it("sin factor conocido → mismos gramos", () => {
    expect(rawToCooked("pechuga de pollo", 200)).toBe(200);
  });

  it("isStatefulFood: arroz/fideos sí, manzana no", () => {
    expect(isStatefulFood("arroz")).toBe(true);
    expect(isStatefulFood("fideos secos")).toBe(true);
    expect(isStatefulFood("manzana")).toBe(false);
  });
});
