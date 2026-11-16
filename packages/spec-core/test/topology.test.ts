import { describe, expect, it } from "vitest";
import type { ResolvedModel, ResolvedPart } from "../src/geometry.js";
import { checkTopology } from "../src/topology.js";

function model(parts: ResolvedPart[]): ResolvedModel {
  return {
    parts,
    connectors: [],
    instances: parts.length,
    issues: [],
    bounds: null,
  };
}

function prism(
  id: string,
  points: [number, number][],
  holes: [number, number][][] = [],
  from = 0,
  to = 10,
): ResolvedPart {
  return {
    id,
    name: id,
    solid: { kind: "prism", plane: "xy", points, holes, from, to },
    cuts: [],
    array: { count: 1, axis: "x", spacing: 0 },
  };
}

const square: [number, number][] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

describe("topology checks", () => {
  it("flags a self-intersecting profile", () => {
    const issues = checkTopology(
      model([
        prism("crossed", [
          [0, 0],
          [100, 0],
          [50, 100],
          [0, 100],
          [100, 50],
        ]),
      ]),
    );
    expect(issues.some((issue) => issue.path.endsWith(".solid.points"))).toBe(true);
    expect(issues.some((issue) => /intersects itself/.test(issue.message))).toBe(true);
  });

  it("flags a zero-area profile", () => {
    const issues = checkTopology(
      model([
        prism("flat", [
          [0, 0],
          [10, 0],
          [20, 0],
        ]),
      ]),
    );
    expect(issues.some((issue) => /zero area/.test(issue.message))).toBe(true);
  });

  it("flags a hole outside the outer profile", () => {
    const issues = checkTopology(
      model([
        prism("plate", square, [
          [
            [200, 200],
            [210, 200],
            [210, 210],
          ],
        ]),
      ]),
    );
    expect(issues.some((issue) => /outside the outer profile/.test(issue.message))).toBe(true);
  });

  it("flags duplicated parts", () => {
    const issues = checkTopology(model([prism("a", square), prism("b", square)]));
    expect(issues.some((issue) => /accidental duplicate/.test(issue.message))).toBe(true);
  });

  it("warns when a thin-prism cut crosses or nearly touches the outer profile", () => {
    const part = prism("web", square, [], 0, 2);
    part.cuts = [
      {
        kind: "box",
        origin: { x: 5, y: 50, z: 0 },
        size: { x: 9, y: 20, z: 10 },
        rotationZ: 0,
        cornerRadius: 0,
      },
    ];
    const issues = checkTopology(model([part]));
    expect(issues.some((issue) => /quá mỏng để boolean/.test(issue.message))).toBe(true);
  });

  it("a blind cut in a thick 94 mm prism does not warn (boolean fallback)", () => {
    const part = prism("block", square, [], 0, 94);
    part.cuts = [
      {
        kind: "box",
        origin: { x: 50, y: 50, z: 0 },
        size: { x: 10, y: 10, z: 10 },
        rotationZ: 0,
        cornerRadius: 0,
      },
    ];
    const issues = checkTopology(model([part]));
    expect(issues.filter((issue) => /\.cuts\[/.test(issue.path))).toHaveLength(0);
  });

  it("warns when a 2 mm plate is left with less than 0.8 mm under a blind cut", () => {
    const part = prism("sheet", square, [], 0, 2);
    part.cuts = [
      {
        kind: "box",
        origin: { x: 50, y: 50, z: 0 },
        size: { x: 10, y: 10, z: 1.5 },
        rotationZ: 0,
        cornerRadius: 0,
      },
    ];
    const issues = checkTopology(model([part]));
    expect(issues.some((issue) => /\.cuts\[/.test(issue.path))).toBe(true);
  });

  it("does not warn for a cut fully inside a thin prism", () => {
    const part = prism("web", square);
    part.cuts = [
      {
        kind: "box",
        origin: { x: 50, y: 50, z: 0 },
        size: { x: 9, y: 20, z: 10 },
        rotationZ: 0,
        cornerRadius: 0,
      },
    ];
    const issues = checkTopology(model([part]));
    expect(issues.some((issue) => /quá mỏng để boolean/.test(issue.message))).toBe(false);
  });

  it("adds an info advisory for a large part buried inside another", () => {
    const outer: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const inner: [number, number][] = [
      [2, 2],
      [98, 2],
      [98, 98],
      [2, 98],
    ];
    const issues = checkTopology(model([prism("outer", outer), prism("inner", inner)]));
    expect(
      issues.some(
        (issue) => issue.severity === "info" && /nằm gần như hoàn toàn/.test(issue.message),
      ),
    ).toBe(true);
  });

  it("adds an info advisory for a large coincident face of the same material", () => {
    const left = { ...prism("left", square), material: "Steel" };
    const right = {
      ...prism(
        "right",
        square.map(([x, y]) => [x + 100, y] as [number, number]),
      ),
      material: "Steel",
    };
    const issues = checkTopology(model([left, right]));
    expect(
      issues.some((issue) => issue.severity === "info" && /khít mặt/.test(issue.message)),
    ).toBe(true);
  });

  it("keeps a clean prism with an inside hole untouched", () => {
    const issues = checkTopology(
      model([
        prism("plate", square, [
          [
            [40, 40],
            [60, 40],
            [60, 60],
            [40, 60],
          ],
        ]),
      ]),
    );
    expect(issues).toEqual([]);
  });
});
