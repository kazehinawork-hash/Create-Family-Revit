import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ResolvedSolid } from "@family/spec-core";
import { csgEdgeGeometry, instanceEdgeGeometry, solidGeometry } from "./three-build";
import { deserializeGeometry, geometryTransferables, serializeGeometry } from "./geometry-transfer";

function sizeOf(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  return box.getSize(new THREE.Vector3());
}

const box: ResolvedSolid = {
  kind: "box",
  origin: { x: 0, y: 0, z: 0 },
  size: { x: 100, y: 50, z: 20 },
  rotationZ: 0,
  cornerRadius: 0,
};

describe("solid geometry", () => {
  it("builds a box with the requested size and base on z = 0", () => {
    const geometry = solidGeometry(box);
    const size = sizeOf(geometry);
    expect(size.x).toBeCloseTo(100);
    expect(size.y).toBeCloseTo(50);
    expect(size.z).toBeCloseTo(20);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.z).toBeCloseTo(0);
  });

  it("builds a frustum from the two radii", () => {
    const geometry = solidGeometry({
      kind: "frustum",
      base: { x: 0, y: 0, z: 0 },
      radiusBottom: 20,
      radiusTop: 5,
      height: 40,
      axis: "z",
      segments: 24,
    });
    const size = sizeOf(geometry);
    expect(size.x).toBeCloseTo(40, 1);
    expect(size.z).toBeCloseTo(40);
  });

  it("builds a tube instead of a solid rod", () => {
    const geometry = solidGeometry({
      kind: "cylinder",
      base: { x: 0, y: 0, z: 0 },
      radius: 20,
      innerRadius: 10,
      height: 30,
      axis: "z",
      segments: 24,
    });
    expect(sizeOf(geometry).z).toBeCloseTo(30);
    // A lathe profile has an inner and an outer wall, so the surface area is larger
    // than a capped solid cylinder of the same outer radius.
    expect(geometry.getAttribute("position").count).toBeGreaterThan(24 * 2);
  });
});

describe("bend geometry", () => {
  const bend = (plane: "xy" | "xz" | "yz"): ResolvedSolid => ({
    kind: "bend",
    center: { x: 0, y: 0, z: 0 },
    radius: 150,
    tubeRadius: 40,
    angle: 90,
    startAngle: 0,
    plane,
    segments: 24,
  });

  const outward = (geometry: THREE.BufferGeometry) => {
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const index = geometry.getIndex();
    if (!index) throw new Error("expected indexed geometry");
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const cross = new THREE.Vector3();
    const average = new THREE.Vector3();
    for (let i = 0; i < index.count; i += 3) {
      const ia = index.getX(i);
      const ib = index.getX(i + 1);
      const ic = index.getX(i + 2);
      a.fromBufferAttribute(position, ia);
      b.fromBufferAttribute(position, ib);
      c.fromBufferAttribute(position, ic);
      cross.crossVectors(b.clone().sub(a), c.clone().sub(a));
      if (cross.lengthSq() < 1e-9) continue;
      average.set(
        normal.getX(ia) + normal.getX(ib) + normal.getX(ic),
        normal.getY(ia) + normal.getY(ib) + normal.getY(ic),
        normal.getZ(ia) + normal.getZ(ib) + normal.getZ(ic),
      );
      expect(cross.dot(average)).toBeGreaterThan(0);
    }
  };

  it("puts the ring in the requested plane", () => {
    const xy = sizeOf(solidGeometry(bend("xy")));
    expect(xy.x).toBeCloseTo(190, 1);
    expect(xy.y).toBeCloseTo(190, 1);
    expect(xy.z).toBeCloseTo(80, 1);

    const xz = sizeOf(solidGeometry(bend("xz")));
    expect(xz.x).toBeCloseTo(190, 1);
    expect(xz.y).toBeCloseTo(80, 1);
    expect(xz.z).toBeCloseTo(190, 1);

    const yz = sizeOf(solidGeometry(bend("yz")));
    expect(yz.x).toBeCloseTo(80, 1);
    expect(yz.y).toBeCloseTo(190, 1);
    expect(yz.z).toBeCloseTo(190, 1);
  });

  it("winds every triangle outward, including the end caps", () => {
    for (const plane of ["xy", "xz", "yz"] as const) outward(solidGeometry(bend(plane)));
  });
});

describe("frustum direction", () => {
  const geometry = (height: number) =>
    solidGeometry({
      kind: "frustum",
      base: { x: 0, y: 0, z: 0 },
      radiusBottom: 20,
      radiusTop: 5,
      height,
      axis: "z",
      segments: 24,
    });

  const radiusAt = (height: number, z: number) => {
    const position = geometry(height).getAttribute("position");
    let radius = 0;
    for (let i = 0; i < position.count; i += 1) {
      if (Math.abs(position.getZ(i) - z) > 0.01) continue;
      radius = Math.max(radius, Math.hypot(position.getX(i), position.getY(i)));
    }
    return radius;
  };

  it("keeps radiusBottom on the base for a positive height", () => {
    expect(radiusAt(40, 0)).toBeCloseTo(20, 1);
    expect(radiusAt(40, 40)).toBeCloseTo(5, 1);
  });

  it("keeps the base radius at the base for a negative height", () => {
    expect(radiusAt(-40, 0)).toBeCloseTo(5, 1);
    expect(radiusAt(-40, -40)).toBeCloseTo(20, 1);
  });
});

describe("prism holes", () => {
  it("adds an inner wall for a hole loop", () => {
    const solid: ResolvedSolid = {
      kind: "prism",
      plane: "xy",
      points: [
        [-50, -50],
        [50, -50],
        [50, 50],
        [-50, 50],
      ],
      holes: [
        [
          [-10, -10],
          [10, -10],
          [10, 10],
          [-10, 10],
        ],
      ],
      from: 0,
      to: 20,
    };

    const withHole = solidGeometry(solid);
    const withoutHole = solidGeometry({ ...solid, holes: [] });
    expect(withHole.getAttribute("position").count).toBeGreaterThan(
      withoutHole.getAttribute("position").count,
    );
    const size = sizeOf(withHole);
    expect(size.x).toBeCloseTo(100);
    expect(size.y).toBeCloseTo(100);
    expect(size.z).toBeCloseTo(20);
  });
});

describe("loft geometry", () => {
  it("builds a closed transition between two rings", () => {
    const solid: ResolvedSolid = {
      kind: "loft",
      axis: "z",
      sections: [
        {
          at: 0,
          points: [
            [-50, -50],
            [50, -50],
            [50, 50],
            [-50, 50],
          ],
        },
        {
          at: 100,
          points: [
            [-25, -25],
            [25, -25],
            [25, 25],
            [-25, 25],
          ],
        },
      ],
    };

    const geometry = solidGeometry(solid);
    const size = sizeOf(geometry);
    expect(size.x).toBeCloseTo(100);
    expect(size.y).toBeCloseTo(100);
    expect(size.z).toBeCloseTo(100);
    expect(geometry.getIndex()?.count).toBeGreaterThan(0);
  });
});

describe("worker transfer", () => {
  it("round-trips positions, normals and index", () => {
    const source = solidGeometry(box);
    const data = serializeGeometry(source);
    const copy = deserializeGeometry(data);

    expect(data.positions.length).toBe(source.getAttribute("position").count * 3);
    expect(data.normals).not.toBeNull();
    expect(data.index).not.toBeNull();
    expect(sizeOf(copy).x).toBeCloseTo(100);
    expect(copy.getIndex()?.count).toBe(source.getIndex()?.count);
    expect(geometryTransferables(data).length).toBeGreaterThan(0);
  });
});

describe("edge outlines", () => {
  it("keeps the twelve creases of a box and drops triangulation diagonals", () => {
    const outline = csgEdgeGeometry(solidGeometry(box));
    expect(outline.getAttribute("position").count).toBe(24);
  });

  it("merges array copies into one line geometry", () => {
    const edges = new THREE.EdgesGeometry(solidGeometry(box));
    const merged = instanceEdgeGeometry(edges, 3, "x", 10)!;
    const position = merged.getAttribute("position");
    const perCopy = edges.getAttribute("position").count;

    expect(position.count).toBe(perCopy * 3);
    expect(position.getX(perCopy)).toBeCloseTo(position.getX(0) + 10);
    expect(position.getX(perCopy * 2)).toBeCloseTo(position.getX(0) + 20);
  });
});
