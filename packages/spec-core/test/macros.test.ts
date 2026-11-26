import { describe, expect, it } from "vitest";
import { analyzeSpec, expandMacros, macroList, validateSpec } from "../src/index.js";

function macroSpec(segments: unknown[]) {
  return {
    schemaVersion: "1.0",
    name: "Macro tray",
    category: "Cable Tray Fitting",
    partType: "Elbow",
    units: "mm",
    parameters: [
      { name: "Tray Width", type: "Length", value: 400 },
      { name: "Tray Height", type: "Length", value: 100 },
      { name: "Sheet Thickness", type: "Length", value: 1.8 },
      { name: "Flange Width", type: "Length", value: 15 },
      { name: "Run A", type: "Length", value: 1000 },
      { name: "Run B", type: "Length", value: 700 },
    ],
    parts: [],
    materials: [{ name: "Galvanized", color: "#b8c0c8" }],
    macros: [
      {
        kind: "trayRun",
        id: "run-main",
        material: "Galvanized",
        width: "[Tray Width]",
        height: "[Tray Height]",
        thickness: "[Sheet Thickness]",
        flange: "[Flange Width]",
        segments,
      },
    ],
  };
}

const straight = macroSpec([{ kind: "straight", length: "[Run A]" }]);
straight.parameters = straight.parameters.filter((parameter) => parameter.name !== "Run B");
const elbow = macroSpec([
  { kind: "straight", length: "[Run A]" },
  { kind: "bend", angle: 90, direction: "left" },
  { kind: "straight", length: "[Run B]" },
]);

function bottomPart(analysis: ReturnType<typeof analyzeSpec>, n: number) {
  const part = analysis.model.parts.find((entry) => entry.id === `run-main-bottom-${n}`);
  expect(part).toBeDefined();
  if (!part || part.solid.kind !== "prism") throw new Error("expected a prism");
  return part.solid.points;
}

function samePoint(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

describe("trayRun macro", () => {
  it("builds a straight run with mitred-ready plates and two end connectors", () => {
    const analysis = analyzeSpec(straight);
    expect(analysis.errors).toEqual([]);
    expect(analysis.issues.filter((issue) => issue.severity === "warning")).toEqual([]);

    expect(analysis.model.parts.map((part) => part.id)).toEqual([
      "run-main-bottom-1",
      "run-main-side-wall-left-1",
      "run-main-side-wall-right-1",
      "run-main-top-flange-left-1",
      "run-main-top-flange-right-1",
    ]);
    expect(analysis.model.connectors.map((connector) => connector.id)).toEqual([
      "run-main-in",
      "run-main-out",
    ]);

    expect(analysis.model.bounds?.size.x).toBeCloseTo(1000, 6);
    expect(analysis.model.bounds?.size.y).toBeCloseTo(400 + 2 * 1.8, 6);
    expect(analysis.model.bounds?.size.z).toBeCloseTo(100, 6);
  });

  it("closes a 90° miter: consecutive legs share the exact joint edge", () => {
    const analysis = analyzeSpec(elbow);
    expect(analysis.errors).toEqual([]);

    const first = bottomPart(analysis, 1);
    const second = bottomPart(analysis, 2);
    const shared = first.filter((a) => second.some((b) => samePoint(a, b)));
    expect(shared).toHaveLength(2);

    // The miter extends half the tray width behind the corner.
    expect(analysis.model.bounds?.size.x).toBeCloseTo(1000 + 200 + 1.8, 6);
    expect(analysis.model.bounds?.size.y).toBeCloseTo(700 + 200 + 1.8, 6);
    expect(analysis.model.bounds?.size.z).toBeCloseTo(100, 6);
  });

  it("keeps every generated coordinate as a parameter formula", () => {
    const expanded = expandMacros(elbow);
    expect(expanded.issues).toEqual([]);
    const bottom = expanded.spec.parts.find(
      (part: { id: string }) => part.id === "run-main-bottom-1",
    ) as { solid: { points: [string | number, string | number][] } };
    const flat = bottom.solid.points.flat().map(String);
    expect(flat.some((value) => value.includes("[Tray Width]"))).toBe(true);
    expect(flat.some((value) => value.includes("[Run A]"))).toBe(true);
  });

  it("follows width, height and thickness changes", () => {
    const analysis = analyzeSpec(straight, {
      "tray width": 600,
      "tray height": 150,
      "sheet thickness": 2,
    });
    expect(analysis.errors).toEqual([]);
    expect(analysis.model.bounds?.size.y).toBeCloseTo(600 + 2 * 2, 6);
    expect(analysis.model.bounds?.size.z).toBeCloseTo(150, 6);
    const bottom = analysis.model.parts.find((part) => part.id === "run-main-bottom-1");
    if (!bottom || bottom.solid.kind !== "prism") throw new Error("expected prism");
    expect(bottom.solid.to - bottom.solid.from).toBeCloseTo(2, 6);
  });

  it("is idempotent when a validated spec is expanded again", () => {
    const first = analyzeSpec(elbow);
    const reexpanded = expandMacros(first.spec);
    const ids = reexpanded.spec.parts.map((part: { id: string }) => part.id);
    expect(ids).toEqual(first.spec.parts.map((part) => part.id));
    expect(ids.filter((id: string) => id === "run-main-bottom-1")).toHaveLength(1);
  });

  it("reports definition errors at the macro line, not at generated parts", () => {
    const broken = macroSpec([{ kind: "straight", length: 1000 }]) as Record<string, unknown>;
    const macros = broken.macros as Array<Record<string, unknown>>;
    macros[0].width = undefined;

    const analysis = analyzeSpec(broken);
    expect(analysis.errors.some((issue) => issue.path === "macros[0].width")).toBe(true);
    expect(analysis.errors.some((issue) => issue.path.startsWith("parts["))).toBe(false);
  });

  it("supports a 45° plan bend without opening the joint", () => {
    const analysis = analyzeSpec(
      macroSpec([
        { kind: "straight", length: "[Run A]" },
        { kind: "bend", angle: 45, direction: "right" },
        { kind: "straight", length: "[Run B]" },
      ]),
    );
    expect(analysis.errors).toEqual([]);
    const first = bottomPart(analysis, 1);
    const second = bottomPart(analysis, 2);
    expect(first.filter((a) => second.some((b) => samePoint(a, b)))).toHaveLength(2);
  });

  it("handles a Z offset (left then right) and an optional lid", () => {
    const spec = macroSpec([
      { kind: "straight", length: "[Run A]" },
      { kind: "bend", angle: 90, direction: "left" },
      { kind: "straight", length: "[Run B]" },
      { kind: "bend", angle: 90, direction: "right" },
      { kind: "straight", length: "[Run A]" },
    ]);
    (spec.macros[0] as { lid: boolean }).lid = true;
    const analysis = analyzeSpec(spec);
    expect(analysis.errors).toEqual([]);

    expect(analysis.model.parts.some((part) => part.id === "run-main-lid-1")).toBe(true);
    expect(analysis.model.parts.length).toBe(18);
    const first = bottomPart(analysis, 1);
    const second = bottomPart(analysis, 2);
    const third = bottomPart(analysis, 3);
    expect(first.filter((a) => second.some((b) => samePoint(a, b)))).toHaveLength(2);
    expect(second.filter((a) => third.some((b) => samePoint(a, b)))).toHaveLength(2);
  });

  it("drops stale macro connectors when connectors is set to false", () => {
    const initial = analyzeSpec(straight);
    expect(initial.spec.connectors).toHaveLength(2);
    expect(initial.spec.connectors?.[0].direction).toBe("in");
    expect(initial.spec.connectors?.[1].direction).toBe("out");

    const updated = structuredClone(initial.spec) as Record<string, unknown>;
    (updated.macros as Array<Record<string, unknown>>)[0].connectors = false;
    const reanalyzed = analyzeSpec(updated);
    expect(reanalyzed.errors).toEqual([]);
    expect(reanalyzed.spec.connectors ?? []).toHaveLength(0);
  });

  it("reports macro validation errors cleanly and supports macroList", () => {
    const invalidKind = {
      ...macroSpec([{ kind: "straight", length: 500 }]),
      macros: [{ kind: "unknownKind" }],
    };
    const res1 = validateSpec(invalidKind);
    expect(res1.issues.some((i) => i.path === "macros[0].kind" && i.severity === "error")).toBe(true);

    const upDown = macroSpec([
      { kind: "straight", length: 500 },
      { kind: "bend", angle: 90, direction: "up" },
      { kind: "straight", length: 500 },
    ]);
    const res2 = validateSpec(upDown);
    expect(res2.issues.some((i) => i.path === "macros[0].segments[1].direction")).toBe(true);

    const emptyBoth = { ...straight, parts: [], macros: [] };
    const res3 = validateSpec(emptyBoth);
    expect(res3.issues.some((i) => i.path === "parts" && i.severity === "error")).toBe(true);

    expect(macroList(straight)).toHaveLength(1);
    expect(macroList({})).toEqual([]);
  });

  it("rejects macros cleanly when allowMacros is false", () => {
    const blocked = analyzeSpec(straight, {}, { allowMacros: false });
    expect(blocked.ok).toBe(false);
    expect(blocked.errors.some((issue) => issue.path === "macros")).toBe(true);
    expect(blocked.model.parts).toHaveLength(0);
  });
});
