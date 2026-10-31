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
