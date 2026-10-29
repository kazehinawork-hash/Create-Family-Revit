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

export interface ResolvedPrism {
  kind: "prism";
  plane: "xy" | "xz" | "yz";
  points: [number, number][];
  from: number;
  to: number;
}

export type ResolvedSolid = ResolvedBox | ResolvedCylinder | ResolvedPrism;

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
      throw new Error(`${path}: ${message}`);
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
      return {
        kind: "prism",
        plane,
        points,
        from: num(solid.from as Numeric, `${path}.from`),
        to: num(solid.to as Numeric, `${path}.to`),
      };
    }

    throw new Error(`${path}.kind must be box, cylinder or prism`);
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
