import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ExpressionError,
  analyzeSpec,
  evaluateExpression,
  expressionDependencies,
  paramKey,
  resolveModel,
  resolveParameters,
  validateSpec,
  type FamilySpec,
} from "../src/index.js";

const lookup = (values: Record<string, number>) => (name: string) => {
  const key = paramKey(name);
  const entry = Object.entries(values).find(([candidate]) => candidate.toLowerCase() === key);
  if (!entry) throw new ExpressionError(`Unknown parameter "${name}"`);
  return entry[1];
};

describe("expression language", () => {
  it("evaluates arithmetic with precedence", () => {
    expect(evaluateExpression("1 + 2 * 3", lookup({}))).toBe(7);
    expect(evaluateExpression("(1 + 2) * 3", lookup({}))).toBe(9);
    expect(evaluateExpression("10 / 4 - 1", lookup({}))).toBeCloseTo(1.5);
    expect(evaluateExpression("2 ^ 3 ^ 2", lookup({}))).toBe(512);
    expect(evaluateExpression("-2 * -3", lookup({}))).toBe(6);
  });

  it("resolves bracketed parameter references", () => {
    const values = lookup({ "Casing Length": 1910, "Flange Width": 30 });
    expect(evaluateExpression("[Casing Length] + 2 * [Flange Width]", values)).toBe(1970);
    expect(evaluateExpression("[casing length] / 2", values)).toBe(955);
  });

  it("supports revit compatible functions and degrees", () => {
    expect(evaluateExpression("round(2.5)", lookup({}))).toBe(3);
    expect(evaluateExpression("round(2.44, 1)", lookup({}))).toBeCloseTo(2.4);
    expect(evaluateExpression("roundup(2.1)", lookup({}))).toBe(3);
    expect(evaluateExpression("rounddown(2.9)", lookup({}))).toBe(2);
    expect(evaluateExpression("sqrt(16)", lookup({}))).toBe(4);
    expect(evaluateExpression("sin(30)", lookup({}))).toBeCloseTo(0.5);
    expect(evaluateExpression("pi", lookup({}))).toBeCloseTo(Math.PI);
  });

  it("reports useful errors", () => {
    expect(() => evaluateExpression("1 / 0", lookup({}))).toThrow(/zero/i);
    expect(() => evaluateExpression("[Missing] * 2", lookup({}))).toThrow(/Unknown parameter/);
    expect(() => evaluateExpression("1 +", lookup({}))).toThrow(ExpressionError);
    expect(() => evaluateExpression("nope(1)", lookup({}))).toThrow(/Unknown function/);
  });

  it("lists dependencies and understands unit literals", () => {
    expect(expressionDependencies("[A] + [B] * 2").sort()).toEqual(["A", "B"]);
    expect(evaluateExpression("[A] - 50mm", lookup({ A: 500 }))).toBe(450);
    expect(evaluateExpression("1in + 1ft", lookup({}))).toBeCloseTo(330.2, 6);
    expect(() => evaluateExpression("10parsecs", lookup({}))).toThrow(/Unknown unit/);
  });
});

describe("parameter resolution", () => {
  it("resolves formula chains in dependency order", () => {
    const result = resolveParameters([
      { name: "Length", type: "Length", value: 2000 },
      { name: "Half", type: "Length", formula: "[Length] / 2" },
      { name: "Quarter", type: "Length", formula: "[Half] / 2" },
      { name: "Model", type: "Text", value: "080" },
    ]);

    expect(result.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
    expect(result.byKey.get("quarter")?.value).toBe(500);
    expect(result.byKey.get("model")?.value).toBe("080");
  });

  it("applies overrides and drops the formula for that parameter", () => {
    const result = resolveParameters(
      [
        { name: "A", type: "Length", value: 10 },
        { name: "B", type: "Length", formula: "[A] * 2" },
      ],
      { a: 50 },
    );

    expect(result.byKey.get("a")?.value).toBe(50);
    expect(result.byKey.get("a")?.source).toBe("override");
    expect(result.byKey.get("b")?.value).toBe(100);
  });

  it("detects circular references", () => {
    const result = resolveParameters([
      { name: "A", type: "Length", formula: "[B] + 1" },
      { name: "B", type: "Length", formula: "[A] + 1" },
    ]);

    expect(result.issues.some((issue) => /Circular/.test(issue.message))).toBe(true);
  });
});

describe("geometry resolution and the example spec", () => {
  const raw = JSON.parse(
    readFileSync(new URL("../../../spec/examples/fcu-080.json", import.meta.url), "utf8"),
  );

  it("validates without errors", () => {
    const { spec, issues } = validateSpec(raw);
    expect(spec.name).toBe("Trane Option Unit-080 Horizontal FCU");
    expect(issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
  });

  it("resolves 13 parts and the expected overall size", () => {
    const analysis = analyzeSpec(raw);
    expect(analysis.ok).toBe(true);
    expect(analysis.model.parts).toHaveLength(13);
    const size = analysis.model.bounds!.size;
    expect(size.x).toBeCloseTo(2020, 3);
    expect(size.z).toBeCloseTo(605, 3);
    expect(size.y).toBeGreaterThan(2100);
  });

  it("moves geometry when a driving parameter changes", () => {
    const analysis = analyzeSpec(raw);
    const spec: FamilySpec = analysis.spec;
    const overrides = { [paramKey("Casing Length")]: 3000 };
    const parameters = resolveParameters(spec.parameters, overrides);
    const model = resolveModel(spec, parameters);

    expect(model.bounds!.size.x).toBeCloseTo(3100, 3);
  });

  it("reports invalid solids as issues instead of throwing", () => {
    const broken = {
      ...raw,
      parts: [{ id: "bad", name: "Bad", solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "nope(", y: 1, z: 1 } } }],
    };
    const analysis = analyzeSpec(broken);
    expect(analysis.ok).toBe(false);
    expect(analysis.errors[0].path).toBe("parts[0]");
  });

  it("keeps the agent generated pump example valid", () => {
    const pump = JSON.parse(
      readFileSync(new URL("../../../spec/examples/pump-dn80.json", import.meta.url), "utf8"),
    );
    const analysis = analyzeSpec(pump);
    expect(analysis.ok).toBe(true);
    expect(analysis.model.parts.length).toBeGreaterThanOrEqual(8);
    expect(analysis.model.bounds!.size.z).toBeGreaterThan(0);
  });
});

describe("rounded box corners", () => {
  const spec: FamilySpec = {
    schemaVersion: "1.0",
    name: "Rounded casing",
    category: "Mechanical Equipment",
    units: "mm",
    parameters: [{ name: "Corner Radius", type: "Length", value: 20 }],
    parts: [
      {
        id: "casing",
        name: "Casing",
        solid: {
          kind: "box",
          origin: { x: 0, y: 0, z: 0 },
          size: { x: 1000, y: 600, z: 400 },
          cornerRadius: "[Corner Radius]",
        },
      },
    ],
  };

  const cornerOf = (value: number | undefined): number | undefined => {
    const solid = analyzeSpec({
      ...spec,
      parts: [{ ...spec.parts[0], solid: { ...spec.parts[0].solid, cornerRadius: value } }],
    }).model.parts[0].solid;
    return solid.kind === "box" ? solid.cornerRadius : undefined;
  };

  it("resolves the radius from a parameter", () => {
    const analysis = analyzeSpec(spec);
    expect(analysis.ok).toBe(true);
    const solid = analysis.model.parts[0].solid;
    expect(solid.kind).toBe("box");
    if (solid.kind === "box") expect(solid.cornerRadius).toBe(20);
  });

  it("clamps the radius to half of the footprint", () => {
    expect(cornerOf(5000)).toBe(300);
  });

  it("defaults to a sharp box", () => {
    expect(cornerOf(undefined)).toBe(0);
  });
});

describe("layout logic checks", () => {
  const layout = (panZ: number) => ({
    schemaVersion: "1.0",
    name: "Layout",
    category: "Mechanical Equipment",
    units: "mm",
    parameters: [],
    parts: [
      {
        id: "casing",
        name: "Casing Body",
        solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: 1200, y: 800, z: 600 } },
      },
      {
        id: "cooling-coil",
        name: "Cooling Coil",
        solid: { kind: "box", origin: { x: 0, y: 0, z: 200 }, size: { x: 900, y: 500, z: 300 } },
      },
      {
        id: "drain-pan",
        name: "Condensate Drain Pan",
        solid: { kind: "box", origin: { x: 0, y: 0, z: panZ }, size: { x: 1000, y: 600, z: 60 } },
      },
    ],
  });

  it("warns when the drain pan is not below the cooling coil", () => {
    const analysis = analyzeSpec(layout(500));
    expect(analysis.ok).toBe(true);
    expect(analysis.issues.some((issue) => issue.path === "logic.drain-pan.drain-pan")).toBe(true);
  });

  it("accepts a pan under the coil and inside the casing", () => {
    const analysis = analyzeSpec(layout(100));
    expect(analysis.issues.filter((issue) => issue.path.startsWith("logic."))).toEqual([]);
  });

  it("warns when internal equipment leaves the casing", () => {
    const spec = layout(100);
    const moved = {
      ...spec,
      parts: [
        spec.parts[0],
        { ...spec.parts[1], solid: { ...spec.parts[1].solid, origin: { x: 0, y: 0, z: 700 } } },
        spec.parts[2],
      ],
    };
    const analysis = analyzeSpec(moved);
    expect(analysis.issues.some((issue) => issue.path === "logic.inside-casing.cooling-coil")).toBe(true);
  });
});
