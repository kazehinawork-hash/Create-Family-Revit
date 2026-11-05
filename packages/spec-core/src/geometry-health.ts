import {
  partBounds,
  type Bounds,
  type ResolvedConnector,
  type ResolvedModel,
  type ResolvedSolid,
} from "./geometry.js";
import type { Issue } from "./types.js";

const EPSILON = 1e-6;

function finite(...values: number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

function sizeOf(bounds: Bounds): { x: number; y: number; z: number } {
  return bounds.size;
}

function intersects(a: Bounds, b: Bounds): boolean {
  const overlapX = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const overlapY = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
  const overlapZ = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  return overlapX > EPSILON && overlapY > EPSILON && overlapZ > EPSILON;
}

function solidIssues(solid: ResolvedSolid, path: string): Issue[] {
  const issues: Issue[] = [];
  const error = (message: string) => issues.push({ severity: "error", path, message });
  const warning = (message: string) => issues.push({ severity: "warning", path, message });

  switch (solid.kind) {
    case "box":
      if (!finite(solid.size.x, solid.size.y, solid.size.z)) error("box size is not finite");
      if (solid.size.x <= 0 || solid.size.y <= 0 || solid.size.z <= 0) {
        error("box has a zero or negative dimension");
      }
      if (solid.cornerRadius !== undefined) {
        if (!finite(solid.cornerRadius) || solid.cornerRadius < 0) {
          error("box cornerRadius must be a non-negative number");
        } else if (solid.cornerRadius > Math.min(Math.abs(solid.size.x), Math.abs(solid.size.y)) / 2 + EPSILON) {
          warning("box cornerRadius is larger than half the footprint and will be clamped");
        }
      }
      break;

    case "cylinder":
      if (!finite(solid.radius, solid.height)) error("cylinder dimensions are not finite");
      if (solid.radius <= 0) error("cylinder radius must be positive");
      if (Math.abs(solid.height) <= EPSILON) error("cylinder height must be non-zero");
      if (solid.innerRadius !== undefined) {
        if (!finite(solid.innerRadius) || solid.innerRadius < 0) {
          error("cylinder innerRadius must be non-negative");
        } else if (solid.innerRadius >= solid.radius) {
          error("cylinder innerRadius must be smaller than radius");
        }
      }
      break;

    case "frustum":
      if (!finite(solid.radiusBottom, solid.radiusTop, solid.height)) {
        error("frustum dimensions are not finite");
      }
      if (solid.radiusBottom < 0 || solid.radiusTop < 0) error("frustum radii must be non-negative");
      if (solid.radiusBottom + solid.radiusTop <= EPSILON) error("frustum has no usable radius");
      if (Math.abs(solid.height) <= EPSILON) error("frustum height must be non-zero");
      break;

    case "bend":
      if (!finite(solid.radius, solid.tubeRadius, solid.angle)) error("bend dimensions are not finite");
      if (solid.radius <= 0) error("bend radius must be positive");
      if (solid.tubeRadius <= 0) error("bend tubeRadius must be positive");
      if (Math.abs(solid.angle) <= EPSILON) error("bend angle must be non-zero");
      break;

    case "prism":
      if (solid.points.length < 3) error("prism needs at least 3 points");
      if (Math.abs(solid.to - solid.from) <= EPSILON) error("prism from and to must differ");
      for (const [index, hole] of solid.holes.entries()) {
        if (hole.length < 3) error(`prism hole ${index + 1} needs at least 3 points`);
      }
      break;

    case "loft":
      if (solid.sections.length < 2) error("loft needs at least 2 sections");
      for (let index = 0; index < solid.sections.length; index += 1) {
        const section = solid.sections[index];
        if (section.points.length < 3) error(`loft section ${index + 1} has fewer than 3 points`);
        if (index > 0 && section.at <= solid.sections[index - 1].at) {
          error("loft sections must be ordered by increasing at");
        }
      }
      break;
  }

  return issues;
}

function connectorIssues(connector: ResolvedConnector): Issue[] {
  const path = `logic.geometry.connector.${connector.id}`;
  const issues: Issue[] = [];
  const error = (message: string) => issues.push({ severity: "error", path, message });
  const warning = (message: string) => issues.push({ severity: "warning", path, message });

  if (!finite(connector.origin.x, connector.origin.y, connector.origin.z)) {
    error("connector origin is not finite");
  }
  if (connector.directionVector) {
    const { x, y, z } = connector.directionVector;
    if (!finite(x, y, z)) error("connector direction is not finite");
    else if (Math.hypot(x, y, z) <= EPSILON) error("connector direction vector is zero");
  }
  if (connector.shape === "round") {
    if (connector.diameter === undefined || connector.diameter <= 0) {
      warning("round connector needs a positive diameter");
    }
  } else {
    const hasRect = connector.width !== undefined && connector.width > 0 &&
      connector.height !== undefined && connector.height > 0;
    const hasRoundFallback = connector.diameter !== undefined && connector.diameter > 0;
    if (!hasRect && !hasRoundFallback) {
      warning("rectangular connector needs positive width and height");
    }
  }

  return issues;
}

/** Resolved-geometry checks that are cheap enough to run on every spec update. */
export function checkGeometryHealth(model: ResolvedModel): Issue[] {
  const issues: Issue[] = [];

  for (const part of model.parts) {
    const path = `logic.geometry.${part.id}`;
    issues.push(...solidIssues(part.solid, path));

    const bounds = partBounds(part);
    if (!finite(bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z)) {
      issues.push({ severity: "error", path, message: "part bounds are not finite" });
    } else if (sizeOf(bounds).x <= EPSILON && sizeOf(bounds).y <= EPSILON && sizeOf(bounds).z <= EPSILON) {
      issues.push({ severity: "error", path, message: "part has no usable volume" });
    }

    if (part.array.count < 1) {
      issues.push({ severity: "error", path, message: "array count must be at least 1" });
    } else if (part.array.count > 1 && Math.abs(part.array.spacing) <= EPSILON) {
      issues.push({ severity: "warning", path, message: "array copies overlap because spacing is zero" });
    }

    const host = partBounds({ ...part, array: { count: 1, axis: "x", spacing: 0 } });
    for (const [index, cut] of part.cuts.entries()) {
      // A cut that misses its host silently does nothing; surface it instead of
      // letting the studio and the RFA disagree about the result.
      const cutBounds = partBounds({
        ...part,
        solid: cut,
        cuts: [],
        array: { count: 1, axis: "x", spacing: 0 },
      });
      if (!intersects(host, cutBounds)) {
        issues.push({
          severity: "warning",
          path,
          message: `cut ${index + 1} does not intersect its host part`,
        });
      }
    }
  }

  for (const connector of model.connectors) {
    issues.push(...connectorIssues(connector));
  }

  return issues;
}
