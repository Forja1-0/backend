import { describe, expect, it } from "vitest";
import { parseWeightKg } from "../src/bot/parser/weight-parse.js";

describe("parseWeightKg", () => {
  it("keyword + número", () => {
    expect(parseWeightKg("peso 82")).toBe(82);
    expect(parseWeightKg("peso: 100")).toBe(100);
    expect(parseWeightKg("me pesé 79.5")).toBe(79.5);
    expect(parseWeightKg("peso hoy 88.2")).toBe(88.2);
    expect(parseWeightKg("estoy en 95")).toBe(95);
  });

  it("coma decimal", () => {
    expect(parseWeightKg("82,3 kg")).toBe(82.3);
    expect(parseWeightKg("peso 79,8")).toBe(79.8);
  });

  it("número + unidad de masa", () => {
    expect(parseWeightKg("82.5 kg")).toBe(82.5);
    expect(parseWeightKg("79 kilos")).toBe(79);
    expect(parseWeightKg("100kg")).toBe(100);
  });

  it("descarta cantidades de comida en gramos / unidades chicas", () => {
    expect(parseWeightKg("comí 200g de pollo")).toBeNull();
    expect(parseWeightKg("comí 1 kg de sandía")).toBeNull(); // 1 dígito < 2
    expect(parseWeightKg("tomé 2 litros de agua")).toBeNull();
  });

  it("descarta fuera de rango y ruido", () => {
    expect(parseWeightKg("peso 12")).toBeNull(); // < 25
    expect(parseWeightKg("peso 999")).toBeNull(); // > 400
    expect(parseWeightKg("hola que tal")).toBeNull();
    expect(parseWeightKg("")).toBeNull();
  });
});
