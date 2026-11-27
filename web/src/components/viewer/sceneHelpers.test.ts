import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  computeCameraPreset,
  createInfiniteGrid,
  createSectionCap,
  planeCrossSection,
  snapToAxis,
} from "./sceneHelpers";
import {
  applyPartStyle,
  computeSmoothNormals,
  createCurvedSilhouetteLineMaterial,
  createPartSilhouetteMaterial,
} from "./usePartMeshes";
import type { PartCacheEntry } from "./types";

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

describe("createInfiniteGrid", () => {
  it("uses a screen-space quad instead of a huge world plane and syncs camera matrices", () => {
    const grid = createInfiniteGrid();
    const material = grid.material as THREE.ShaderMaterial;

    grid.geometry.computeBoundingBox();
    const size = grid.geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBe(2);
    expect(size.y).toBe(2);
    expect(grid.frustumCulled).toBe(false);
    expect(grid.renderOrder).toBe(-2);
    expect(material.glslVersion).toBe(THREE.GLSL3);
    expect(material.depthWrite).toBe(false);
    expect(material.depthTest).toBe(true);

    // Must never intercept scene raycasts.
    const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 0, 100), new THREE.Vector3(0, 0, -1));
    expect(raycaster.intersectObject(grid)).toEqual([]);

    const camera = new THREE.PerspectiveCamera(38, 1.5, 1, 5000);
    camera.position.set(45, -60, 35);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    grid.position.z = -0.05;
    grid.onBeforeRender(
      {} as THREE.WebGLRenderer,
      {} as THREE.Scene,
      camera,
      grid.geometry,
      material,
      {} as THREE.Group,
    );

    expect(material.uniforms.uCamera.value.toArray()).toEqual([45, -60, 35]);
    expect(material.uniforms.uGridZ.value).toBe(-0.05);
    expect(material.uniforms.uProj.value.elements).toEqual(camera.projectionMatrix.elements);
    expect(material.uniforms.uInvProj.value.elements).toEqual(camera.projectionMatrixInverse.elements);
    expect(material.uniforms.uCameraWorld.value.elements).toEqual(camera.matrixWorld.elements);
  });
});

describe("viewer ShaderMaterials", () => {
  const BUILTIN_ATTR_RE = /^\s*(?:attribute|in)\s+\S+\s+(position|normal|uv)\s*;/m;
  const BUILTIN_UNIFORM_RE =
    /^\s*uniform\s+\S+\s+(modelMatrix|modelViewMatrix|projectionMatrix|viewMatrix|normalMatrix|cameraPosition|clippingPlanes)\b/m;

  it("never redeclare Three.js built-in attributes or uniforms", () => {
    const materials: [string, THREE.ShaderMaterial][] = [
      ["infiniteGrid", createInfiniteGrid().material as THREE.ShaderMaterial],
      ["sectionCap", createSectionCap().material as THREE.ShaderMaterial],
      ["partSilhouette", createPartSilhouetteMaterial(1.5, "light")],
      ["curvedSilhouetteLines", createCurvedSilhouetteLineMaterial("light")],
    ];

    for (const [name, mat] of materials) {
      expect(mat.vertexShader, `${name} vertexShader attr`).not.toMatch(BUILTIN_ATTR_RE);
      expect(mat.vertexShader, `${name} vertexShader uniform`).not.toMatch(BUILTIN_UNIFORM_RE);
      expect(mat.fragmentShader, `${name} fragmentShader uniform`).not.toMatch(BUILTIN_UNIFORM_RE);
    }
  });

  it("configures part silhouette for screen-space back-face clipping outline in light and dark themes", () => {
    const light = createPartSilhouetteMaterial(1.8, "light");
    const dark = createPartSilhouetteMaterial(1.8, "dark");

    expect(light.side).toBe(THREE.BackSide);
    expect(light.clipping).toBe(true);
    expect(light.transparent).toBe(true);
    expect(light.depthWrite).toBe(false);
    expect(light.depthTest).toBe(true);
    expect(light.polygonOffset).toBe(true);
    expect(light.uniforms.outlinePx.value).toBe(1.8);
    expect(light.uniforms.uResolution.value).toBeInstanceOf(THREE.Vector2);
    expect(light.uniforms.outlineColor.value.getHex()).toBe(0x171d21);
    expect(dark.uniforms.outlineColor.value.getHex()).toBe(0xc4ccd1);
  });
});

describe("computeSmoothNormals", () => {
  it("welds normals by position so split bevel/box faces share a continuous outward normal", () => {
    const nonIndexed = new THREE.BoxGeometry(20, 20, 20).toNonIndexed();
    const smooth = computeSmoothNormals(nonIndexed);
    expect(smooth.count).toBe(nonIndexed.getAttribute("position").count);

    // Pick corner (10, 10, 10) across multiple faces and verify all copies get the same welded diagonal normal.
    const pos = nonIndexed.getAttribute("position");
    const cornerNormals: number[][] = [];
    for (let i = 0; i < pos.count; i += 1) {
      if (
        Math.abs(pos.getX(i) - 10) < 1e-4 &&
        Math.abs(pos.getY(i) - 10) < 1e-4 &&
        Math.abs(pos.getZ(i) - 10) < 1e-4
      ) {
        cornerNormals.push([smooth.getX(i), smooth.getY(i), smooth.getZ(i)]);
      }
    }
    expect(cornerNormals.length).toBeGreaterThanOrEqual(3);
    const invSqrt3 = 1 / Math.sqrt(3);
    for (const [nx, ny, nz] of cornerNormals) {
      expect(nx).toBeCloseTo(invSqrt3, 4);
      expect(ny).toBeCloseTo(invSqrt3, 4);
      expect(nz).toBeCloseTo(invSqrt3, 4);
    }
  });
});

describe("applyPartStyle display modes", () => {
  function makeEntry(): PartCacheEntry {
    const group = new THREE.Group();
    const meshMaterial = new THREE.MeshStandardMaterial();
    const edgeMaterial = new THREE.LineBasicMaterial({ transparent: true });
    const tangentMaterial = new THREE.LineBasicMaterial({ transparent: true });
    const smoothMaterial = createCurvedSilhouetteLineMaterial("light");
    const silhouetteMaterial = createPartSilhouetteMaterial(1.25, "light");
    const geom = new THREE.BoxGeometry(10, 10, 10);
    const mesh = new THREE.Mesh(geom, meshMaterial);
    const tangentLines = new THREE.LineSegments(geom, tangentMaterial);
    const smoothLines = new THREE.LineSegments(geom, smoothMaterial);
    const silhouette = new THREE.Mesh(geom, silhouetteMaterial);
    group.add(mesh, tangentLines, smoothLines, silhouette);
    return {
      geometryKey: "k",
      styleKey: "s",
      group,
      meshMaterial,
      edgeMaterial,
      tangentMaterial,
      tangentLines,
      smoothLines,
      silhouette,
      disposables: [
        geom,
        meshMaterial,
        edgeMaterial,
        tangentMaterial,
        smoothMaterial,
        silhouetteMaterial,
      ],
    };
  }

  const baseStyle = {
    name: "Body",
    color: "#8fa1b3",
    metalness: 0.4,
    roughness: 0.5,
    isSelected: false,
    isTransparent: false,
    isClearance: false,
    hasIssue: false,
    isAffected: false,
    isAnimating: false,
    isGhost: false,
    isHovered: false,
    isDimmed: false,
  };

  it("applies shaded, shadedEdges, hiddenLine, wireframe and silhouettes toggle accurately", () => {
    const entry = makeEntry();
    const mesh = entry.group.children[0] as THREE.Mesh;

    applyPartStyle(entry, baseStyle, "light", "shaded", true);
    expect(entry.meshMaterial.colorWrite).toBe(true);
    expect(entry.edgeMaterial.visible).toBe(false);
    expect(entry.tangentMaterial?.visible).toBe(false);
    expect(entry.smoothLines?.visible).toBe(false);
    expect(entry.silhouette?.visible).toBe(true);
    expect(mesh.castShadow).toBe(true);

    applyPartStyle(entry, baseStyle, "light", "shadedEdges", false);
    expect(entry.meshMaterial.colorWrite).toBe(true);
    expect(entry.edgeMaterial.visible).toBe(true);
    expect(entry.tangentMaterial?.visible).toBe(false);
    expect(entry.smoothLines?.visible).toBe(false);
    expect(entry.silhouette?.visible).toBe(false);

    applyPartStyle(entry, baseStyle, "light", "hiddenLine", true);
    expect(entry.meshMaterial.colorWrite).toBe(true);
    expect(entry.meshMaterial.emissiveIntensity).toBe(1);
    expect(entry.meshMaterial.emissive.getHex()).toBe(0xffffff);
    expect(entry.edgeMaterial.visible).toBe(true);
    expect(entry.tangentMaterial?.visible).toBe(true);
    expect(entry.smoothLines?.visible).toBe(true);
    expect(entry.silhouette?.visible).toBe(false);

    applyPartStyle(entry, baseStyle, "light", "wireframe", true);
    expect(entry.meshMaterial.colorWrite).toBe(false);
    expect(entry.meshMaterial.depthWrite).toBe(false);
    expect(entry.edgeMaterial.visible).toBe(true);
    expect(entry.tangentMaterial?.visible).toBe(true);
    expect(entry.smoothLines?.visible).toBe(true);
    expect(entry.silhouette?.visible).toBe(false);
    expect(mesh.castShadow).toBe(false);

    applyPartStyle(entry, baseStyle, "light", "wireframe", false);
    expect(entry.tangentMaterial?.visible).toBe(true);
    expect(entry.smoothLines?.visible).toBe(false);
  });
});
