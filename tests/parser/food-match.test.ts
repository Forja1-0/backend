import { describe, expect, it } from "vitest";
import { coverage } from "../../src/bot/parser/food-match.js";

describe("food-match coverage", () => {
  it("matches singular query to singular name", () => {
    expect(coverage("milanesa", "Milanesa de carne vacuna")).toBe(1.0);
  });

  it("matches plural query to singular name", () => {
    expect(coverage("milanesas", "Milanesa de carne vacuna")).toBe(1.0);
  });

  it("matches singular query to plural name in any position", () => {
    expect(coverage("fideo", "Fideos de arroz, sin tacc, crudos")).toBe(1.0);
  });

  it("matches plural query to plural name", () => {
    expect(coverage("fideos", "Fideos de arroz, sin tacc, crudos")).toBe(1.0);
  });

  it("filters stopwords and short tokens", () => {
    expect(coverage("fideos con arroz", "Fideos secos, con arroz integral")).toBe(1.0);
  });

  it("handles empty queries gracefully", () => {
    expect(coverage("", "Fideos secos")).toBe(0.0);
  });

  it("calculates partial coverage correctly", () => {
    // 1 of 2 tokens matched ("arroz" matches, "pollo" does not)
    expect(coverage("arroz con pollo", "Arroz blanco crudo")).toBe(0.5);
  });
});
