import { partBounds, type Bounds, type ResolvedModel, type ResolvedPart } from "./geometry.js";
import type { Issue } from "./types.js";

/**
 * Post-resolution topology checks. The static validator can only inspect literal
 * polygon points; most real specs use expressions, so a self-intersection or a
 * hole outside its outer loop would otherwise reach Revit and fail there.
 *
 * These are warnings, not errors: the studio can still preview the mesh, but the
 * .rfa build is likely to reject or mis-triangulate it.
 */

type Point = [number, number];

function signedArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index];
    const [bx, by] = points[(index + 1) % points.length];
    area += ax * by - bx * ay;
  }
  return area / 2;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return (
    ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
    ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
  );
}

function selfIntersects(points: Point[]): boolean {
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j += 1) {
      const adjacent = j === i || j === (i + 1) % points.length || (j + 1) % points.length === i;
      if (adjacent) continue;
      const c = points[j];
      const d = points[(j + 1) % points.length];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  const [x, y] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function checkLoop(points: Point[], path: string, label: string, issues: Issue[]): void {
  if (points.length < 3) return;
  if (Math.abs(signedArea(points)) < 1e-6) {
    issues.push({
      severity: "warning",
      path,
      message: `${label} has zero area after resolving its expressions.`,
    });
    return;
  }
  if (selfIntersects(points)) {
    issues.push({
      severity: "warning",
      path,
      message: `${label} intersects itself after resolving its expressions; Revit may reject the profile.`,
    });
  }
}

function distanceToSegment(a: number, b: number, start: Point, end: Point): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) {
    return Math.hypot(a - start[0], b - start[1]);
  }
  const t = Math.min(
    1,
    Math.max(0, ((a - start[0]) * dx + (b - start[1]) * dy) / lengthSquared),
  );
  return Math.hypot(a - (start[0] + dx * t), b - (start[1] + dy * t));
}

function checkPrismCuts(
  part: ResolvedPart,
  solid: Extract<ResolvedPart["solid"], { kind: "prism" }>,
  issues: Issue[],
): void {
  if (part.cuts.length === 0) return;

  const plane = solid.plane;
  const normalAxis = plane === "xy" ? "z" : plane === "xz" ? "y" : "x";
  const low = Math.min(solid.from, solid.to);
  const high = Math.max(solid.from, solid.to);

  const warn = (index: number, reason: string) => {
    issues.push({
      severity: "warning",
      path: `logic.geometry.${part.id}.cuts[${index}]`,
      message:
        `Cut ${index + 1} on "${part.name}" ${reason}; Revit boolean on a thin prism may fail, ` +
        "so the builder keeps the part native and skips this cut. Bake the notch into the prism " +
        "points or move the cut inward by at least 0.8 mm.",
    });
  };

  part.cuts.forEach((cut, index) => {
    if (cut.kind === "cylinder") {
      if (cut.axis !== normalAxis) {
        warn(index, "is not perpendicular to the extrusion");
        return;
      }
      const normal = plane === "xy" ? cut.base.z : plane === "xz" ? cut.base.y : cut.base.x;
      const cutLow = Math.min(normal, normal + cut.height);
      const cutHigh = Math.max(normal, normal + cut.height);
      if (cutLow > low + 0.5 || cutHigh < high - 0.5) {
        warn(index, "does not pass through the prism thickness");
        return;
      }
      const a = plane === "xy" || plane === "xz" ? cut.base.x : cut.base.y;
      const b = plane === "xy" ? cut.base.y : cut.base.z;
      if (!pointInPolygon([a, b], solid.points)) {
        warn(index, "is outside the outer profile");
        return;
      }
      for (let edge = 0; edge < solid.points.length; edge += 1) {
        const start = solid.points[edge];
        const end = solid.points[(edge + 1) % solid.points.length];
        if (distanceToSegment(a, b, start, end) < cut.radius + 0.8) {
          warn(index, "is closer than 0.8 mm to the outer profile");
          return;
        }
      }
      return;
    }

    if (cut.kind !== "box") return;
    if (Math.abs(cut.rotationZ) > 1e-6) {
      warn(index, "is rotated and cannot be baked as an axis-aligned notch");
      return;
    }

    let normalLow: number;
    let normalHigh: number;
    let aMin: number;
    let aMax: number;
    let bMin: number;
    let bMax: number;
    if (plane === "xy") {
      normalLow = cut.origin.z;
      normalHigh = cut.origin.z + cut.size.z;
      aMin = cut.origin.x - Math.abs(cut.size.x) / 2;
      aMax = cut.origin.x + Math.abs(cut.size.x) / 2;
      bMin = cut.origin.y - Math.abs(cut.size.y) / 2;
      bMax = cut.origin.y + Math.abs(cut.size.y) / 2;
    } else if (plane === "xz") {
      normalLow = cut.origin.y - Math.abs(cut.size.y) / 2;
      normalHigh = cut.origin.y + Math.abs(cut.size.y) / 2;
      aMin = cut.origin.x - Math.abs(cut.size.x) / 2;
      aMax = cut.origin.x + Math.abs(cut.size.x) / 2;
      bMin = cut.origin.z;
      bMax = cut.origin.z + cut.size.z;
    } else {
      normalLow = cut.origin.x - Math.abs(cut.size.x) / 2;
      normalHigh = cut.origin.x + Math.abs(cut.size.x) / 2;
      aMin = cut.origin.y - Math.abs(cut.size.y) / 2;
      aMax = cut.origin.y + Math.abs(cut.size.y) / 2;
      bMin = cut.origin.z;
      bMax = cut.origin.z + cut.size.z;
    }

    if (Math.min(normalLow, normalHigh) > low + 0.5 ||
        Math.max(normalLow, normalHigh) < high - 0.5) {
      warn(index, "does not pass through the prism thickness");
      return;
    }
    if (bMax < bMin) {
      [bMin, bMax] = [bMax, bMin];
    }

    const corners: Point[] = [
      [aMin, bMin],
      [aMax, bMin],
      [aMax, bMax],
      [aMin, bMax],
    ];
    if (!pointInPolygon(corners[0], solid.points)) {
      warn(index, "crosses the outer profile");
      return;
    }
    for (let edge = 0; edge < solid.points.length; edge += 1) {
      const start = solid.points[edge];
      const end = solid.points[(edge + 1) % solid.points.length];
      for (let corner = 0; corner < 4; corner += 1) {
        if (distanceToSegment(corners[corner][0], corners[corner][1], start, end) < 0.8) {
          warn(index, "is closer than 0.8 mm to the outer profile");
          return;
        }
        if (segmentsIntersect(corners[corner], corners[(corner + 1) % 4], start, end)) {
          warn(index, "crosses the outer profile");
          return;
        }
      }
    }
  });
}

function checkPartTopology(part: ResolvedPart, issues: Issue[]): void {
  const path = `logic.geometry.${part.id}`;
  const { solid } = part;

  if (solid.kind === "prism") {
    checkLoop(solid.points, `${path}.solid.points`, `"${part.name}" profile`, issues);
    for (let index = 0; index < solid.holes.length; index += 1) {
      const hole = solid.holes[index];
      checkLoop(hole, `${path}.solid.holes[${index}]`, `"${part.name}" hole ${index + 1}`, issues);
      if (hole.length > 0 && !pointInPolygon(hole[0], solid.points)) {
        issues.push({
          severity: "warning",
          path: `${path}.solid.holes[${index}]`,
          message: `Hole ${index + 1} of "${part.name}" is outside the outer profile.`,
        });
      }
    }
    checkPrismCuts(part, solid, issues);
  } else if (solid.kind === "loft") {
    for (let index = 0; index < solid.sections.length; index += 1) {
      checkLoop(
        solid.sections[index].points,
        `${path}.solid.sections[${index}]`,
        `"${part.name}" section ${index + 1}`,
        issues,
      );
    }
  }
}

function geometryKey(part: ResolvedPart): string {
  return JSON.stringify({
    solid: part.solid,
    cuts: part.cuts,
    array: part.array,
    material: part.material,
    color: part.color,
  });
}

function contains(outer: Bounds, inner: Bounds, tolerance: number): boolean {
  return (
    inner.min.x >= outer.min.x - tolerance &&
    inner.max.x <= outer.max.x + tolerance &&
    inner.min.y >= outer.min.y - tolerance &&
    inner.max.y <= outer.max.y + tolerance &&
    inner.min.z >= outer.min.z - tolerance &&
    inner.max.z <= outer.max.z + tolerance
  );
}

function boundsVolume(bounds: Bounds): number {
  return Math.abs(bounds.size.x) * Math.abs(bounds.size.y) * Math.abs(bounds.size.z);
}

function overlap1d(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin);
}

/**
 * A large part whose bounds sit almost entirely inside another large part is either
 * intentional (a strainer screen inside a branch) or an accidental buried duplicate.
 * Keep it informational and require most of the volume to be covered, so hardware
 * and small internals do not spam the panel.
 */
function checkBuriedParts(model: ResolvedModel): Issue[] {
  const issues: Issue[] = [];
  const placed = model.parts.map((part) => ({ part, bounds: partBounds(part) }));

  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i];
      const b = placed[j];
      const volumeA = boundsVolume(a.bounds);
      const volumeB = boundsVolume(b.bounds);
      if (volumeA <= 0 || volumeB <= 0) continue;

      if (contains(b.bounds, a.bounds, 1) && volumeA > 0.8 * volumeB) {
        issues.push({
          severity: "info",
          path: `info.geometry.${a.part.id}`,
          message: `"${a.part.name}" nằm gần như hoàn toàn trong "${b.part.name}" (≈${Math.round((volumeA / volumeB) * 100)}% thể tích); kiểm tra part bị chôn hoặc trùng.`,
        });
      } else if (contains(a.bounds, b.bounds, 1) && volumeB > 0.8 * volumeA) {
        issues.push({
          severity: "info",
          path: `info.geometry.${b.part.id}`,
          message: `"${b.part.name}" nằm gần như hoàn toàn trong "${a.part.name}" (≈${Math.round((volumeB / volumeA) * 100)}% thể tích); kiểm tra part bị chôn hoặc trùng.`,
        });
      }
    }
  }

  return issues;
}

/**
 * Two parts of the same material with a large coincident face are a classic source
 * of z-fighting in Revit sections. Intentional cast joints trigger this too, so it
 * is informational and hidden behind the Parts "Info" toggle by default.
 */
function checkCoincidentFaces(model: ResolvedModel): Issue[] {
  const issues: Issue[] = [];
  const placed = model.parts.map((part) => ({ part, bounds: partBounds(part) }));
  let reported = 0;

  for (let i = 0; i < placed.length && reported < 12; i += 1) {
    for (let j = i + 1; j < placed.length && reported < 12; j += 1) {
      const a = placed[i];
      const b = placed[j];
      const materialA = a.part.material ?? a.part.color ?? "";
      const materialB = b.part.material ?? b.part.color ?? "";
      if (!materialA || !materialB) continue;
      if (materialA.toLowerCase() !== materialB.toLowerCase()) continue;

      const minA = Math.min(
        Math.abs(a.bounds.size.x),
        Math.abs(a.bounds.size.y),
        Math.abs(a.bounds.size.z),
      );
      const minB = Math.min(
        Math.abs(b.bounds.size.x),
        Math.abs(b.bounds.size.y),
        Math.abs(b.bounds.size.z),
      );
      if (minA < 3 || minB < 3) continue;

      const axes = ["x", "y", "z"] as const;
      let matched = false;
      for (const axis of axes) {
        const other = axes.filter((entry) => entry !== axis);
        const touching =
          Math.abs(a.bounds.max[axis] - b.bounds.min[axis]) <= 0.1 ||
          Math.abs(a.bounds.min[axis] - b.bounds.max[axis]) <= 0.1;
        if (!touching) continue;

        const [first, second] = other;
        const overlap =
          overlap1d(
            a.bounds.min[first],
            a.bounds.max[first],
            b.bounds.min[first],
            b.bounds.max[first],
          ) *
          overlap1d(
            a.bounds.min[second],
            a.bounds.max[second],
            b.bounds.min[second],
            b.bounds.max[second],
          );
        if (overlap <= 25) continue;

        const faceA = Math.abs(a.bounds.size[first] * a.bounds.size[second]);
        const faceB = Math.abs(b.bounds.size[first] * b.bounds.size[second]);
        if (overlap < 0.5 * Math.min(faceA, faceB)) continue;

        issues.push({
          severity: "info",
          path: `info.geometry.${a.part.id}`,
          message: `Mặt "${a.part.name}" khít mặt "${b.part.name}" (~${Math.round(overlap)} mm²); offset 0.5–1 mm nếu thấy z-fighting.`,
        });
        matched = true;
        reported += 1;
        break;
      }
      if (matched) continue;
    }
  }

  return issues;
}

export function checkTopology(model: ResolvedModel): Issue[] {
  const issues: Issue[] = [];
  const seen = new Map<string, string>();

  for (const part of model.parts) {
    checkPartTopology(part, issues);

    const key = geometryKey(part);
    const original = seen.get(key);
    if (original) {
      issues.push({
        severity: "warning",
        path: `logic.geometry.${part.id}`,
        message: `"${part.name}" has exactly the same solid as "${original}"; check for an accidental duplicate.`,
      });
    } else {
      seen.set(key, part.name);
    }
  }

  issues.push(...checkBuriedParts(model), ...checkCoincidentFaces(model));
  return issues;
}
