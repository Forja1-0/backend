import { describe, expect, it } from "vitest";
import { parseMealItems, prepareMealText, splitItems } from "../../src/bot/parser/meal-items.js";

// El bot recibe el texto ya pasado por normalize() (lowercase, sin acentos).

describe("splitItems", () => {
  it("separa por 'y'", () => {
    expect(splitItems("200g de milanesa de vaca y 150g de fideos")).toEqual([
      "200g de milanesa de vaca",
      "150g de fideos",
    ]);
  });
  it("separa por 'con'", () => {
    expect(splitItems("2 milanesas con pure")).toEqual(["2 milanesas", "pure"]);
  });
  it("no parte 'milanesa de vaca' (de no es separador)", () => {
    expect(splitItems("milanesa de vaca")).toEqual(["milanesa de vaca"]);
  });
});

describe("prepareMealText — separadores que normalize() borra", () => {
  it("separa ítems por punto (caso real que rompía)", () => {
    const t = prepareMealText("comí 4 scups de whey. 4 huevos. 100g de fideos cocidos");
    expect(splitItems(t)).toEqual([
      "comi 4 scups de whey",
      "4 huevos",
      "100 g de fideos cocidos",
    ]);
  });

  it("separa por punto, coma, ';' y '+'", () => {
    expect(splitItems(prepareMealText("2 huevos, pan; queso + jamon"))).toEqual([
      "2 huevos",
      "pan",
      "queso",
      "jamon",
    ]);
  });

  it("NO rompe decimales 1.5 / 1,5", () => {
    expect(prepareMealText("1.5 kg de pollo")).toBe("1.5 kg de pollo");
    expect(prepareMealText("1,5 kg de pollo")).toBe("1,5 kg de pollo");
  });

  it('"4scups" pegado → "4 scups"', () => {
    expect(prepareMealText("consumo 4scups de whey")).toBe("consumo 4 scups de whey");
  });

  it("el caso real parsea 3 ítems con scoop + verbo 'consumo'", () => {
    const items = parseMealItems(
      prepareMealText("consumo 4 scups de whey. 4 huevo. 100g de fideos"),
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ mode: "measure", qty: 4, measure: "scup", food: "whey" });
    expect(items[1]).toMatchObject({ mode: "units", qty: 4, food: "huevo" });
    expect(items[2]).toMatchObject({ mode: "grams", qty: 100, food: "fideos" });
  });
});

describe("parseMealItems — bug central: número sin 'g' = unidades", () => {
  it('"2 milanesas" → 2 UNIDADES, no 2 gramos', () => {
    const [it] = parseMealItems("2 milanesas");
    expect(it.mode).toBe("units");
    expect(it.qty).toBe(2);
    expect(it.food).toBe("milanesas");
  });

  it('"3 huevos" → 3 unidades', () => {
    const [it] = parseMealItems("3 huevos");
    expect(it).toMatchObject({ mode: "units", qty: 3, food: "huevos" });
  });

  it('"200g de arroz crudo" → gramos explícitos', () => {
    const [it] = parseMealItems("200g de arroz crudo");
    expect(it).toMatchObject({ mode: "grams", qty: 200, food: "arroz crudo" });
  });

  it('"150g de fideos crudos" → gramos', () => {
    const [it] = parseMealItems("150g de fideos crudos");
    expect(it).toMatchObject({ mode: "grams", qty: 150, food: "fideos crudos" });
  });

  it("kg se convierte a gramos", () => {
    const [it] = parseMealItems("1.5 kg de pollo");
    expect(it).toMatchObject({ mode: "grams", qty: 1500, food: "pollo" });
  });
});

describe("parseMealItems — medidas caseras", () => {
  it('"un plato de arroz" → measure plato', () => {
    const [it] = parseMealItems("un plato de arroz");
    expect(it).toMatchObject({ mode: "measure", qty: 1, measure: "plato", food: "arroz" });
  });

  it('"2 fetas de jamon cocido" → measure feta x2', () => {
    const [it] = parseMealItems("2 fetas de jamon cocido");
    expect(it).toMatchObject({ mode: "measure", qty: 2, measure: "feta", food: "jamon cocido" });
  });

  it('"medio plato de fideos" → qty 0.5', () => {
    const [it] = parseMealItems("medio plato de fideos");
    expect(it).toMatchObject({ mode: "measure", qty: 0.5, measure: "plato", food: "fideos" });
  });
});

describe("parseMealItems — multi-item + verbo", () => {
  it('"200g de milanesa de vaca y 150g de fideos" → 2 items', () => {
    const items = parseMealItems("200g de milanesa de vaca y 150g de fideos");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ mode: "grams", qty: 200, food: "milanesa de vaca" });
    expect(items[1]).toMatchObject({ mode: "grams", qty: 150, food: "fideos" });
  });

  it('"almorce milanesa con pure" → strip verbo + 2 items bare', () => {
    const items = parseMealItems("almorce milanesa con pure");
    expect(items.map((i) => ({ mode: i.mode, food: i.food }))).toEqual([
      { mode: "bare", food: "milanesa" },
      { mode: "bare", food: "pure" },
    ]);
  });

  it('"2 milanesas con pure" → units + bare', () => {
    const items = parseMealItems("2 milanesas con pure");
    expect(items[0]).toMatchObject({ mode: "units", qty: 2, food: "milanesas" });
    expect(items[1]).toMatchObject({ mode: "bare", qty: 1, food: "pure" });
  });

  it('"pure" solo → bare qty 1', () => {
    const [it] = parseMealItems("pure");
    expect(it).toMatchObject({ mode: "bare", qty: 1, food: "pure" });
  });
});
