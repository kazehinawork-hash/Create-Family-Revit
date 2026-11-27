import * as THREE from "three";
import { Brush, Evaluator, SUBTRACTION } from "three-bvh-csg";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ResolvedPart, ResolvedSolid } from "@family/spec-core";

const evaluator = new Evaluator();
evaluator.useGroups = false;
evaluator.attributes = ["position", "normal"];

const UP = new THREE.Vector3(0, 1, 0);

export type PreviewQuality = "standard" | "high";

const QUALITY: Record<
  PreviewQuality,
  { chord: number; min: number; max: number; corner: number; extrude: number; bendMax: number }
> = {
  standard: { chord: 10, min: 12, max: 96, corner: 8, extrude: 4, bendMax: 96 },
  high: { chord: 4, min: 20, max: 192, corner: 16, extrude: 12, bendMax: 160 },
};

function roundedRectShape(
  width: number,
  depth: number,
  radius: number,
  cornerSegments: number,
): THREE.Shape {
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
    for (let step = 0; step <= cornerSegments; step += 1) {
      const angle = start + (step / cornerSegments) * (Math.PI / 2);
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

function cylinderSegments(
  radius: number,
  requested: number,
  quality: PreviewQuality = "high",
): number {
  const config = QUALITY[quality];
  const chord = Math.ceil(
    (2 * Math.PI * Math.max(Math.abs(radius), 1)) / config.chord,
  );
  return Math.min(config.max, Math.max(config.min, requested, chord));
}

function pushTriangle(indices: number[], handed: number, a: number, b: number, c: number): void {
  if (handed >= 0) indices.push(a, b, c);
  else indices.push(a, c, b);
}

/**
 * Reverses triangle winding in place so a reflection matrix (det < 0, e.g. the
 * `xz` plane axis swap) keeps outward-facing triangles and positive volume.
 */
function flipTriangleWinding(geometry: THREE.BufferGeometry): void {
  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
    index.needsUpdate = true;
    return;
  }

  const position = geometry.getAttribute("position");
  if (!position) return;

  for (const attr of Object.values(geometry.attributes)) {
    const size = attr.itemSize;
    const array = attr.array as Float32Array;
    for (let i = 0; i + 2 < position.count; i += 3) {
      const i1 = (i + 1) * size;
      const i2 = (i + 2) * size;
      for (let k = 0; k < size; k += 1) {
        const tmp = array[i1 + k];
        array[i1 + k] = array[i2 + k];
        array[i2 + k] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
}

function applyBasisMatrix(geometry: THREE.BufferGeometry, basis: THREE.Matrix4): void {
  geometry.applyMatrix4(basis);
  if (basis.determinant() < 0) flipTriangleWinding(geometry);
}

/**
 * Three's TorusGeometry always lies in the XY plane around Z. A bend needs the ring in
 * the plane named by the spec (xy / xz / yz), a start angle, and flat end caps so it
 * matches the solid Revolution built in Revit.
 */
function bendGeometry(
  solid: Extract<ResolvedSolid, { kind: "bend" }>,
  quality: PreviewQuality = "high",
): THREE.BufferGeometry {
  const config = QUALITY[quality];
  const u =
    solid.plane === "yz" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const v =
    solid.plane === "xy" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const n =
    solid.plane === "xy"
      ? new THREE.Vector3(0, 0, 1)
      : solid.plane === "xz"
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
  const handed = u.clone().cross(v).dot(n) >= 0 ? 1 : -1;

  const start = (solid.startAngle * Math.PI) / 180;
  const sweep = (solid.angle * Math.PI) / 180;
  const tubular = Math.min(
    config.bendMax,
    Math.max(
      config.min,
      solid.segments,
      Math.ceil((Math.abs(sweep) * solid.radius) / config.chord),
    ),
  );
  const radial = cylinderSegments(solid.tubeRadius, solid.segments, quality);
  const rows = radial + 1;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const base = new THREE.Vector3(solid.center.x, solid.center.y, solid.center.z);
  const pointAt = (angle: number): { center: THREE.Vector3; radial: THREE.Vector3 } => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const radialDirection = new THREE.Vector3()
      .addScaledVector(u, cos)
      .addScaledVector(v, sin)
      .normalize();
    return {
      center: base.clone().addScaledVector(radialDirection, solid.radius),
      radial: radialDirection,
    };
  };

  for (let i = 0; i <= tubular; i += 1) {
    const { center, radial: radialDirection } = pointAt(start + (sweep * i) / tubular);
    for (let j = 0; j <= radial; j += 1) {
      const phi = (2 * Math.PI * j) / radial;
      const normal = new THREE.Vector3()
        .addScaledVector(radialDirection, Math.cos(phi))
        .addScaledVector(n, Math.sin(phi));
      const point = center.clone().addScaledVector(normal, solid.tubeRadius);
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
    }
  }

  for (let i = 0; i < tubular; i += 1) {
    for (let j = 0; j < radial; j += 1) {
      const a = i * rows + j;
      const b = (i + 1) * rows + j;
      const c = (i + 1) * rows + j + 1;
      const d = i * rows + j + 1;
      pushTriangle(indices, handed, a, b, d);
      pushTriangle(indices, handed, b, c, d);
    }
  }

  // A partial revolution has a flat disc at each end in Revit; without caps the preview
  // looks like an open pipe.
  if (Math.abs(sweep) < Math.PI * 2 - 1e-9) {
    const caps = [
      { ring: 0, angle: start, sign: -1 },
      { ring: tubular, angle: start + sweep, sign: 1 },
    ];

    for (const cap of caps) {
      const { center } = pointAt(cap.angle);
      const tangent = new THREE.Vector3()
        .addScaledVector(u, -Math.sin(cap.angle))
        .addScaledVector(v, Math.cos(cap.angle))
        .normalize();
      const normal = tangent.multiplyScalar(cap.sign);
      const centerIndex = positions.length / 3;
      positions.push(center.x, center.y, center.z);
      normals.push(normal.x, normal.y, normal.z);

      const ring = cap.ring * rows;
      for (let j = 0; j < radial; j += 1) {
        const a = ring + j;
        const b = ring + j + 1;
        if (cap.sign < 0) pushTriangle(indices, handed, centerIndex, a, b);
        else pushTriangle(indices, handed, centerIndex, b, a);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

function loftPoint(axis: "x" | "y" | "z", at: number, a: number, b: number): THREE.Vector3 {
  if (axis === "x") return new THREE.Vector3(at, a, b);
  if (axis === "y") return new THREE.Vector3(a, at, b);
  return new THREE.Vector3(a, b, at);
}

function signedVolume(positions: number[], indices: number[]): number {
  let volume = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const ia = indices[index] * 3;
    const ib = indices[index + 1] * 3;
    const ic = indices[index + 2] * 3;
    const ax = positions[ia];
    const ay = positions[ia + 1];
    const az = positions[ia + 2];
    const bx = positions[ib];
    const by = positions[ib + 1];
    const bz = positions[ib + 2];
    const cx = positions[ic];
    const cy = positions[ic + 1];
    const cz = positions[ic + 2];
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return volume / 6;
}

function loftGeometry(solid: Extract<ResolvedSolid, { kind: "loft" }>): THREE.BufferGeometry {
  const sections = solid.sections;
  const count = sections[0]?.points.length ?? 0;
  if (sections.length < 2 || count < 3) return new THREE.BufferGeometry();

  const positions: number[] = [];
  for (const section of sections) {
    for (const [a, b] of section.points) {
      const point = loftPoint(solid.axis, section.at, a, b);
      positions.push(point.x, point.y, point.z);
    }
  }

  const indices: number[] = [];
  for (let section = 0; section < sections.length - 1; section += 1) {
    for (let point = 0; point < count; point += 1) {
      const next = (point + 1) % count;
      const a = section * count + point;
      const b = (section + 1) * count + point;
      const c = (section + 1) * count + next;
      const d = section * count + next;
      indices.push(a, b, d, b, c, d);
    }
  }

  const contour = sections[0].points.map(([a, b]) => new THREE.Vector2(a, b));
  const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
  const last = (sections.length - 1) * count;
  for (const [a, b, c] of triangles) {
    indices.push(a, c, b);
    indices.push(last + a, last + b, last + c);
  }

  if (signedVolume(positions, indices) < 0) {
    for (let index = 0; index < indices.length; index += 3) {
      const swap = indices[index + 1];
      indices[index + 1] = indices[index + 2];
      indices[index + 2] = swap;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function signedArea2D(points: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/**
 * Normalizes profile winding in (r, h), builds a LatheGeometry around Y, and
 * closes partial revolutions (< 360°) with outward-facing flat end caps so every
 * revolve has positive signed volume and outward normals regardless of point order.
 */
function revolveGeometry(solid: Extract<ResolvedSolid, { kind: "revolve" }>): THREE.BufferGeometry {
  let points = solid.points.map(([r, h]) => new THREE.Vector2(Math.max(0, Math.abs(r)), h));
  if (points.length >= 3 && signedArea2D(points) < 0) {
    points = [...points].reverse();
  }

  const segments = Math.min(96, Math.max(12, solid.segments || 32));
  const rawAngle = solid.angle === 0 ? 360 : solid.angle;
  const clampedAngle = Math.max(-360, Math.min(360, rawAngle));
  const phiStart = ((solid.startAngle + (clampedAngle < 0 ? clampedAngle : 0)) * Math.PI) / 180;
  const phiLength = (Math.abs(clampedAngle) * Math.PI) / 180;

  const geometry = new THREE.LatheGeometry(points, segments, phiStart, phiLength);
  geometry.computeVertexNormals();

  if (phiLength < Math.PI * 2 - 1e-6) {
    const contour: THREE.Vector2[] = [];
    for (const point of points) {
      const prev = contour[contour.length - 1];
      if (!prev || prev.distanceToSquared(point) > 1e-8) contour.push(point);
    }
    if (contour.length > 1 && contour[contour.length - 1].distanceToSquared(contour[0]) <= 1e-8) {
      contour.pop();
    }

    if (contour.length >= 3) {
      const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
      if (triangles.length > 0) {
        const posAttr = geometry.getAttribute("position");
        const normAttr = geometry.getAttribute("normal");
        const uvAttr = geometry.getAttribute("uv");
        const idxAttr = geometry.getIndex();

        const positions = Array.from(posAttr.array as Float32Array);
        const normals = Array.from(normAttr.array as Float32Array);
        const uvs = Array.from(uvAttr.array as Float32Array);
        const indices = idxAttr
          ? Array.from(idxAttr.array as Uint16Array | Uint32Array)
          : Array.from({ length: posAttr.count }, (_, i) => i);

        const caps = [
          { angle: phiStart, sign: -1 },
          { angle: phiStart + phiLength, sign: 1 },
        ];
        const vA = new THREE.Vector3();
        const vB = new THREE.Vector3();
        const vC = new THREE.Vector3();
        const e1 = new THREE.Vector3();
        const e2 = new THREE.Vector3();
        const faceNormal = new THREE.Vector3();

        for (const cap of caps) {
          const sin = Math.sin(cap.angle);
          const cos = Math.cos(cap.angle);
          const outward = new THREE.Vector3(cap.sign * cos, 0, -cap.sign * sin);
          const baseIndex = positions.length / 3;

          for (const pt of contour) {
            positions.push(pt.x * sin, pt.y, pt.x * cos);
            normals.push(outward.x, outward.y, outward.z);
            uvs.push(0, 0);
          }

          for (const [ia, ib, ic] of triangles) {
            const pA = contour[ia];
            const pB = contour[ib];
            const pC = contour[ic];
            vA.set(pA.x * sin, pA.y, pA.x * cos);
            vB.set(pB.x * sin, pB.y, pB.x * cos);
            vC.set(pC.x * sin, pC.y, pC.x * cos);
            e1.subVectors(vB, vA);
            e2.subVectors(vC, vA);
            faceNormal.crossVectors(e1, e2);
            if (faceNormal.dot(outward) >= 0) {
              indices.push(baseIndex + ia, baseIndex + ib, baseIndex + ic);
            } else {
              indices.push(baseIndex + ia, baseIndex + ic, baseIndex + ib);
            }
          }
        }

        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
      }
    }
  }

  // LatheGeometry rotates around Y axis (x = radius, y = height).
  // Map Y axis to solid.axis:
  if (solid.axis === "z") {
    geometry.rotateX(Math.PI / 2);
  } else if (solid.axis === "x") {
    geometry.rotateZ(-Math.PI / 2);
  }
  geometry.translate(solid.origin.x, solid.origin.y, solid.origin.z);
  return geometry;
}

export function solidGeometry(
  solid: ResolvedSolid,
  quality: PreviewQuality = "high",
): THREE.BufferGeometry {
  const config = QUALITY[quality];

  if (solid.kind === "box") {
    const { origin, size } = solid;
    const width = Math.abs(size.x) || 0.01;
    const depth = Math.abs(size.y) || 0.01;
    const height = Math.abs(size.z) || 0.01;

    let geometry: THREE.BufferGeometry;
    if (solid.cornerRadius > 0) {
      geometry = new THREE.ExtrudeGeometry(
        roundedRectShape(width, depth, solid.cornerRadius, config.corner),
        {
          depth: height,
          bevelEnabled: false,
          steps: 1,
          curveSegments: config.extrude,
        },
      );
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
    // Chord length is quality-dependent: small pipes stay light, large drums get smoother.
    const segments = cylinderSegments(solid.radius, solid.segments, quality);
    let geometry: THREE.BufferGeometry;

    if (solid.innerRadius > 0) {
      const shape = new THREE.Shape();
      shape.absarc(0, 0, solid.radius, 0, Math.PI * 2, false);
      const holePath = new THREE.Path();
      holePath.absarc(0, 0, solid.innerRadius, 0, Math.PI * 2, true);
      shape.holes.push(holePath);

      // Extrude in 2D (X, Y) along Z by `height`.
      // Rotate by +90 around X so extrusion axis Z aligns with UP (0, 1, 0),
      // exactly matching CylinderGeometry before applyQuaternion(quaternion).
      geometry = new THREE.ExtrudeGeometry(shape, {
        depth: height,
        bevelEnabled: false,
        curveSegments: Math.max(config.min, Math.floor(segments * 0.75)),
      });
      geometry.rotateX(-Math.PI / 2);
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
    const segments = cylinderSegments(radius, solid.segments, quality);
    // A negative height leaves the base where Revit puts it: the radii swap, then the
    // whole form runs backwards along the axis.
    const topRadius = solid.height >= 0 ? solid.radiusTop : solid.radiusBottom;
    const bottomRadius = solid.height >= 0 ? solid.radiusBottom : solid.radiusTop;
    const geometry = new THREE.CylinderGeometry(
      topRadius,
      bottomRadius,
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
    return bendGeometry(solid, quality);
  }

  if (solid.kind === "loft") {
    return loftGeometry(solid);
  }

  if (solid.kind === "revolve") {
    return revolveGeometry(solid);
  }

  if (solid.kind === "tube") {
    const direction = new THREE.Vector3(
      solid.direction.x,
      solid.direction.y,
      solid.direction.z,
    ).normalize();
    const segments = cylinderSegments(solid.radius, solid.segments, quality);

    if (solid.innerRadius > 0) {
      const shape = new THREE.Shape();
      shape.absarc(0, 0, solid.radius, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, solid.innerRadius, 0, Math.PI * 2, true);
      shape.holes.push(hole);
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: solid.length,
        bevelEnabled: false,
        steps: 1,
        curveSegments: Math.max(config.min, Math.floor(segments * 0.75)),
      });
      geometry.applyQuaternion(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction),
      );
      geometry.translate(solid.start.x, solid.start.y, solid.start.z);
      return geometry;
    }

    const geometry = new THREE.CylinderGeometry(
      solid.radius,
      solid.radius,
      solid.length,
      segments,
      1,
      false,
    );
    geometry.translate(0, solid.length / 2, 0);
    geometry.applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(UP, direction),
    );
    geometry.translate(solid.start.x, solid.start.y, solid.start.z);
    return geometry;
  }

  const shape = new THREE.Shape(solid.points.map(([a, b]) => new THREE.Vector2(a, b)));
  for (const hole of solid.holes) {
    shape.holes.push(new THREE.Path(hole.map(([a, b]) => new THREE.Vector2(a, b))));
  }
  const depth = Math.max(Math.abs(solid.to - solid.from), 0.01);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 12,
  });

  const low = Math.min(solid.from, solid.to);

  if (solid.plane === "xy") {
    geometry.translate(0, 0, low);
  } else if (solid.plane === "xz") {
    // Revit basis for xz: u = BasisX (a -> X), v = BasisZ (b -> Z), axisUnit = BasisY (from/to -> Y)
    // ExtrudeGeometry generates 2D shape in (X, Y) with extrusion along +Z (0 to depth).
    // We map 2D (X, Y) -> (X, Z) and depth (Z) -> Y (det = -1, so flip winding back outward).
    const basis = new THREE.Matrix4().set(
      1, 0, 0, 0,
      0, 0, 1, 0,
      0, 1, 0, 0,
      0, 0, 0, 1
    );
    applyBasisMatrix(geometry, basis);
    geometry.translate(0, low, 0);
  } else {
    // Revit basis for yz: u = BasisY (a -> Y), v = BasisZ (b -> Z), axisUnit = BasisX (from/to -> X)
    // We map 2D (X, Y) -> (Y, Z) and depth (Z) -> X.
    const basis = new THREE.Matrix4().set(
      0, 0, 1, 0,
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0, 1
    );
    applyBasisMatrix(geometry, basis);
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
interface WeldedEdgeGraph {
  welded: number[];
  indices: Uint32Array;
  triangleCount: number;
  vertexCount: number;
  faceNormals: Float32Array;
  edges: Map<number, { faceA: number; faceB: number }>;
}

function buildWeldedEdgeGraph(geometry: THREE.BufferGeometry): WeldedEdgeGraph | null {
  const position = geometry.getAttribute("position");
  if (!position) return null;

  const sourceIndex = geometry.getIndex();
  const triangleCount = Math.floor((sourceIndex ? sourceIndex.count : position.count) / 3);
  if (triangleCount === 0 || triangleCount > 400_000) return null;

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
  for (let face = 0; face < triangleCount; face += 1) {
    const ia = indices[face * 3] * 3;
    const ib = indices[face * 3 + 1] * 3;
    const ic = indices[face * 3 + 2] * 3;
    const ux = welded[ib] - welded[ia];
    const uy = welded[ib + 1] - welded[ia + 1];
    const uz = welded[ib + 2] - welded[ia + 2];
    const vx = welded[ic] - welded[ia];
    const vy = welded[ic + 1] - welded[ia + 1];
    const vz = welded[ic + 2] - welded[ia + 2];
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

  return { welded, indices, triangleCount, vertexCount, faceNormals, edges };
}

export interface PartEdgeGeometries {
  /** Hard feature creases (>= creaseDeg), used in Shaded+Edges, Hidden Line, Wireframe. */
  edges: THREE.BufferGeometry;
  /** Tangent transition seams (flat wall meeting curved fillet/bend) for Wireframe & Hidden Line. */
  tangentEdges: THREE.BufferGeometry;
  /** Smooth curved interior edges with adjacent face normals for view-dependent GPU silhouettes. */
  smoothEdges: THREE.BufferGeometry;
}

function emptySmoothGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
  g.setAttribute("aEdgeMid", new THREE.Float32BufferAttribute([], 3));
  g.setAttribute("aNormalA", new THREE.Float32BufferAttribute([], 3));
  g.setAttribute("aNormalB", new THREE.Float32BufferAttribute([], 3));
  return g;
}

function canonicalEdgeLine(
  ax0: number,
  ay0: number,
  az0: number,
  bx0: number,
  by0: number,
  bz0: number,
) {
  let dx = bx0 - ax0;
  let dy = by0 - ay0;
  let dz = bz0 - az0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return null;
  dx /= len;
  dy /= len;
  dz /= len;
  // Canonical direction sign using dominant axis so near-zero components cannot flip sign.
  if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz)) {
    if (dx < 0) { dx = -dx; dy = -dy; dz = -dz; }
  } else if (Math.abs(dy) >= Math.abs(dz)) {
    if (dy < 0) { dx = -dx; dy = -dy; dz = -dz; }
  } else if (dz < 0) {
    dx = -dx; dy = -dy; dz = -dz;
  }
  const tA = ax0 * dx + ay0 * dy + az0 * dz;
  const tB = bx0 * dx + by0 * dy + bz0 * dz;
  return {
    dirX: dx,
    dirY: dy,
    dirZ: dz,
    perpX: ax0 - dx * tA,
    perpY: ay0 - dy * tA,
    perpZ: az0 - dz * tA,
    tMin: Math.min(tA, tB),
    tMax: Math.max(tA, tB),
  };
}

function pushMergedIntervals(
  intervals: [number, number][],
  dirX: number,
  dirY: number,
  dirZ: number,
  perpX: number,
  perpY: number,
  perpZ: number,
  points: number[],
) {
  if (intervals.length === 0) return;
  intervals.sort((x, y) => x[0] - y[0]);
  let curStart = intervals[0][0];
  let curEnd = intervals[0][1];
  for (let k = 1; k < intervals.length; k += 1) {
    const [s, e] = intervals[k];
    if (s <= curEnd + 1e-3) {
      if (e > curEnd) curEnd = e;
    } else {
      points.push(
        perpX + dirX * curStart, perpY + dirY * curStart, perpZ + dirZ * curStart,
        perpX + dirX * curEnd, perpY + dirY * curEnd, perpZ + dirZ * curEnd,
      );
      curStart = s;
      curEnd = e;
    }
  }
  points.push(
    perpX + dirX * curStart, perpY + dirY * curStart, perpZ + dirZ * curStart,
    perpX + dirX * curEnd, perpY + dirY * curEnd, perpZ + dirZ * curEnd,
  );
}

/**
 * Extracts crisp CAD edge sets from a mesh:
 * - `edges`: hard creases (>= creaseDeg), recovering CSG T-junction splits cleanly.
 * - `tangentEdges`: flat-to-curved tangent seams (e.g. box flat wall to cornerRadius fillet).
 * - `smoothEdges`: curved interior edges tagged with both face normals for GPU horizon silhouettes.
 */
export function extractPartEdges(
  geometry: THREE.BufferGeometry,
  creaseDeg = 24,
  tangentMinDeg = 1.5,
): PartEdgeGeometries {
  const graph = buildWeldedEdgeGraph(geometry);
  if (!graph) {
    return {
      edges: new THREE.BufferGeometry(),
      tangentEdges: new THREE.BufferGeometry(),
      smoothEdges: emptySmoothGeometry(),
    };
  }

  const { welded, indices, triangleCount, vertexCount, faceNormals, edges } = graph;
  const creaseThreshold = Math.cos((creaseDeg * Math.PI) / 180);
  const planarThreshold = Math.cos((tangentMinDeg * Math.PI) / 180);

  // Group coplanar faces (< tangentMinDeg) so tangent seams distinguish wide flat walls from curved facets.
  const parent = new Int32Array(triangleCount);
  for (let f = 0; f < triangleCount; f += 1) parent[f] = f;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (const edge of edges.values()) {
    if (edge.faceB < 0) continue;
    const a = edge.faceA * 3;
    const b = edge.faceB * 3;
    const dot =
      faceNormals[a] * faceNormals[b] +
      faceNormals[a + 1] * faceNormals[b + 1] +
      faceNormals[a + 2] * faceNormals[b + 2];
    if (dot >= planarThreshold) union(edge.faceA, edge.faceB);
  }

  const regionVerts = new Map<number, Set<number>>();
  const ensureRegionVerts = (r: number) => {
    let set = regionVerts.get(r);
    if (!set) {
      set = new Set<number>();
      regionVerts.set(r, set);
    }
    return set;
  };
  for (let f = 0; f < triangleCount; f += 1) {
    const r = find(f);
    const set = ensureRegionVerts(r);
    set.add(indices[f * 3]);
    set.add(indices[f * 3 + 1]);
    set.add(indices[f * 3 + 2]);
  }

  const regionPerpWidth = (
    regionId: number,
    face: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    px: number,
    py: number,
    pz: number,
  ): number => {
    const fn = face * 3;
    const nx = faceNormals[fn];
    const ny = faceNormals[fn + 1];
    const nz = faceNormals[fn + 2];
    let tx = ny * dirZ - nz * dirY;
    let ty = nz * dirX - nx * dirZ;
    let tz = nx * dirY - ny * dirX;
    const tLen = Math.hypot(tx, ty, tz);
    if (tLen < 1e-6) return 0;
    tx /= tLen;
    ty /= tLen;
    tz /= tLen;
    const verts = regionVerts.get(regionId);
    if (!verts) return 0;
    let maxSpan = 0;
    for (const v of verts) {
      const vb = v * 3;
      const dist = Math.abs((welded[vb] - px) * tx + (welded[vb + 1] - py) * ty + (welded[vb + 2] - pz) * tz);
      if (dist > maxSpan) maxSpan = dist;
    }
    return maxSpan;
  };

  const isTangentBoundary = (
    faceA: number,
    faceB: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    px: number,
    py: number,
    pz: number,
  ): boolean => {
    const wA = regionPerpWidth(find(faceA), faceA, dirX, dirY, dirZ, px, py, pz);
    const wB = regionPerpWidth(find(faceB), faceB, dirX, dirY, dirZ, px, py, pz);
    const wSmall = Math.min(wA, wB);
    const wLarge = Math.max(wA, wB);
    return wSmall >= 0.02 && wLarge >= 1.0 && wLarge >= 2.2 * wSmall;
  };

  const creasePoints: number[] = [];
  const tangentPoints: number[] = [];
  const smoothPos: number[] = [];
  const smoothMid: number[] = [];
  const smoothNormA: number[] = [];
  const smoothNormB: number[] = [];

  const pushSmoothSegment = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    faceA: number,
    faceB: number,
  ) => {
    const mx = (ax + bx) * 0.5;
    const my = (ay + by) * 0.5;
    const mz = (az + bz) * 0.5;
    const na = faceA * 3;
    const nb = faceB * 3;
    smoothPos.push(ax, ay, az, bx, by, bz);
    smoothMid.push(mx, my, mz, mx, my, mz);
    smoothNormA.push(
      faceNormals[na], faceNormals[na + 1], faceNormals[na + 2],
      faceNormals[na], faceNormals[na + 1], faceNormals[na + 2],
    );
    smoothNormB.push(
      faceNormals[nb], faceNormals[nb + 1], faceNormals[nb + 2],
      faceNormals[nb], faceNormals[nb + 1], faceNormals[nb + 2],
    );
  };

  interface UnmatchedEdge {
    dirX: number;
    dirY: number;
    dirZ: number;
    perpX: number;
    perpY: number;
    perpZ: number;
    tMin: number;
    tMax: number;
    face: number;
  }
  const unmatchedBuckets = new Map<string, UnmatchedEdge[]>();

  for (const [key, edge] of edges) {
    const lo = Math.floor(key / vertexCount);
    const hi = key - lo * vertexCount;
    const ax0 = welded[lo * 3];
    const ay0 = welded[lo * 3 + 1];
    const az0 = welded[lo * 3 + 2];
    const bx0 = welded[hi * 3];
    const by0 = welded[hi * 3 + 1];
    const bz0 = welded[hi * 3 + 2];

    if (edge.faceB < 0) {
      if (edge.faceB !== -1) continue;
      const line = canonicalEdgeLine(ax0, ay0, az0, bx0, by0, bz0);
      if (!line) continue;
      const bucketKey =
        `${Math.round(line.dirX * 500) || 0}|${Math.round(line.dirY * 500) || 0}|${Math.round(line.dirZ * 500) || 0}|` +
        `${Math.round(line.perpX * 50) || 0}|${Math.round(line.perpY * 50) || 0}|${Math.round(line.perpZ * 50) || 0}`;
      let list = unmatchedBuckets.get(bucketKey);
      if (!list) {
        list = [];
        unmatchedBuckets.set(bucketKey, list);
      }
      list.push({ ...line, face: edge.faceA });
      continue;
    }

    const a = edge.faceA * 3;
    const b = edge.faceB * 3;
    const dot =
      faceNormals[a] * faceNormals[b] +
      faceNormals[a + 1] * faceNormals[b + 1] +
      faceNormals[a + 2] * faceNormals[b + 2];

    if (dot < creaseThreshold) {
      creasePoints.push(ax0, ay0, az0, bx0, by0, bz0);
    } else if (dot < planarThreshold) {
      let dx = bx0 - ax0;
      let dy = by0 - ay0;
      let dz = bz0 - az0;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-4) continue;
      dx /= len;
      dy /= len;
      dz /= len;
      if (isTangentBoundary(edge.faceA, edge.faceB, dx, dy, dz, ax0, ay0, az0)) {
        tangentPoints.push(ax0, ay0, az0, bx0, by0, bz0);
      } else {
        pushSmoothSegment(ax0, ay0, az0, bx0, by0, bz0, edge.faceA, edge.faceB);
      }
    }
  }

  // Recover creases and tangent/smooth boundaries where CSG T-junctions split one side only.
  for (const list of unmatchedBuckets.values()) {
    if (list.length < 2) continue;
    const creaseIntervals: [number, number][] = [];
    const tangentIntervals: [number, number][] = [];
    const ref = list[0];

    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      const na = a.face * 3;
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        const u0 = Math.max(a.tMin, b.tMin);
        const u1 = Math.min(a.tMax, b.tMax);
        if (u1 - u0 <= 1e-3) continue;
        const perpDistSq =
          (a.perpX - b.perpX) ** 2 + (a.perpY - b.perpY) ** 2 + (a.perpZ - b.perpZ) ** 2;
        if (perpDistSq > 0.0025) continue;
        const nb = b.face * 3;
        const dot =
          faceNormals[na] * faceNormals[nb] +
          faceNormals[na + 1] * faceNormals[nb + 1] +
          faceNormals[na + 2] * faceNormals[nb + 2];
        if (dot >= planarThreshold) continue;
        if (dot < creaseThreshold) {
          creaseIntervals.push([u0, u1]);
        } else {
          const px = ref.perpX + ref.dirX * u0;
          const py = ref.perpY + ref.dirY * u0;
          const pz = ref.perpZ + ref.dirZ * u0;
          if (isTangentBoundary(a.face, b.face, ref.dirX, ref.dirY, ref.dirZ, px, py, pz)) {
            tangentIntervals.push([u0, u1]);
          } else {
            pushSmoothSegment(
              ref.perpX + ref.dirX * u0, ref.perpY + ref.dirY * u0, ref.perpZ + ref.dirZ * u0,
              ref.perpX + ref.dirX * u1, ref.perpY + ref.dirY * u1, ref.perpZ + ref.dirZ * u1,
              a.face,
              b.face,
            );
          }
        }
      }
    }

    pushMergedIntervals(
      creaseIntervals, ref.dirX, ref.dirY, ref.dirZ, ref.perpX, ref.perpY, ref.perpZ, creasePoints,
    );
    pushMergedIntervals(
      tangentIntervals, ref.dirX, ref.dirY, ref.dirZ, ref.perpX, ref.perpY, ref.perpZ, tangentPoints,
    );
  }

  const edgeGeom = new THREE.BufferGeometry();
  edgeGeom.setAttribute("position", new THREE.Float32BufferAttribute(creasePoints, 3));

  const tangentGeom = new THREE.BufferGeometry();
  tangentGeom.setAttribute("position", new THREE.Float32BufferAttribute(tangentPoints, 3));

  const smoothGeom = new THREE.BufferGeometry();
  smoothGeom.setAttribute("position", new THREE.Float32BufferAttribute(smoothPos, 3));
  smoothGeom.setAttribute("aEdgeMid", new THREE.Float32BufferAttribute(smoothMid, 3));
  smoothGeom.setAttribute("aNormalA", new THREE.Float32BufferAttribute(smoothNormA, 3));
  smoothGeom.setAttribute("aNormalB", new THREE.Float32BufferAttribute(smoothNormB, 3));

  return { edges: edgeGeom, tangentEdges: tangentGeom, smoothEdges: smoothGeom };
}

/**
 * Edge lines for a CSG result. EdgesGeometry keeps edges that only have one adjacent
 * face, and CSG leaves plenty of those along its triangulation — they show up as
 * diagonal scratches across flat faces. Only real two-face creases (and T-junction splits) are kept here.
 */
export function csgEdgeGeometry(geometry: THREE.BufferGeometry, thresholdDeg = 24): THREE.BufferGeometry {
  return extractPartEdges(geometry, thresholdDeg).edges;
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

  const copyTranslated = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
    const out = new Float32Array(total * 3);
    let offset = 0;
    for (let copy = 0; copy < count; copy += 1) {
      const dx = axis === "x" ? spacing * copy : 0;
      const dy = axis === "y" ? spacing * copy : 0;
      const dz = axis === "z" ? spacing * copy : 0;
      for (let vertex = 0; vertex < perCopy; vertex += 1) {
        out[offset] = attr.getX(vertex) + dx;
        out[offset + 1] = attr.getY(vertex) + dy;
        out[offset + 2] = attr.getZ(vertex) + dz;
        offset += 3;
      }
    }
    return new THREE.BufferAttribute(out, 3);
  };

  const copyVerbatim = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
    const out = new Float32Array(total * 3);
    let offset = 0;
    for (let copy = 0; copy < count; copy += 1) {
      for (let vertex = 0; vertex < perCopy; vertex += 1) {
        out[offset] = attr.getX(vertex);
        out[offset + 1] = attr.getY(vertex);
        out[offset + 2] = attr.getZ(vertex);
        offset += 3;
      }
    }
    return new THREE.BufferAttribute(out, 3);
  };

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", copyTranslated(position));

  const edgeMid = edgeGeometry.getAttribute("aEdgeMid");
  const normalA = edgeGeometry.getAttribute("aNormalA");
  const normalB = edgeGeometry.getAttribute("aNormalB");
  if (edgeMid && normalA && normalB) {
    geometry.setAttribute("aEdgeMid", copyTranslated(edgeMid));
    geometry.setAttribute("aNormalA", copyVerbatim(normalA));
    geometry.setAttribute("aNormalB", copyVerbatim(normalB));
  }

  return geometry;
}

function expandCutterSolid(solid: ResolvedSolid, delta = 0.5): ResolvedSolid {
  switch (solid.kind) {
    case "cylinder": {
      const isPositive = solid.height >= 0;
      const h = Math.abs(solid.height);
      const newHeight = h + delta * 2;
      const base = { ...solid.base };
      base[solid.axis] += isPositive ? -delta : delta;
      return {
        ...solid,
        base,
        height: isPositive ? newHeight : -newHeight,
      };
    }
    case "box": {
      const signZ = solid.size.z >= 0 ? 1 : -1;
      return {
        ...solid,
        origin: {
          x: solid.origin.x,
          y: solid.origin.y,
          z: solid.origin.z - signZ * delta,
        },
        size: {
          x: solid.size.x,
          y: solid.size.y,
          z: solid.size.z + signZ * delta * 2,
        },
      };
    }
    case "prism": {
      const isPositive = solid.to >= solid.from;
      return {
        ...solid,
        from: isPositive ? solid.from - delta : solid.from + delta,
        to: isPositive ? solid.to + delta : solid.to - delta,
      };
    }
    default:
      return solid;
  }
}

export function buildPartGeometry(
  part: ResolvedPart,
  quality: PreviewQuality = "high",
): PartGeometry {
  let geometry = prepare(solidGeometry(part.solid, quality));
  let cutFailed = false;

  for (const cut of part.cuts) {
    try {
      const expandedCut = expandCutterSolid(cut, 0.5);
      const cutter = prepare(solidGeometry(expandedCut, quality));
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
  const name = (material?.name ?? "").toLowerCase();
  const painted = /(paint|sơn|powder|coating|epoxy)/i.test(name);
  const metal = /(steel|inox|stainless|galv|kẽm|thép|metal|aluminium|nhôm)/i.test(name);
  return {
    metalness: material?.metalness ?? (painted ? 0.16 : metal ? 0.62 : 0.38),
    roughness:
      material?.roughness ?? (painted ? 0.5 : metal ? 0.36 : 0.46),
  };
}
