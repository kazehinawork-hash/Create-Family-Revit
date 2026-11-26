import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { computeCameraPreset, planeCrossSection, snapToAxis } from "./sceneHelpers";

describe("snapToAxis", () => {
  it("snaps near-axis vectors within maxAngleDeg onto X, Y, or Z", () => {
    const from = new THREE.Vector3(10, 20, 30);

    const snapX = snapToAxis(from, new THREE.Vector3(210, 28, 34));
    expect(snapX.axis).toBe("X");
    expect(snapX.point.toArray()).toEqual([210, 20, 30]);

    const snapY = snapToAxis(from, new THREE.Vector3(14, -180, 26));
    expect(snapY.axis).toBe("Y");
    expect(snapY.point.toArray()).toEqual([10, -180, 30]);

    const snapZ = snapToAxis(from, new THREE.Vector3(15, 22, 430));
    expect(snapZ.axis).toBe("Z");
    expect(snapZ.point.toArray()).toEqual([10, 20, 430]);
  });

  it("keeps oblique directions unsnapped and respects custom angle threshold", () => {
    const from = new THREE.Vector3(0, 0, 0);
    const diag = new THREE.Vector3(100, 100, 0);
    const resDefault = snapToAxis(from, diag);
    expect(resDefault.axis).toBeNull();
    expect(resDefault.point.toArray()).toEqual([100, 100, 0]);

    const wide = snapToAxis(from, diag, 50);
    expect(wide.axis).not.toBeNull();
  });

  it("handles coincident points safely without NaN", () => {
    const p = new THREE.Vector3(5, 6, 7);
    const res = snapToAxis(p, new THREE.Vector3(5, 6, 7));
    expect(res.axis).toBeNull();
    expect(res.point.toArray()).toEqual([5, 6, 7]);
  });
});

describe("computeCameraPreset", () => {
  const bounds = {
    min: { x: -400, y: -200, z: 0 },
    max: { x: 400, y: 200, z: 300 },
    size: { x: 800, y: 400, z: 300 },
  };

  it("computes center and distinct directional camera positions", () => {
    const iso = computeCameraPreset(bounds, 38, "iso");
    expect(iso.center.toArray()).toEqual([0, 0, 150]);
    expect(iso.distance).toBeGreaterThan(1000);
    expect(iso.pos.x).toBeGreaterThan(iso.center.x);
    expect(iso.pos.y).toBeLessThan(iso.center.y);
    expect(iso.pos.z).toBeGreaterThan(iso.center.z);

    const top = computeCameraPreset(bounds, 38, "top");
    expect(top.pos.x).toBeCloseTo(0, 3);
    expect(top.pos.z).toBeCloseTo(150 + top.distance, 3);

    const front = computeCameraPreset(bounds, 38, "front");
    expect(front.pos.y).toBeCloseTo(-front.distance, 3);
    expect(front.pos.z).toBeCloseTo(150, 3);

    const left = computeCameraPreset(bounds, 38, "left");
    expect(left.pos.x).toBeCloseTo(-left.distance, 3);

    const right = computeCameraPreset(bounds, 38, "right");
    expect(right.pos.x).toBeCloseTo(right.distance, 3);

    const bbl = computeCameraPreset(bounds, 38, "bbl");
    expect(bbl.pos.x).toBeLessThan(bbl.center.x);
    expect(bbl.pos.y).toBeGreaterThan(bbl.center.y);
    expect(bbl.pos.z).toBeLessThan(bbl.center.z);
  });

  it("clamps minimum radius at 120mm for tiny models", () => {
    const tiny = {
      min: { x: -5, y: -5, z: 0 },
      max: { x: 5, y: 5, z: 10 },
      size: { x: 10, y: 10, z: 10 },
    };
    const preset = computeCameraPreset(tiny, 38, "front");
    const expectedDist = (120 / Math.sin((38 * Math.PI) / 360)) * 1.15;
    expect(preset.distance).toBeCloseTo(expectedDist, 4);
  });
});

describe("planeCrossSection", () => {
  const bounds = {
    min: { x: -200, y: -100, z: 0 },
    max: { x: 200, y: 100, z: 300 },
  };

  it("returns ordered 4-corner section polygon for Z, X, and Y cutting planes", () => {
    const zSlice = planeCrossSection(bounds, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 150));
    expect(zSlice).toHaveLength(4);
    for (const pt of zSlice) {
      expect(pt.z).toBeCloseTo(150, 4);
      expect(Math.abs(pt.x)).toBeCloseTo(200, 4);
      expect(Math.abs(pt.y)).toBeCloseTo(100, 4);
    }

    const xSlice = planeCrossSection(bounds, new THREE.Vector3(-1, 0, 0), new THREE.Vector3(50, 0, 150));
    expect(xSlice).toHaveLength(4);
    for (const pt of xSlice) {
      expect(pt.x).toBeCloseTo(50, 4);
    }
  });

  it("computes coplanar cross-section polygon for oblique planes", () => {
    const normal = new THREE.Vector3(1, 1, 0).normalize();
    const origin = new THREE.Vector3(0, 0, 150);
    const poly = planeCrossSection(bounds, normal, origin);
    expect(poly.length).toBeGreaterThanOrEqual(4);
    for (const pt of poly) {
      expect(pt.clone().sub(origin).dot(normal)).toBeCloseTo(0, 3);
    }
  });

  it("returns empty array when plane lies outside the bounding box", () => {
    const outside = planeCrossSection(bounds, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 500));
    expect(outside).toEqual([]);
  });
});
