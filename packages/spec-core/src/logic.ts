import { partBounds, unionBounds, type Bounds, type ResolvedModel, type ResolvedPart } from "./geometry.js";
import type { Issue } from "./types.js";

/**
 * Physical-layout sanity checks. These are warnings, not errors: a model with a
 * misplaced component still builds, but the issues are shown to the user and fed
 * back to the agent for one corrective pass.
 */

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

function isPart(part: ResolvedPart, patterns: RegExp[]): boolean {
  const text = normalize(`${part.id} ${part.name}`);
  return patterns.some((pattern) => pattern.test(text));
}

const COIL = [/cooling coil/, /evaporator/, /dan lanh/, /dan coil/];
const COIL_EXCLUDE = [/header/, /manifold/, /pipe/];
const PAN = [/drain pan/, /condensate/, /drain tray/, /mang nuoc/, /khay nuoc/];
const CASING = [/casing/, /housing/, /enclosure/, /vo may/, /than may/];
const FAN = [/\bfan\b/, /quat/];
const FILTER = [/filter/, /\bloc\b/];
const DRAIN = [/drain/, /ong xa/];

const PLACEMENT_TOLERANCE = 5;
const INSIDE_TOLERANCE = 2;

interface PlacedPart {
  part: ResolvedPart;
  bounds: Bounds;
}

function placed(model: ResolvedModel): PlacedPart[] {
  return model.parts.map((part) => ({ part, bounds: partBounds(part) }));
}

function overlap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin);
}

function inside(outer: Bounds, inner: Bounds, tolerance: number): boolean {
  return (
    inner.min.x >= outer.min.x - tolerance &&
    inner.max.x <= outer.max.x + tolerance &&
    inner.min.y >= outer.min.y - tolerance &&
    inner.max.y <= outer.max.y + tolerance &&
    inner.min.z >= outer.min.z - tolerance &&
    inner.max.z <= outer.max.z + tolerance
  );
}

function envelope(items: PlacedPart[]): Bounds | null {
  let result: Bounds | null = null;
  for (const item of items) result = unionBounds(result, item.bounds);
  return result;
}

const mm = (value: number): string => `${Math.round(value)} mm`;

export function checkModelLogic(model: ResolvedModel): Issue[] {
  const issues: Issue[] = [];
  const parts = placed(model);

  const coils = parts.filter(({ part }) => isPart(part, COIL) && !isPart(part, COIL_EXCLUDE));
  const pans = parts.filter(({ part }) => isPart(part, PAN));
  const casings = parts.filter(({ part }) => isPart(part, CASING));
  const fans = parts.filter(({ part }) => isPart(part, FAN));
  const filters = parts.filter(({ part }) => isPart(part, FILTER));
  const drains = parts.filter(({ part }) => isPart(part, DRAIN) && !isPart(part, PAN));

  // The condensate pan collects water from the cooling coil, so it must sit under it
  // and cover its footprint.
  for (const pan of pans) {
    for (const coil of coils) {
      if (pan.bounds.max.z > coil.bounds.min.z + PLACEMENT_TOLERANCE) {
        issues.push({
          severity: "warning",
          path: `logic.drain-pan.${pan.part.id}`,
          message:
            `"${pan.part.name}" must sit below "${coil.part.name}": ` +
            `pan top is ${mm(pan.bounds.max.z)}, coil bottom is ${mm(coil.bounds.min.z)}.`,
        });
      }

      const overlapX = overlap(pan.bounds.min.x, pan.bounds.max.x, coil.bounds.min.x, coil.bounds.max.x);
      const overlapY = overlap(pan.bounds.min.y, pan.bounds.max.y, coil.bounds.min.y, coil.bounds.max.y);
      if (overlapX <= 0 || overlapY <= 0) {
        issues.push({
          severity: "warning",
          path: `logic.drain-pan-coverage.${pan.part.id}`,
          message: `"${pan.part.name}" does not cover the footprint of "${coil.part.name}" in plan.`,
        });
      }
    }
  }

  // Equipment that lives inside the casing must not stick out of it.
  const shell = envelope(casings);
  if (shell) {
    const internal = [...coils, ...fans, ...filters, ...pans];
    for (const item of internal) {
      if (inside(shell, item.bounds, INSIDE_TOLERANCE)) continue;
      issues.push({
        severity: "warning",
        path: `logic.inside-casing.${item.part.id}`,
        message: `"${item.part.name}" extends outside the casing envelope.`,
      });
    }
  }

  // The drain connection belongs at the low point of the pan, not above it.
  if (pans.length > 0) {
    const panTop = Math.max(...pans.map((pan) => pan.bounds.max.z));
    for (const drain of drains) {
      if (drain.bounds.max.z <= panTop + 25) continue;
      issues.push({
        severity: "warning",
        path: `logic.drain-height.${drain.part.id}`,
        message: `"${drain.part.name}" is above the drain pan (${mm(drain.bounds.max.z)} vs pan top ${mm(panTop)}); the outlet must be at the low point of the pan.`,
      });
    }
  }

  return issues;
}
