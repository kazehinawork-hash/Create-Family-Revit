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
 */
export function csgEdgeGeometry(geometry: THREE.BufferGeometry, thresholdDeg = 24): THREE.BufferGeometry {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  const keyOf = (vector: THREE.Vector3): string =>
    `${vector.x.toFixed(3)}|${vector.y.toFixed(3)}|${vector.z.toFixed(3)}`;

  interface Edge {
    a: THREE.Vector3;
    b: THREE.Vector3;
    normals: THREE.Vector3[];
  }

  const edges = new Map<string, Edge>();
  const addEdge = (p: THREE.Vector3, q: THREE.Vector3) => {
    const keyP = keyOf(p);
    const keyQ = keyOf(q);
    if (keyP === keyQ) return;
    const key = keyP < keyQ ? `${keyP}~${keyQ}` : `${keyQ}~${keyP}`;
    let edge = edges.get(key);
    if (!edge) {
      edge = { a: p.clone(), b: q.clone(), normals: [] };
      edges.set(key, edge);
    }
    edge.normals.push(normal.clone());
  };

  const count = index ? index.count : position.count;
  for (let i = 0; i < count; i += 3) {
    const ia = index ? index.getX(i) : i;
    const ib = index ? index.getX(i + 1) : i + 1;
    const ic = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    normal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  const threshold = Math.cos((thresholdDeg * Math.PI) / 180);
  const points: number[] = [];
  for (const edge of edges.values()) {
    if (edge.normals.length !== 2) continue;
    if (edge.normals[0].dot(edge.normals[1]) >= threshold) continue;
    points.push(edge.a.x, edge.a.y, edge.a.z, edge.b.x, edge.b.y, edge.b.z);
  }

  const outline = new THREE.BufferGeometry();
  outline.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return outline;
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
