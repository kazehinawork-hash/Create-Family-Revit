import { compileExpression, evaluateNode } from "./expr.js";
import type { ParameterResolution } from "./parameters.js";
import type { Axis, FamilySpec, Issue, Numeric } from "./types.js";

export interface Vec3n {
  x: number;
  y: number;
  z: number;
}

export interface Bounds {
  min: Vec3n;
  max: Vec3n;
  size: Vec3n;
}

export interface ResolvedBox {
  kind: "box";
  origin: Vec3n;
  size: Vec3n;
  rotationZ: number;
  cornerRadius: number;
}

export interface ResolvedCylinder {
  kind: "cylinder";
  base: Vec3n;
  radius: number;
  innerRadius: number;
  height: number;
  axis: Axis;
  segments: number;
}

export interface ResolvedFrustum {
  kind: "frustum";
  base: Vec3n;
  radiusBottom: number;
  radiusTop: number;
  height: number;
  axis: Axis;
  segments: number;
}

export interface ResolvedBend {
  kind: "bend";
  center: Vec3n;
  radius: number;
  tubeRadius: number;
  angle: number;
  startAngle: number;
  plane: "xy" | "xz" | "yz";
  segments: number;
}

export interface ResolvedPrism {
  kind: "prism";
  plane: "xy" | "xz" | "yz";
  points: [number, number][];
  holes: [number, number][][];
  from: number;
  to: number;
}

export interface ResolvedLoftSection {
  at: number;
  points: [number, number][];
}

export interface ResolvedLoft {
  kind: "loft";
  axis: Axis;
  sections: ResolvedLoftSection[];
}

export interface ResolvedRevolve {
  kind: "revolve";
  axis: Axis;
  origin: Vec3n;
  angle: number;
  startAngle: number;
  points: [number, number][];
  segments: number;
}

export interface ResolvedTube {
  kind: "tube";
  start: Vec3n;
  end: Vec3n;
  radius: number;
  innerRadius: number;
  /** Unit vector from start to end. */
  direction: Vec3n;
  length: number;
  segments: number;
}

export type ResolvedSolid =
  | ResolvedBox
  | ResolvedCylinder
  | ResolvedFrustum
  | ResolvedBend
  | ResolvedPrism
  | ResolvedLoft
  | ResolvedRevolve
  | ResolvedTube;

export interface ResolvedPart {
  id: string;
  name: string;
  material?: string;
  color?: string;
  solid: ResolvedSolid;
  cuts: ResolvedSolid[];
  array: { count: number; axis: Axis; spacing: number };
}

export interface ResolvedConnector {
  id: string;
  name: string;
  systemType: string;
  shape: "round" | "rectangular";
  direction: "in" | "out" | "bidirectional";
  origin: Vec3n;
  directionVector: Vec3n;
  width?: number;
  height?: number;
  diameter?: number;
  flow?: number;
  flowUnit?: string;
  pressureDrop?: number;
}

export interface ResolvedModel {
  parts: ResolvedPart[];
  connectors: ResolvedConnector[];
  instances: number;
  issues: Issue[];
  bounds: Bounds | null;
}

export const DEFAULT_SEGMENTS = 48;

function emptyBounds(): Bounds {
  return {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
    size: { x: 0, y: 0, z: 0 },
  };
}

function grow(bounds: Bounds, point: Vec3n): void {
  bounds.min.x = Math.min(bounds.min.x, point.x);
  bounds.min.y = Math.min(bounds.min.y, point.y);
  bounds.min.z = Math.min(bounds.min.z, point.z);
  bounds.max.x = Math.max(bounds.max.x, point.x);
  bounds.max.y = Math.max(bounds.max.y, point.y);
  bounds.max.z = Math.max(bounds.max.z, point.z);
}

function finalize(bounds: Bounds): Bounds | null {
  if (!Number.isFinite(bounds.min.x)) return null;
  bounds.size = {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
    z: bounds.max.z - bounds.min.z,
  };
  return bounds;
}

function signedArea2D(points: [number, number][]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index];
    const [bx, by] = points[(index + 1) % points.length];
    area += ax * by - bx * ay;
  }
  return area / 2;
}

/** Resamples a closed polygon to a fixed vertex count and makes it counter-clockwise. */
function resampleLoop(points: [number, number][], count: number): [number, number][] {
  if (points.length === 0 || count < 3) return [];
  const loop = signedArea2D(points) < 0 ? [...points].reverse() : points;

  const cumulative: number[] = [0];
  for (let index = 0; index < loop.length; index += 1) {
    const [ax, ay] = loop[index];
    const [bx, by] = loop[(index + 1) % loop.length];
    cumulative.push(cumulative[index] + Math.hypot(bx - ax, by - ay));
  }

  const total = cumulative[cumulative.length - 1];
  if (!(total > 1e-9)) return [];

  const result: [number, number][] = [];
  let segment = 0;
  for (let index = 0; index < count; index += 1) {
    const distance = (total * index) / count;
    while (segment < loop.length - 1 && cumulative[segment + 1] < distance) segment += 1;
    const [ax, ay] = loop[segment];
    const [bx, by] = loop[(segment + 1) % loop.length];
    const span = cumulative[segment + 1] - cumulative[segment];
    const t = span > 1e-12 ? (distance - cumulative[segment]) / span : 0;
    result.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
  }
  return result;
}

function loftPoint(axis: Axis, at: number, a: number, b: number): Vec3n {
  if (axis === "x") return { x: at, y: a, z: b };
  if (axis === "y") return { x: a, y: at, z: b };
  return { x: a, y: b, z: at };
}

function solidBounds(solid: ResolvedSolid): Bounds {
  const bounds = emptyBounds();

  if (solid.kind === "box") {
    const { origin, size } = solid;
    const halfX = Math.abs(size.x) / 2;
    const halfY = Math.abs(size.y) / 2;
    const angle = (solid.rotationZ * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const z0 = origin.z;
    const z1 = origin.z + size.z;
    const zMin = Math.min(z0, z1);
    const zMax = Math.max(z0, z1);

    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const dx = sx * halfX;
        const dy = sy * halfY;
        grow(bounds, {
          x: origin.x + dx * cos - dy * sin,
          y: origin.y + dx * sin + dy * cos,
          z: zMin,
        });
        grow(bounds, {
          x: origin.x + dx * cos - dy * sin,
          y: origin.y + dx * sin + dy * cos,
          z: zMax,
        });
      }
    }
    return bounds;
  }

  if (solid.kind === "cylinder") {
    const { base, radius, height, axis } = solid;
    const end = { ...base };
    end[axis] += height;
    const lo = {
      x: Math.min(base.x, end.x) - (axis === "x" ? 0 : radius),
      y: Math.min(base.y, end.y) - (axis === "y" ? 0 : radius),
      z: Math.min(base.z, end.z) - (axis === "z" ? 0 : radius),
    };
    const hi = {
      x: Math.max(base.x, end.x) + (axis === "x" ? 0 : radius),
      y: Math.max(base.y, end.y) + (axis === "y" ? 0 : radius),
      z: Math.max(base.z, end.z) + (axis === "z" ? 0 : radius),
    };
    grow(bounds, lo);
    grow(bounds, hi);
    return bounds;
  }

  if (solid.kind === "frustum") {
    const { base, height, axis } = solid;
    const radius = Math.max(solid.radiusBottom, solid.radiusTop);
    const end = { ...base };
    end[axis] += height;
    grow(bounds, {
      x: Math.min(base.x, end.x) - (axis === "x" ? 0 : radius),
      y: Math.min(base.y, end.y) - (axis === "y" ? 0 : radius),
      z: Math.min(base.z, end.z) - (axis === "z" ? 0 : radius),
    });
    grow(bounds, {
      x: Math.max(base.x, end.x) + (axis === "x" ? 0 : radius),
      y: Math.max(base.y, end.y) + (axis === "y" ? 0 : radius),
      z: Math.max(base.z, end.z) + (axis === "z" ? 0 : radius),
    });
    return bounds;
  }

  if (solid.kind === "bend") {
    // Exact envelope of the swept tube. Sampling the centreline and growing by the
    // cross-section extent in each axis avoids the old full-ring box, which made a
    // 90-degree elbow reserve a whole circle and pushed reference planes far away.
    const { center, radius, tubeRadius, plane } = solid;
    const start = (solid.startAngle * Math.PI) / 180;
    const sweep = (solid.angle * Math.PI) / 180;
    const u = plane === "yz" ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const v = plane === "xy" ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    const steps = Math.max(
      8,
      Math.min(256, Math.ceil((Math.abs(sweep) * (radius + tubeRadius)) / 10)),
    );

    for (let index = 0; index <= steps; index += 1) {
      const angle = start + (sweep * index) / steps;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const radial = {
        x: u.x * cos + v.x * sin,
        y: u.y * cos + v.y * sin,
        z: u.z * cos + v.z * sin,
      };
      const point = {
        x: center.x + radial.x * radius,
        y: center.y + radial.y * radius,
        z: center.z + radial.z * radius,
      };
      grow(bounds, point);

      // The tube disc is perpendicular to the tangent, so its extent along a world
      // axis is tubeRadius * sqrt(1 - tangent_axis^2).
      const tangent = {
        x: -u.x * sin + v.x * cos,
        y: -u.y * sin + v.y * cos,
        z: -u.z * sin + v.z * cos,
      };
      const extent = (component: number) =>
        tubeRadius * Math.sqrt(Math.max(0, 1 - component * component));

      const ex = extent(tangent.x);
      const ey = extent(tangent.y);
      const ez = extent(tangent.z);
      grow(bounds, { x: point.x - ex, y: point.y - ey, z: point.z - ez });
      grow(bounds, { x: point.x + ex, y: point.y + ey, z: point.z + ez });
    }

    return bounds;
  }

  if (solid.kind === "loft") {
    for (const section of solid.sections) {
      for (const [a, b] of section.points) {
        grow(bounds, loftPoint(solid.axis, section.at, a, b));
      }
    }
    return bounds;
  }

  if (solid.kind === "revolve") {
    let maxR = 0;
    let minH = Infinity;
    let maxH = -Infinity;
    for (const [r, h] of solid.points) {
      maxR = Math.max(maxR, Math.abs(r));
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
    }
    if (!Number.isFinite(minH)) {
      minH = 0;
      maxH = 0;
    }
    const o = solid.origin;
    if (solid.axis === "x") {
      grow(bounds, { x: o.x + minH, y: o.y - maxR, z: o.z - maxR });
      grow(bounds, { x: o.x + maxH, y: o.y + maxR, z: o.z + maxR });
    } else if (solid.axis === "y") {
      grow(bounds, { x: o.x - maxR, y: o.y + minH, z: o.z - maxR });
      grow(bounds, { x: o.x + maxR, y: o.y + maxH, z: o.z + maxR });
    } else {
      grow(bounds, { x: o.x - maxR, y: o.y - maxR, z: o.z + minH });
      grow(bounds, { x: o.x + maxR, y: o.y + maxR, z: o.z + maxH });
    }
    return bounds;
  }

  if (solid.kind === "tube") {
    const { start, end, radius, direction } = solid;
    const extent = (component: number) =>
      radius * Math.sqrt(Math.max(0, 1 - component * component));
    const ex = extent(direction.x);
    const ey = extent(direction.y);
    const ez = extent(direction.z);
    grow(bounds, {
      x: Math.min(start.x, end.x) - ex,
      y: Math.min(start.y, end.y) - ey,
      z: Math.min(start.z, end.z) - ez,
    });
    grow(bounds, {
      x: Math.max(start.x, end.x) + ex,
      y: Math.max(start.y, end.y) + ey,
      z: Math.max(start.z, end.z) + ez,
    });
    return bounds;
  }

  const aValues = solid.points.map((point) => point[0]);
  const bValues = solid.points.map((point) => point[1]);
  const aMin = Math.min(...aValues);
  const aMax = Math.max(...aValues);
  const bMin = Math.min(...bValues);
  const bMax = Math.max(...bValues);
  const dMin = Math.min(solid.from, solid.to);
  const dMax = Math.max(solid.from, solid.to);

  if (solid.plane === "xy") {
    grow(bounds, { x: aMin, y: bMin, z: dMin });
    grow(bounds, { x: aMax, y: bMax, z: dMax });
  } else if (solid.plane === "xz") {
    grow(bounds, { x: aMin, y: dMin, z: bMin });
    grow(bounds, { x: aMax, y: dMax, z: bMax });
  } else {
    grow(bounds, { x: dMin, y: aMin, z: bMin });
    grow(bounds, { x: dMax, y: aMax, z: bMax });
  }
  return bounds;
}

export function transformBounds(bounds: Bounds, offset: Vec3n): Bounds {
  const out = emptyBounds();
  grow(out, {
    x: bounds.min.x + offset.x,
    y: bounds.min.y + offset.y,
    z: bounds.min.z + offset.z,
  });
  grow(out, {
    x: bounds.max.x + offset.x,
    y: bounds.max.y + offset.y,
    z: bounds.max.z + offset.z,
  });
  return finalize(out)!;
}

export function resolveModel(
  spec: FamilySpec,
  resolution: ParameterResolution,
): ResolvedModel {
  const issues: Issue[] = [...resolution.issues];
  const parts: ResolvedPart[] = [];

  const num = (value: Numeric | undefined, path: string, fallback?: number): number => {
    if (value === undefined || value === null) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${path} is required`);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`${path} is not a finite number`);
      return value;
    }
    const text = value.trim();
    if (!text) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${path} is empty`);
    }
    const direct = Number(text);
    if (Number.isFinite(direct)) return direct;
    try {
      return evaluateNode(compileExpression(text), resolution.lookup);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${path}: ${message}`, { cause: error });
    }
  };

  const numVec = (value: { x: Numeric; y: Numeric; z: Numeric } | undefined, path: string): Vec3n => {
    if (!value || typeof value !== "object") throw new Error(`${path} is required`);
    return {
      x: num(value.x, `${path}.x`),
      y: num(value.y, `${path}.y`),
      z: num(value.z, `${path}.z`),
    };
  };

  const resolveSolid = (raw: unknown, path: string): ResolvedSolid => {
    if (!raw || typeof raw !== "object") throw new Error(`${path} is required`);
    const solid = raw as Record<string, unknown>;
    const kind = solid.kind;

    if (kind === "box") {
      const size = numVec(solid.size as { x: Numeric; y: Numeric; z: Numeric }, `${path}.size`);
      const radiusLimit = Math.min(Math.abs(size.x), Math.abs(size.y)) / 2;
      const cornerRadius = Math.min(
        Math.max(num(solid.cornerRadius as Numeric | undefined, `${path}.cornerRadius`, 0), 0),
        radiusLimit,
      );
      return {
        kind: "box",
        origin: numVec(solid.origin as { x: Numeric; y: Numeric; z: Numeric }, `${path}.origin`),
        size,
        rotationZ: num(solid.rotationZ as Numeric | undefined, `${path}.rotationZ`, 0),
        cornerRadius,
      };
    }

    if (kind === "cylinder") {
      const axis = (solid.axis as Axis | undefined) ?? "z";
      if (!["x", "y", "z"].includes(axis)) throw new Error(`${path}.axis must be x, y or z`);
      const radius = num(solid.radius as Numeric, `${path}.radius`);
      if (radius <= 0) throw new Error(`${path}.radius must be greater than zero`);
      const innerRadius = num(solid.innerRadius as Numeric | undefined, `${path}.innerRadius`, 0);
      if (innerRadius < 0 || innerRadius >= radius) {
        throw new Error(`${path}.innerRadius must be between 0 and radius`);
      }
      const segments = Math.min(96, Math.max(12, Number(solid.segments) || DEFAULT_SEGMENTS));
      return {
        kind: "cylinder",
        base: numVec(solid.base as { x: Numeric; y: Numeric; z: Numeric }, `${path}.base`),
        radius,
        innerRadius,
        height: num(solid.height as Numeric, `${path}.height`),
        axis,
        segments,
      };
    }

    if (kind === "frustum") {
      const axis = (solid.axis as Axis | undefined) ?? "z";
      if (!["x", "y", "z"].includes(axis)) throw new Error(`${path}.axis must be x, y or z`);
      const radiusBottom = num(solid.radiusBottom as Numeric, `${path}.radiusBottom`);
      const radiusTop = num(solid.radiusTop as Numeric, `${path}.radiusTop`);
      if (radiusBottom < 0 || radiusTop < 0) {
        throw new Error(`${path} radii must be zero or greater`);
      }
      if (radiusBottom <= 0 && radiusTop <= 0) {
        throw new Error(`${path} needs at least one radius greater than zero`);
      }
      const height = num(solid.height as Numeric, `${path}.height`);
      if (Math.abs(height) < 1e-9) throw new Error(`${path}.height must not be zero`);
      const segments = Math.min(96, Math.max(12, Number(solid.segments) || DEFAULT_SEGMENTS));
      return {
        kind: "frustum",
        base: numVec(solid.base as { x: Numeric; y: Numeric; z: Numeric }, `${path}.base`),
        radiusBottom,
        radiusTop,
        height,
        axis,
        segments,
      };
    }

    if (kind === "bend") {
      const plane = (solid.plane as "xy" | "xz" | "yz" | undefined) ?? "xy";
      if (!["xy", "xz", "yz"].includes(plane)) {
        throw new Error(`${path}.plane must be xy, xz or yz`);
      }
      const radius = num(solid.radius as Numeric, `${path}.radius`);
      const tubeRadius = num(solid.tubeRadius as Numeric, `${path}.tubeRadius`);
      if (radius <= 0) throw new Error(`${path}.radius must be greater than zero`);
      if (tubeRadius <= 0) throw new Error(`${path}.tubeRadius must be greater than zero`);
      if (tubeRadius >= radius) {
        throw new Error(`${path}.tubeRadius must be smaller than radius`);
      }
      const angle = num(solid.angle as Numeric | undefined, `${path}.angle`, 90);
      if (!(angle > 0) || angle > 360) {
        throw new Error(`${path}.angle must be between 0 and 360 degrees`);
      }
      return {
        kind: "bend",
        center: numVec(solid.center as { x: Numeric; y: Numeric; z: Numeric }, `${path}.center`),
        radius,
        tubeRadius,
        angle,
        startAngle: num(solid.startAngle as Numeric | undefined, `${path}.startAngle`, 0),
        plane,
        segments: Math.min(96, Math.max(8, Number(solid.segments) || 48)),
      };
    }

    if (kind === "prism") {
      const plane = solid.plane;
      if (plane !== "xy" && plane !== "xz" && plane !== "yz") {
        throw new Error(`${path}.plane must be xy, xz or yz`);
      }
      const rawPoints = solid.points;
      if (!Array.isArray(rawPoints) || rawPoints.length < 3) {
        throw new Error(`${path}.points needs at least 3 [a, b] pairs`);
      }
      const points = rawPoints.map((point, index) => {
        if (!Array.isArray(point) || point.length < 2) {
          throw new Error(`${path}.points[${index}] must be an [a, b] pair`);
        }
        return [num(point[0], `${path}.points[${index}][0]`), num(point[1], `${path}.points[${index}][1]`)] as [
          number,
          number,
        ];
      });

      const rawHoles = Array.isArray(solid.holes) ? solid.holes : [];
      const holes = rawHoles.map((hole, holeIndex) => {
        if (!Array.isArray(hole) || hole.length < 3) {
          throw new Error(`${path}.holes[${holeIndex}] needs at least 3 [a, b] pairs`);
        }
        return hole.map((point, pointIndex) => {
          if (!Array.isArray(point) || point.length < 2) {
            throw new Error(`${path}.holes[${holeIndex}][${pointIndex}] must be an [a, b] pair`);
          }
          return [
            num(point[0], `${path}.holes[${holeIndex}][${pointIndex}][0]`),
            num(point[1], `${path}.holes[${holeIndex}][${pointIndex}][1]`),
          ] as [number, number];
        });
      });

      return {
        kind: "prism",
        plane,
        points,
        holes,
        from: num(solid.from as Numeric, `${path}.from`),
        to: num(solid.to as Numeric, `${path}.to`),
      };
    }

    if (kind === "loft") {
      const axis = (solid.axis as Axis | undefined) ?? "z";
      if (!["x", "y", "z"].includes(axis)) throw new Error(`${path}.axis must be x, y or z`);
      const segments = Math.min(96, Math.max(8, Number(solid.segments) || 32));
      const rawSections = solid.sections;
      if (!Array.isArray(rawSections) || rawSections.length < 2) {
        throw new Error(`${path}.sections needs at least two profiles`);
      }

      const profilePoints = (profile: unknown, profilePath: string): [number, number][] => {
        if (!profile || typeof profile !== "object") {
          throw new Error(`${profilePath} is required`);
        }
        const shape = profile as Record<string, unknown>;
        const profileKind = shape.kind;

        if (profileKind === "circle") {
          const radius = num(shape.radius as Numeric, `${profilePath}.radius`);
          if (radius <= 0) throw new Error(`${profilePath}.radius must be greater than zero`);
          return Array.from({ length: segments }, (_, index) => {
            const angle = (2 * Math.PI * index) / segments;
            return [Math.cos(angle) * radius, Math.sin(angle) * radius] as [number, number];
          });
        }

        if (profileKind === "rect") {
          const width = num(shape.width as Numeric, `${profilePath}.width`);
          const height = num(shape.height as Numeric, `${profilePath}.height`);
          if (width <= 0 || height <= 0) {
            throw new Error(`${profilePath}.width and height must be greater than zero`);
          }
          const halfWidth = width / 2;
          const halfHeight = height / 2;
          const corner = Math.min(
            Math.max(num(shape.cornerRadius as Numeric | undefined, `${profilePath}.cornerRadius`, 0), 0),
            Math.min(halfWidth, halfHeight),
          );
          if (corner <= 1e-9) {
            return [
              [-halfWidth, -halfHeight],
              [halfWidth, -halfHeight],
              [halfWidth, halfHeight],
              [-halfWidth, halfHeight],
            ];
          }

          const points: [number, number][] = [];
          const corners: [number, number, number][] = [
            [halfWidth - corner, halfHeight - corner, 0],
            [-(halfWidth - corner), halfHeight - corner, Math.PI / 2],
            [-(halfWidth - corner), -(halfHeight - corner), Math.PI],
            [halfWidth - corner, -(halfHeight - corner), (3 * Math.PI) / 2],
          ];
          for (const [cx, cy, start] of corners) {
            for (let step = 0; step <= 8; step += 1) {
              const angle = start + (step / 8) * (Math.PI / 2);
              points.push([cx + Math.cos(angle) * corner, cy + Math.sin(angle) * corner]);
            }
          }
          return points;
        }

        if (profileKind === "polygon") {
          const rawPoints = shape.points;
          if (!Array.isArray(rawPoints) || rawPoints.length < 3) {
            throw new Error(`${profilePath}.points needs at least 3 [a, b] pairs`);
          }
          return rawPoints.map((point, index) => {
            if (!Array.isArray(point) || point.length < 2) {
              throw new Error(`${profilePath}.points[${index}] must be an [a, b] pair`);
            }
            return [
              num(point[0], `${profilePath}.points[${index}][0]`),
              num(point[1], `${profilePath}.points[${index}][1]`),
            ] as [number, number];
          });
        }

        throw new Error(`${profilePath}.kind must be circle, rect or polygon`);
      };

      const sections: ResolvedLoftSection[] = rawSections.map((section, index) => {
        if (!section || typeof section !== "object") {
          throw new Error(`${path}.sections[${index}] must be an object`);
        }
        const at = num(section.at as Numeric, `${path}.sections[${index}].at`);
        const points = profilePoints(section.profile, `${path}.sections[${index}].profile`);
        return { at, points };
      });

      for (let index = 1; index < sections.length; index += 1) {
        if (!(sections[index].at > sections[index - 1].at)) {
          throw new Error(`${path}.sections must be ordered by increasing at`);
        }
      }

      const count = Math.max(segments, ...sections.map((section) => section.points.length));
      const normalized = sections.map((section) => {
        const points = resampleLoop(section.points, count);
        if (points.length < 3) throw new Error(`${path} has a profile with no usable perimeter`);
        return { at: section.at, points };
      });

      return { kind: "loft", axis, sections: normalized };
    }

    if (kind === "revolve") {
      const axis = (solid.axis as Axis | undefined) ?? "z";
      if (!["x", "y", "z"].includes(axis)) throw new Error(`${path}.axis must be x, y or z`);
      const origin = solid.origin
        ? numVec(solid.origin as { x: Numeric; y: Numeric; z: Numeric }, `${path}.origin`)
        : { x: 0, y: 0, z: 0 };
      const rawPoints = solid.points;
      if (!Array.isArray(rawPoints) || rawPoints.length < 3) {
        throw new Error(`${path}.points needs at least 3 [radial, height] pairs`);
      }
      const points = rawPoints.map((point, index) => {
        if (!Array.isArray(point) || point.length < 2) {
          throw new Error(`${path}.points[${index}] must be an [r, h] pair`);
        }
        return [
          num(point[0], `${path}.points[${index}][0]`),
          num(point[1], `${path}.points[${index}][1]`),
        ] as [number, number];
      });
      const angle = num(solid.angle as Numeric | undefined, `${path}.angle`, 360);
      const startAngle = num(solid.startAngle as Numeric | undefined, `${path}.startAngle`, 0);
      const segments = Math.min(96, Math.max(12, Number(solid.segments) || 32));
      return { kind: "revolve", axis, origin, points, angle, startAngle, segments };
    }

    if (kind === "tube") {
      const start = numVec(
        solid.start as { x: Numeric; y: Numeric; z: Numeric },
        `${path}.start`,
      );
      const end = numVec(solid.end as { x: Numeric; y: Numeric; z: Numeric }, `${path}.end`);
      const radius = num(solid.radius as Numeric, `${path}.radius`);
      const innerRadius = num(
        solid.innerRadius as Numeric | undefined,
        `${path}.innerRadius`,
        0,
      );
      if (radius <= 0) throw new Error(`${path}.radius must be greater than zero`);
      if (innerRadius < 0 || innerRadius >= radius) {
        throw new Error(`${path}.innerRadius must be between 0 and radius`);
      }
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const dz = end.z - start.z;
      const length = Math.hypot(dx, dy, dz);
      if (!(length > 1e-9)) throw new Error(`${path}.start and ${path}.end must differ`);
      const segments = Math.min(96, Math.max(12, Number(solid.segments) || DEFAULT_SEGMENTS));
      return {
        kind: "tube",
        start,
        end,
        radius,
        innerRadius,
        direction: { x: dx / length, y: dy / length, z: dz / length },
        length,
        segments,
      };
    }

    throw new Error(
      `${path}.kind must be box, cylinder, frustum, bend, prism, loft, revolve or tube`,
    );
  };

  spec.parts.forEach((part, index) => {
    const path = `parts[${index}]`;
    try {
      if (!part || typeof part !== "object") throw new Error(`${path} must be an object`);
      const id = part.id || `part-${index + 1}`;
      const solid = resolveSolid(part.solid, `${path}.solid`);
      const cuts = Array.isArray(part.cuts)
        ? part.cuts.map((cut, cutIndex) => resolveSolid(cut, `${path}.cuts[${cutIndex}]`))
        : [];

      let array = { count: 1, axis: "x" as Axis, spacing: 0 };
      if (part.array) {
        const rawCount = num(part.array.count, `${path}.array.count`);
        const count = Math.round(rawCount);
        if (!Number.isFinite(count) || count < 1 || count > 500) {
          throw new Error(`${path}.array.count must resolve to a whole number between 1 and 500`);
        }
        const axis = part.array.axis ?? "x";
        if (!["x", "y", "z"].includes(axis)) throw new Error(`${path}.array.axis must be x, y or z`);
        array = {
          count,
          axis,
          spacing: num(part.array.spacing, `${path}.array.spacing`, 0),
        };
      }

      parts.push({
        id,
        name: part.name || id,
        material: part.material,
        color: part.color,
        solid,
        cuts,
        array,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push({ severity: "error", path, message });
    }
  });

  const connectors: ResolvedConnector[] = [];
  if (Array.isArray(spec.connectors)) {
    spec.connectors.forEach((conn, index) => {
      const path = `connectors[${index}]`;
      try {
        const origin: Vec3n = {
          x: num(conn.origin?.x, `${path}.origin.x`, 0),
          y: num(conn.origin?.y, `${path}.origin.y`, 0),
          z: num(conn.origin?.z, `${path}.origin.z`, 0),
        };
        const directionVector: Vec3n = {
          x: num(conn.directionVector?.x, `${path}.directionVector.x`, 0),
          y: num(conn.directionVector?.y, `${path}.directionVector.y`, -1),
          z: num(conn.directionVector?.z, `${path}.directionVector.z`, 0),
        };
        connectors.push({
          id: conn.id,
          name: conn.name,
          systemType: conn.systemType,
          shape: conn.shape,
          direction: conn.direction,
          origin,
          directionVector,
          width: conn.width !== undefined ? num(conn.width, `${path}.width`, 0) : undefined,
          height: conn.height !== undefined ? num(conn.height, `${path}.height`, 0) : undefined,
          diameter: conn.diameter !== undefined ? num(conn.diameter, `${path}.diameter`, 0) : undefined,
          flow: conn.flow !== undefined ? num(conn.flow, `${path}.flow`, 0) : undefined,
          flowUnit: conn.flowUnit,
          pressureDrop: conn.pressureDrop !== undefined ? num(conn.pressureDrop, `${path}.pressureDrop`, 0) : undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        issues.push({ severity: "error", path, message });
      }
    });
  }

  const bounds = emptyBounds();
  let instances = 0;
  for (const part of parts) {
    const merged = partBounds(part);
    grow(bounds, merged.min);
    grow(bounds, merged.max);
    instances += part.array.count;
  }

  return {
    parts,
    connectors,
    instances,
    issues,
    bounds: finalize(bounds),
  };
}

export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds {
  const out = emptyBounds();
  if (a) {
    grow(out, a.min);
    grow(out, a.max);
  }
  if (b) {
    grow(out, b.min);
    grow(out, b.max);
  }
  return finalize(out) ?? { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 } };
}

/** Bounding box of one part, including every copy produced by its array. */
export function partBounds(part: ResolvedPart): Bounds {
  const base = solidBounds(part.solid);
  let merged = base;
  for (let index = 0; index < part.array.count; index += 1) {
    const offset = { x: 0, y: 0, z: 0 };
    offset[part.array.axis] = part.array.spacing * index;
    merged = unionBounds(merged, transformBounds(base, offset));
  }
  return merged;
}
