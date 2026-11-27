import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ResolvedPart, ResolvedSolid } from "@family/spec-core";
import {
  buildPartGeometry,
  csgEdgeGeometry,
  extractPartEdges,
  instanceEdgeGeometry,
  solidGeometry,
} from "./three-build";
import { deserializeGeometry, geometryTransferables, serializeGeometry } from "./geometry-transfer";

function sizeOf(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  return box.getSize(new THREE.Vector3());
}

function geometrySignedVolume(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let volume = 0;

  for (let i = 0; i < count; i += 3) {
    const ia = index ? index.getX(i) : i;
    const ib = index ? index.getX(i + 1) : i + 1;
    const ic = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    cross.crossVectors(b, c);
    volume += a.dot(cross);
  }
  return volume / 6;
}

function expectOutwardWinding(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const average = new THREE.Vector3();
  for (let i = 0; i < count; i += 3) {
    const ia = index ? index.getX(i) : i;
    const ib = index ? index.getX(i + 1) : i + 1;
    const ic = index ? index.getX(i + 2) : i + 2;
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
    for (const plane of ["xy", "xz", "yz"] as const) expectOutwardWinding(solidGeometry(bend(plane)));
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

  it("produces positive signed volume and outward normals on xy, xz, and yz prisms with and without cuts", () => {
    const lShape: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 20],
      [20, 20],
      [20, 80],
      [0, 80],
    ];
    // Expected 2D area = 100*20 + 20*60 = 3200; depth = 25 -> volume = 80,000.
    const expectedSolidVolume = 80_000;

    for (const plane of ["xy", "xz", "yz"] as const) {
      const solid: ResolvedSolid = {
        kind: "prism",
        plane,
        points: lShape,
        holes: [],
        from: -12.5,
        to: 12.5,
      };
      const raw = solidGeometry(solid);
      expect(geometrySignedVolume(raw)).toBeCloseTo(expectedSolidVolume, 0);
      expectOutwardWinding(raw);

      // Cut a 20x10 through-slot near the base leg in the same plane's coordinates.
      const cut: ResolvedSolid = {
        kind: "prism",
        plane,
        points: [
          [50, 5],
          [70, 5],
          [70, 15],
          [50, 15],
        ],
        holes: [],
        from: -12.5,
        to: 12.5,
      };
      const part: ResolvedPart = {
        id: `prism-${plane}`,
        name: `Prism ${plane}`,
        solid,
        cuts: [cut],
        array: { count: 1, axis: "x", spacing: 0 },
      };
      const built = buildPartGeometry(part);
      expect(built.hasCuts).toBe(true);
      expect(built.cutFailed).toBe(false);
      // Cut volume = 20 * 10 * 25 = 5,000 -> remaining = 75,000.
      expect(geometrySignedVolume(built.geometry)).toBeCloseTo(75_000, 0);
      expectOutwardWinding(built.geometry);
    }
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

  it("builds a revolve solid of revolution using LatheGeometry", () => {
    const solid: ResolvedSolid = {
      kind: "revolve",
      axis: "z",
      origin: { x: 0, y: 0, z: 0 },
      points: [
        [0, 0],
        [50, 0],
        [30, 80],
        [0, 80],
      ],
      angle: 360,
      startAngle: 0,
      segments: 24,
    };

    const geometry = solidGeometry(solid);
    const size = sizeOf(geometry);
    expect(size.x).toBeCloseTo(100, 0);
    expect(size.y).toBeCloseTo(100, 0);
    expect(size.z).toBeCloseTo(80, 0);
  });

  it("keeps positive volume and outward normals on revolve across point orders, axes, and angles", () => {
    // Negative-height profile (like center_pin / evaporator_end_cap_front) and its reversed copy.
    const negativeHeightProfile: [number, number][] = [
      [0, 0],
      [20, 0],
      [20, -35],
      [15, -40],
      [0, -40],
    ];
    const reversedProfile = [...negativeHeightProfile].reverse();

    for (const axis of ["x", "y", "z"] as const) {
      for (const angle of [360, 180, 90, -90]) {
        for (const points of [negativeHeightProfile, reversedProfile]) {
          const solid: ResolvedSolid = {
            kind: "revolve",
            axis,
            origin: { x: 120, y: -40, z: 30 },
            points,
            angle,
            startAngle: 25,
            segments: 24,
          };
          const geometry = solidGeometry(solid);
          const volume = geometrySignedVolume(geometry);
          expect(volume).toBeGreaterThan(10_000);
          expectOutwardWinding(geometry);
        }
      }
    }
  });

  it("uses a denser mesh in high preview quality", () => {
    const cylinder: ResolvedSolid = {
      kind: "cylinder",
      base: { x: 0, y: 0, z: 0 },
      radius: 100,
      innerRadius: 0,
      height: 50,
      axis: "z",
      segments: 24,
    };
    const standard = solidGeometry(cylinder, "standard");
    const high = solidGeometry(cylinder, "high");
    expect(high.getAttribute("position").count).toBeGreaterThan(
      standard.getAttribute("position").count,
    );
  });

  it("builds an arbitrary-axis tube between start and end", () => {
    const solid: ResolvedSolid = {
      kind: "tube",
      start: { x: 0, y: 0, z: 0 },
      end: { x: 0, y: 0, z: 100 },
      radius: 20,
      innerRadius: 0,
      direction: { x: 0, y: 0, z: 1 },
      length: 100,
      segments: 24,
    };

    const geometry = solidGeometry(solid);
    const size = sizeOf(geometry);
    expect(size.x).toBeCloseTo(40, 0);
    expect(size.y).toBeCloseTo(40, 0);
    expect(size.z).toBeCloseTo(100, 0);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.z).toBeCloseTo(0, 0);
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

  it("keeps straight outer crease edges on rounded CSG boxes with countersunk cuts and drops flat-face diagonals", () => {
    const leaf: ResolvedPart = {
      id: "csg-leaf",
      name: "CSG Leaf",
      solid: {
        kind: "box",
        origin: { x: -16.75, y: 3.5, z: -22.5 },
        size: { x: 31.5, y: 7, z: 45 },
        rotationZ: 0,
        cornerRadius: 3,
      },
      cuts: [
        {
          kind: "cylinder",
          axis: "y",
          base: { x: -20, y: -1, z: -12.5 },
          radius: 3.25,
          innerRadius: 0,
          height: 9,
          segments: 24,
        },
        {
          kind: "frustum",
          axis: "y",
          base: { x: -20, y: 5, z: -12.5 },
          radiusBottom: 3.25,
          radiusTop: 5.75,
          height: 2.5,
          segments: 24,
        },
      ],
      array: { count: 1, axis: "x", spacing: 0 },
    };

    const built = buildPartGeometry(leaf, "high");
    expect(built.hasCuts).toBe(true);
    expect(built.cutFailed).toBe(false);

    const outline = csgEdgeGeometry(built.geometry, 24);
    outline.computeBoundingBox();
    expect(outline.boundingBox!.min.x).toBeCloseTo(-32.5, 1);
    expect(outline.boundingBox!.max.x).toBeCloseTo(-1, 1);
    expect(outline.boundingBox!.min.y).toBeCloseTo(0, 1);
    expect(outline.boundingBox!.max.y).toBeCloseTo(7, 1);
    expect(outline.boundingBox!.min.z).toBeCloseTo(-22.5, 1);
    expect(outline.boundingBox!.max.z).toBeCloseTo(22.5, 1);

    const pos = outline.getAttribute("position");
    let longStraightEdges = 0;
    let flatFaceDiagonals = 0;
    for (let i = 0; i < pos.count; i += 2) {
      const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
      const bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      if (len > 20 && Math.abs(by - ay) < 1e-3 && Math.abs(bz - az) < 1e-3) {
        longStraightEdges += 1;
      }
      const onFrontOrBackPlane =
        (Math.abs(ay) < 1e-3 && Math.abs(by) < 1e-3) ||
        (Math.abs(ay - 7) < 1e-3 && Math.abs(by - 7) < 1e-3);
      if (onFrontOrBackPlane && len > 10 && Math.abs(bx - ax) > 1 && Math.abs(bz - az) > 1) {
        flatFaceDiagonals += 1;
      }
    }

    expect(longStraightEdges).toBe(4);
    expect(flatFaceDiagonals).toBe(0);
  });

  it("extracts flat-to-curved tangent seams and horizon smoothEdges separately from sharp creases", () => {
    const roundedBox: ResolvedSolid = {
      kind: "box",
      origin: { x: 0, y: 0, z: 0 },
      size: { x: 40, y: 12, z: 50 },
      rotationZ: 0,
      cornerRadius: 4,
    };
    const roundedGeom = solidGeometry(roundedBox);
    const rounded = extractPartEdges(roundedGeom, 24);
    // 4 flat sides x 2 edges (meeting 4 corner fillets) = 8 vertical tangent seams.
    expect(rounded.tangentEdges.getAttribute("position").count).toBe(16);
    expect(rounded.smoothEdges.getAttribute("position").count).toBeGreaterThan(0);
    expect(rounded.smoothEdges.getAttribute("aEdgeMid")?.count).toBe(
      rounded.smoothEdges.getAttribute("position").count,
    );
    expect(rounded.smoothEdges.getAttribute("aNormalA")).toBeDefined();
    expect(rounded.smoothEdges.getAttribute("aNormalB")).toBeDefined();

    // Cylinders should keep circular caps in edges, 0 false barrel seams in tangentEdges,
    // and curved barrel edges in smoothEdges for view-dependent GPU silhouettes.
    const cyl: ResolvedSolid = {
      kind: "cylinder",
      base: { x: 0, y: 0, z: 0 },
      radius: 25,
      innerRadius: 0,
      height: 100,
      axis: "z",
      segments: 32,
    };
    const cylGeom = solidGeometry(cyl);
    const cylEdges = extractPartEdges(cylGeom, 24);
    const capCount = cylEdges.edges.getAttribute("position").count;
    const barrelCount = cylEdges.smoothEdges.getAttribute("position").count;
    expect(capCount).toBeGreaterThanOrEqual(128);
    expect(capCount).toBe(barrelCount * 2); // 2 circular caps vs 1 curved barrel
    expect(cylEdges.tangentEdges.getAttribute("position").count).toBe(0);
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
