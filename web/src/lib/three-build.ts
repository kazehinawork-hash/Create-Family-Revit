import * as THREE from "three";
import { Brush, Evaluator, SUBTRACTION } from "three-bvh-csg";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ResolvedPart, ResolvedSolid } from "@family/spec-core";

const evaluator = new Evaluator();
evaluator.useGroups = false;
evaluator.attributes = ["position", "normal"];

const UP = new THREE.Vector3(0, 1, 0);
const CORNER_SEGMENTS = 8;

function roundedRectShape(width: number, depth: number, radius: number): THREE.Shape {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const r = Math.max(0, Math.min(radius, halfWidth, halfDepth));
  const corners: [number, number, number][] = [
    [halfWidth - r, halfDepth - r, 0],
    [-(halfWidth - r), halfDepth - r, Math.PI / 2],
    [-(halfWidth - r), -(halfDepth - r), Math.PI],
    [halfWidth - r, -(halfDepth - r), (3 * Math.PI) / 2],
  ];

  const shape = new THREE.Shape();
  let started = false;
  for (const [cx, cy, start] of corners) {
    for (let step = 0; step <= CORNER_SEGMENTS; step += 1) {
      const angle = start + (step / CORNER_SEGMENTS) * (Math.PI / 2);
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (started) shape.lineTo(x, y);
      else {
        shape.moveTo(x, y);
        started = true;
      }
    }
  }
  shape.closePath();
  return shape;
}

function prepare(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  let result = geometry;
  if (!result.index) result = mergeVertices(result, 1e-4);
  if (!result.getAttribute("normal")) result.computeVertexNormals();
  result.deleteAttribute("uv");
  result.deleteAttribute("uv1");
  return result;
}

function axisDirection(axis: "x" | "y" | "z", sign: number): THREE.Vector3 {
  const direction = new THREE.Vector3();
  direction[axis] = sign >= 0 ? 1 : -1;
  return direction;
}

export function solidGeometry(solid: ResolvedSolid): THREE.BufferGeometry {
  if (solid.kind === "box") {
    const { origin, size } = solid;
    const width = Math.abs(size.x) || 0.01;
    const depth = Math.abs(size.y) || 0.01;
    const height = Math.abs(size.z) || 0.01;

    let geometry: THREE.BufferGeometry;
    if (solid.cornerRadius > 0) {
      geometry = new THREE.ExtrudeGeometry(roundedRectShape(width, depth, solid.cornerRadius), {
        depth: height,
        bevelEnabled: false,
        steps: 1,
        curveSegments: 4,
      });
      if (size.z < 0) geometry.translate(0, 0, size.z);
    } else {
      geometry = new THREE.BoxGeometry(width, depth, height);
      geometry.translate(0, 0, size.z / 2);
    }

    if (solid.rotationZ) geometry.rotateZ((solid.rotationZ * Math.PI) / 180);
    geometry.translate(origin.x, origin.y, origin.z);
    return geometry;
  }

  if (solid.kind === "cylinder") {
    const height = Math.abs(solid.height);
    // Chord length ~10 mm: small pipes stay light, large drums get smooth circles.
    const adaptiveSegments = Math.ceil((2 * Math.PI * solid.radius) / 10);
    const segments = Math.min(96, Math.max(16, solid.segments, adaptiveSegments));
    let geometry: THREE.BufferGeometry;

    if (solid.innerRadius > 0) {
      const profile = [
        new THREE.Vector2(solid.innerRadius, 0),
        new THREE.Vector2(solid.radius, 0),
        new THREE.Vector2(solid.radius, height),
        new THREE.Vector2(solid.innerRadius, height),
        new THREE.Vector2(solid.innerRadius, 0),
      ];
      geometry = new THREE.LatheGeometry(profile, segments);
    } else {
      geometry = new THREE.CylinderGeometry(solid.radius, solid.radius, height, segments, 1, false);
      geometry.translate(0, height / 2, 0);
    }

    const direction = axisDirection(solid.axis, solid.height);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, direction);
    geometry.applyQuaternion(quaternion);
    geometry.translate(solid.base.x, solid.base.y, solid.base.z);
    return geometry;
  }

  if (solid.kind === "frustum") {
    const height = Math.abs(solid.height);
    const radius = Math.max(solid.radiusBottom, solid.radiusTop);
    const adaptiveSegments = Math.ceil((2 * Math.PI * radius) / 10);
    const segments = Math.min(96, Math.max(16, solid.segments, adaptiveSegments));
    const geometry = new THREE.CylinderGeometry(
      solid.radiusTop,
      solid.radiusBottom,
      height,
      segments,
      1,
      false,
    );
    geometry.translate(0, height / 2, 0);

    const direction = axisDirection(solid.axis, solid.height);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, direction);
    geometry.applyQuaternion(quaternion);
    geometry.translate(solid.base.x, solid.base.y, solid.base.z);
    return geometry;
  }

  if (solid.kind === "bend") {
    const arc = (solid.angle * Math.PI) / 180;
    const tubular = Math.min(96, Math.max(8, solid.segments));
    const geometry = new THREE.TorusGeometry(
      solid.radius,
      solid.tubeRadius,
      12,
      tubular,
      arc,
    );

    // Three builds the torus around +Y with the ring in XZ; rotate that axis onto the
    // plane normal, then apply the start angle around the same axis.
    const axis =
      solid.plane === "xy"
        ? new THREE.Vector3(0, 0, 1)
        : solid.plane === "xz"
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(1, 0, 0);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, axis));

    if (solid.startAngle) {
      geometry.applyMatrix4(
        new THREE.Matrix4().makeRotationAxis(axis, (solid.startAngle * Math.PI) / 180),
      );
    }

    geometry.translate(solid.center.x, solid.center.y, solid.center.z);
    return geometry;
  }

  const shape = new THREE.Shape(solid.points.map(([a, b]) => new THREE.Vector2(a, b)));
  const depth = Math.max(Math.abs(solid.to - solid.from), 0.01);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 12,
  });

  const low = Math.min(solid.from, solid.to);
  const high = Math.max(solid.from, solid.to);

  if (solid.plane === "xy") {
    geometry.translate(0, 0, low);
  } else if (solid.plane === "xz") {
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, high, 0);
  } else {
    const basis = new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);
    geometry.applyMatrix4(basis);
    geometry.translate(low, 0, 0);
  }

  return geometry;
}

export interface PartGeometry {
  geometry: THREE.BufferGeometry;
  hasCuts: boolean;
  cutFailed: boolean;
}

/**
 * Edge lines for a CSG result. EdgesGeometry keeps edges that only have one adjacent
 * face, and CSG leaves plenty of those along its triangulation — they show up as
 * diagonal scratches across flat faces. Only real two-face creases are kept here.
 *
 * Vertices are welded by position first (CSG returns per-triangle vertices), then
 * edges are keyed by an integer pair. The previous string-keyed version allocated a
 * map entry and two vectors per edge, which dominated the main thread on big cuts.
 */
export function csgEdgeGeometry(geometry: THREE.BufferGeometry, thresholdDeg = 24): THREE.BufferGeometry {
  const position = geometry.getAttribute("position");
  if (!position) return new THREE.BufferGeometry();

  // Guard: a pathological cut is not worth freezing the viewer for an outline.
  const sourceIndex = geometry.getIndex();
  const triangleCount = Math.floor((sourceIndex ? sourceIndex.count : position.count) / 3);
  if (triangleCount > 400_000) return new THREE.BufferGeometry();

  const sourceCount = position.count;
  const lookup = new Map<string, number>();
  const welded: number[] = [];
  const remap = new Uint32Array(sourceCount);

  for (let i = 0; i < sourceCount; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = `${Math.round(x * 1000)}|${Math.round(y * 1000)}|${Math.round(z * 1000)}`;
    let index = lookup.get(key);
    if (index === undefined) {
      index = welded.length / 3;
      lookup.set(key, index);
      welded.push(x, y, z);
    }
    remap[i] = index;
  }

  const indices = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < indices.length; i += 1) {
    indices[i] = remap[sourceIndex ? sourceIndex.getX(i) : i];
  }

  const faceNormals = new Float32Array(triangleCount * 3);
  const ax = { x: 0, y: 0, z: 0 };
  const bx = { x: 0, y: 0, z: 0 };
  const cx = { x: 0, y: 0, z: 0 };

  const point = (index: number, target: { x: number; y: number; z: number }) => {
    target.x = welded[index * 3];
    target.y = welded[index * 3 + 1];
    target.z = welded[index * 3 + 2];
  };

  for (let face = 0; face < triangleCount; face += 1) {
    point(indices[face * 3], ax);
    point(indices[face * 3 + 1], bx);
    point(indices[face * 3 + 2], cx);
    const ux = bx.x - ax.x;
    const uy = bx.y - ax.y;
    const uz = bx.z - ax.z;
    const vx = cx.x - ax.x;
    const vy = cx.y - ax.y;
    const vz = cx.z - ax.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    faceNormals[face * 3] = nx;
    faceNormals[face * 3 + 1] = ny;
    faceNormals[face * 3 + 2] = nz;
  }

  const vertexCount = welded.length / 3;
  // faceA is the first face using the edge, faceB the second; -2 marks non-manifold.
  const edges = new Map<number, { faceA: number; faceB: number }>();

  const register = (from: number, to: number, face: number) => {
    const lo = from < to ? from : to;
    const hi = from < to ? to : from;
    const key = lo * vertexCount + hi;
    const edge = edges.get(key);
    if (!edge) {
      edges.set(key, { faceA: face, faceB: -1 });
    } else if (edge.faceB === -1 && edge.faceA !== face) {
      edge.faceB = face;
    } else {
      edge.faceB = -2;
    }
  };

  for (let face = 0; face < triangleCount; face += 1) {
    const a = indices[face * 3];
    const b = indices[face * 3 + 1];
    const c = indices[face * 3 + 2];
    register(a, b, face);
    register(b, c, face);
    register(c, a, face);
  }

  const threshold = Math.cos((thresholdDeg * Math.PI) / 180);
  const points: number[] = [];

  for (const [key, edge] of edges) {
    if (edge.faceB < 0) continue;
    const a = edge.faceA * 3;
    const b = edge.faceB * 3;
    const dot =
      faceNormals[a] * faceNormals[b] +
      faceNormals[a + 1] * faceNormals[b + 1] +
      faceNormals[a + 2] * faceNormals[b + 2];
    if (dot >= threshold) continue;

    const lo = Math.floor(key / vertexCount);
    const hi = key - lo * vertexCount;
    points.push(
      welded[lo * 3], welded[lo * 3 + 1], welded[lo * 3 + 2],
      welded[hi * 3], welded[hi * 3 + 1], welded[hi * 3 + 2],
    );
  }

  const outline = new THREE.BufferGeometry();
  outline.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return outline;
}

/**
 * One LineSegments for every copy in an array instead of one per copy. Vertices are
 * cheap compared with draw calls, and the solid itself is drawn as an InstancedMesh.
 */
export function instanceEdgeGeometry(
  edgeGeometry: THREE.BufferGeometry,
  count: number,
  axis: "x" | "y" | "z",
  spacing: number,
): THREE.BufferGeometry | null {
  const position = edgeGeometry.getAttribute("position");
  if (!position || count < 2) return null;

  const perCopy = position.count;
  const total = perCopy * count;
  if (total > 800_000) return null;

  const out = new Float32Array(total * 3);
  let offset = 0;
  for (let copy = 0; copy < count; copy += 1) {
    const dx = axis === "x" ? spacing * copy : 0;
    const dy = axis === "y" ? spacing * copy : 0;
    const dz = axis === "z" ? spacing * copy : 0;
    for (let vertex = 0; vertex < perCopy; vertex += 1) {
      out[offset] = position.getX(vertex) + dx;
      out[offset + 1] = position.getY(vertex) + dy;
      out[offset + 2] = position.getZ(vertex) + dz;
      offset += 3;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(out, 3));
  return geometry;
}

export function buildPartGeometry(part: ResolvedPart): PartGeometry {
  let geometry = prepare(solidGeometry(part.solid));
  let cutFailed = false;

  for (const cut of part.cuts) {
    try {
      const cutter = prepare(solidGeometry(cut));
      const left = new Brush(geometry);
      const right = new Brush(cutter);
      left.updateMatrixWorld();
      right.updateMatrixWorld();
      const result = evaluator.evaluate(left, right, SUBTRACTION);
      result.geometry.deleteAttribute("uv");
      geometry = result.geometry;
    } catch {
      cutFailed = true;
    }
  }

  return { geometry, hasCuts: part.cuts.length > 0, cutFailed };
}

export function partColor(part: ResolvedPart, materials: { name: string; color?: string }[]): string {
  if (part.color) return part.color;
  const material = materials.find((entry) => entry.name === part.material);
  return material?.color ?? "#a9aeb2";
}

export function partMaterialProps(
  part: ResolvedPart,
  materials: { name: string; color?: string; metalness?: number; roughness?: number }[],
): { metalness: number; roughness: number } {
  const material = materials.find((entry) => entry.name === part.material);
  return {
    metalness: material?.metalness ?? 0.2,
    roughness: material?.roughness ?? 0.6,
  };
}
