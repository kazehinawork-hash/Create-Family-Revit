import { expressionDependencies } from "./expr.js";
import { paramKey } from "./parameters.js";
import {
  CATEGORIES,
  LIMITS,
  PARAMETER_GROUPS,
  PARAMETER_TYPES,
  type FamilyParameter,
  type FamilyPart,
  type FamilySpec,
  type Issue,
  type ParameterGroup,
  type ParameterType,
} from "./types.js";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasNumbersValue(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

/** Accepts "1910 mm", "1,910" or 1910 and normalises to a number when possible. */
function coerceNumericText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const stripped = value
    .trim()
    .replace(/\s*(mm|cm|m|ft|in|°|deg|degrees?)\s*$/i, "")
    .replace(/,/g, "");
  if (!stripped) return value;
  const numeric = Number(stripped);
  return Number.isFinite(numeric) ? numeric : value;
}

/** Returns the value only when it is a plain number after stripping a unit suffix. */
function literalNumber(value: unknown): number | null {
  const coerced = coerceNumericText(value);
  return typeof coerced === "number" && Number.isFinite(coerced) ? coerced : null;
}

function polygonArea(points: [number, number][]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index];
    const [bx, by] = points[(index + 1) % points.length];
    area += ax * by - bx * ay;
  }
  return area / 2;
}

function segmentsCross(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const cross = (p: [number, number], q: [number, number], r: [number, number]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
    ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

function polygonSelfIntersects(points: [number, number][]): boolean {
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j += 1) {
      const adjacent = j === i || j === (i + 1) % points.length || (j + 1) % points.length === i;
      if (adjacent) continue;
      const c = points[j];
      const d = points[(j + 1) % points.length];
      if (segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

function sanitizeId(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

const SOLID_KINDS = [
  "box",
  "cylinder",
  "frustum",
  "bend",
  "prism",
  "loft",
  "revolve",
  "tube",
];

function checkSolid(raw: unknown, path: string, issues: Issue[]): void {
  if (!isObject(raw)) {
    issues.push({ severity: "error", path, message: `${path} must be an object` });
    return;
  }
  const kind = text(raw.kind);
  if (!SOLID_KINDS.includes(kind)) {
    issues.push({
      severity: "error",
      path: `${path}.kind`,
      message: `Must be one of ${SOLID_KINDS.join(", ")} (got "${kind || "nothing"}")`,
    });
    return;
  }

  const requireVec = (field: string) => {
    const value = raw[field];
    if (!isObject(value)) {
      issues.push({ severity: "error", path: `${path}.${field}`, message: `${field} must be {x, y, z}` });
      return;
    }
    for (const axis of ["x", "y", "z"]) {
      if (value[axis] === undefined || value[axis] === null || value[axis] === "") {
        issues.push({
          severity: "error",
          path: `${path}.${field}.${axis}`,
          message: `${field}.${axis} is required`,
        });
      } else if (!hasNumbersValue(value[axis])) {
        issues.push({
          severity: "error",
          path: `${path}.${field}.${axis}`,
          message: `${field}.${axis} must be a number or an expression string`,
        });
      }
    }
  };

  if (kind === "box") {
    requireVec("origin");
    requireVec("size");
    if (isObject(raw.size)) {
      for (const axis of ["x", "y", "z"]) {
        const value = literalNumber(raw.size[axis]);
        if (value !== null && Math.abs(value) < 1e-9) {
          issues.push({
            severity: "error",
            path: `${path}.size.${axis}`,
            message: `size.${axis} must not be zero`,
          });
        }
      }
    }
    if (
      raw.cornerRadius !== undefined &&
      raw.cornerRadius !== null &&
      raw.cornerRadius !== "" &&
      !hasNumbersValue(raw.cornerRadius)
    ) {
      issues.push({
        severity: "error",
        path: `${path}.cornerRadius`,
        message: "cornerRadius must be a number or an expression string",
      });
    }
    const cornerRadius = literalNumber(raw.cornerRadius);
    if (cornerRadius !== null && cornerRadius < 0) {
      issues.push({
        severity: "error",
        path: `${path}.cornerRadius`,
        message: "cornerRadius must be zero or greater",
      });
    }
    const rotation = literalNumber(raw.rotationZ);
    if (rotation !== null && Math.abs(((rotation % 90) + 90) % 90) > 1e-6) {
      issues.push({
        severity: "warning",
        path: `${path}.rotationZ`,
        message:
          "A box rotated off the 90° axes builds, but Revit cannot lock its faces to the reference planes; use Rebuild from spec after changing parameters.",
      });
    }
  } else if (kind === "cylinder") {
    requireVec("base");
    if (raw.radius === undefined) {
      issues.push({ severity: "error", path: `${path}.radius`, message: "radius is required" });
    }
    if (raw.height === undefined) {
      issues.push({ severity: "error", path: `${path}.height`, message: "height is required" });
    }
    const radius = literalNumber(raw.radius);
    const height = literalNumber(raw.height);
    const innerRadius = literalNumber(raw.innerRadius);
    if (radius !== null && radius <= 0) {
      issues.push({ severity: "error", path: `${path}.radius`, message: "radius must be greater than zero" });
    }
    if (height !== null && Math.abs(height) < 1e-9) {
      issues.push({ severity: "error", path: `${path}.height`, message: "height must not be zero" });
    }
    if (innerRadius !== null && innerRadius < 0) {
      issues.push({
        severity: "error",
        path: `${path}.innerRadius`,
        message: "innerRadius must be zero or greater",
      });
    }
    if (innerRadius !== null && radius !== null && innerRadius >= radius) {
      issues.push({
        severity: "error",
        path: `${path}.innerRadius`,
        message: "innerRadius must be smaller than radius",
      });
    }
  } else if (kind === "frustum") {
    requireVec("base");
    if (raw.radiusBottom === undefined) {
      issues.push({
        severity: "error",
        path: `${path}.radiusBottom`,
        message: "radiusBottom is required",
      });
    }
    if (raw.radiusTop === undefined) {
      issues.push({
        severity: "error",
        path: `${path}.radiusTop`,
        message: "radiusTop is required (use 0 for a cone)",
      });
    }
    if (raw.height === undefined) {
      issues.push({ severity: "error", path: `${path}.height`, message: "height is required" });
    }
    if (raw.axis !== undefined && !["x", "y", "z"].includes(text(raw.axis))) {
      issues.push({ severity: "error", path: `${path}.axis`, message: "axis must be x, y or z" });
    }
    const radiusBottom = literalNumber(raw.radiusBottom);
    const radiusTop = literalNumber(raw.radiusTop);
    const height = literalNumber(raw.height);
    if (radiusBottom !== null && radiusBottom < 0) {
      issues.push({
        severity: "error",
        path: `${path}.radiusBottom`,
        message: "radiusBottom must be zero or greater",
      });
    }
    if (radiusTop !== null && radiusTop < 0) {
      issues.push({
        severity: "error",
        path: `${path}.radiusTop`,
        message: "radiusTop must be zero or greater",
      });
    }
    if (radiusBottom !== null && radiusTop !== null && radiusBottom <= 0 && radiusTop <= 0) {
      issues.push({
        severity: "error",
        path,
        message: "at least one of radiusBottom and radiusTop must be greater than zero",
      });
    }
    if (height !== null && Math.abs(height) < 1e-9) {
      issues.push({ severity: "error", path: `${path}.height`, message: "height must not be zero" });
    }
  } else if (kind === "bend") {
    requireVec("center");
    if (raw.radius === undefined) {
      issues.push({ severity: "error", path: `${path}.radius`, message: "radius is required" });
    }
    if (raw.tubeRadius === undefined) {
      issues.push({
        severity: "error",
        path: `${path}.tubeRadius`,
        message: "tubeRadius is required",
      });
    }
    if (raw.plane !== undefined && !["xy", "xz", "yz"].includes(text(raw.plane))) {
      issues.push({ severity: "error", path: `${path}.plane`, message: "plane must be xy, xz or yz" });
    }
    const radius = literalNumber(raw.radius);
    const tubeRadius = literalNumber(raw.tubeRadius);
    const angle = literalNumber(raw.angle);
    if (radius !== null && radius <= 0) {
      issues.push({ severity: "error", path: `${path}.radius`, message: "radius must be greater than zero" });
    }
    if (tubeRadius !== null && tubeRadius <= 0) {
      issues.push({
        severity: "error",
        path: `${path}.tubeRadius`,
        message: "tubeRadius must be greater than zero",
      });
    }
    if (radius !== null && tubeRadius !== null && tubeRadius >= radius) {
      issues.push({
        severity: "error",
        path: `${path}.tubeRadius`,
        message: "tubeRadius must be smaller than radius",
      });
    }
    if (angle !== null && (angle <= 0 || angle > 360)) {
      issues.push({
        severity: "error",
        path: `${path}.angle`,
        message: "angle must be greater than zero and at most 360 degrees",
      });
    }
  } else if (kind === "prism") {
    if (!["xy", "xz", "yz"].includes(text(raw.plane))) {
      issues.push({ severity: "error", path: `${path}.plane`, message: "plane must be xy, xz or yz" });
    }
    if (!Array.isArray(raw.points) || raw.points.length < 3) {
      issues.push({
        severity: "error",
        path: `${path}.points`,
        message: "points must be an array of at least 3 [a, b] pairs",
      });
    }
    if (raw.from === undefined || raw.to === undefined) {
      issues.push({ severity: "error", path, message: "from and to are required" });
    }
    const from = literalNumber(raw.from);
    const to = literalNumber(raw.to);
    if (from !== null && to !== null && Math.abs(to - from) < 1e-9) {
      issues.push({ severity: "error", path, message: "from and to must differ" });
    }

    const toPoint = (value: unknown): [number, number] | null => {
      if (!Array.isArray(value) || value.length < 2) return null;
      const a = literalNumber(value[0]);
      const b = literalNumber(value[1]);
      return a !== null && b !== null ? [a, b] : null;
    };

    if (Array.isArray(raw.points)) {
      const points = raw.points.map(toPoint);
      if (points.every((point): point is [number, number] => point !== null)) {
        for (let index = 0; index < points.length; index += 1) {
          const current = points[index];
          const next = points[(index + 1) % points.length];
          if (Math.abs(current[0] - next[0]) < 1e-9 && Math.abs(current[1] - next[1]) < 1e-9) {
            issues.push({
              severity: "error",
              path: `${path}.points[${index}]`,
              message: "consecutive points must not be identical",
            });
            break;
          }
        }
        if (polygonSelfIntersects(points)) {
          issues.push({
            severity: "error",
            path: `${path}.points`,
            message: "polygon edges intersect each other",
          });
        } else if (Math.abs(polygonArea(points)) < 1e-6) {
          issues.push({ severity: "error", path: `${path}.points`, message: "polygon has zero area" });
        }
      }
    }

    if (raw.holes !== undefined) {
      if (!Array.isArray(raw.holes)) {
        issues.push({ severity: "error", path: `${path}.holes`, message: "holes must be an array" });
      } else {
        raw.holes.forEach((hole, holeIndex) => {
          if (!Array.isArray(hole) || hole.length < 3) {
            issues.push({
              severity: "error",
              path: `${path}.holes[${holeIndex}]`,
              message: "each hole needs at least 3 [a, b] pairs",
            });
            return;
          }
          const points = hole.map(toPoint);
          if (points.every((point): point is [number, number] => point !== null)) {
            if (polygonSelfIntersects(points)) {
              issues.push({
                severity: "error",
                path: `${path}.holes[${holeIndex}]`,
                message: "hole edges intersect each other",
              });
            } else if (Math.abs(polygonArea(points)) < 1e-6) {
              issues.push({
                severity: "error",
                path: `${path}.holes[${holeIndex}]`,
                message: "hole has zero area",
              });
            }
          }
        });
      }
    }
  } else if (kind === "loft") {
    const axis = text(raw.axis) || "z";
    if (!["x", "y", "z"].includes(axis)) {
      issues.push({ severity: "error", path: `${path}.axis`, message: "axis must be x, y or z" });
    }
    const segments = literalNumber(raw.segments);
    if (segments !== null && (segments < 8 || segments > 96)) {
      issues.push({
        severity: "error",
        path: `${path}.segments`,
        message: "segments must be between 8 and 96",
      });
    }

    if (!Array.isArray(raw.sections) || raw.sections.length < 2) {
      issues.push({
        severity: "error",
        path: `${path}.sections`,
        message: "sections needs at least two profiles",
      });
    } else {
      const positions: number[] = [];
      raw.sections.forEach((section, index) => {
        if (!isObject(section)) {
          issues.push({
            severity: "error",
            path: `${path}.sections[${index}]`,
            message: "section must be an object",
          });
          return;
        }
        if (section.at === undefined) {
          issues.push({
            severity: "error",
            path: `${path}.sections[${index}].at`,
            message: "at is required",
          });
        }
        const at = literalNumber(section.at);
        if (at !== null) positions.push(at);

        const profile = section.profile;
        if (!isObject(profile)) {
          issues.push({
            severity: "error",
            path: `${path}.sections[${index}].profile`,
            message: "profile must be an object",
          });
          return;
        }

        const profileKind = text(profile.kind);
        if (profileKind === "circle") {
          const radius = literalNumber(profile.radius);
          if (profile.radius === undefined) {
            issues.push({
              severity: "error",
              path: `${path}.sections[${index}].profile.radius`,
              message: "radius is required",
            });
          } else if (radius !== null && radius <= 0) {
            issues.push({
              severity: "error",
              path: `${path}.sections[${index}].profile.radius`,
              message: "radius must be greater than zero",
            });
          }
        } else if (profileKind === "rect") {
          for (const field of ["width", "height"]) {
            if (profile[field] === undefined) {
              issues.push({
                severity: "error",
                path: `${path}.sections[${index}].profile.${field}`,
                message: `${field} is required`,
              });
              continue;
            }
            const value = literalNumber(profile[field]);
            if (value !== null && value <= 0) {
              issues.push({
                severity: "error",
                path: `${path}.sections[${index}].profile.${field}`,
                message: `${field} must be greater than zero`,
              });
            }
          }
        } else if (profileKind === "polygon") {
          if (!Array.isArray(profile.points) || profile.points.length < 3) {
            issues.push({
              severity: "error",
              path: `${path}.sections[${index}].profile.points`,
              message: "points needs at least 3 [a, b] pairs",
            });
          }
        } else {
          issues.push({
            severity: "error",
            path: `${path}.sections[${index}].profile.kind`,
            message: "profile.kind must be circle, rect or polygon",
          });
        }
      });

      if (positions.length === raw.sections.length) {
        for (let index = 1; index < positions.length; index += 1) {
          if (!(positions[index] > positions[index - 1])) {
            issues.push({
              severity: "error",
              path: `${path}.sections`,
              message: "sections must be ordered by increasing at",
            });
            break;
          }
        }
      }

      if (raw.sections.length > 2) {
        issues.push({
          severity: "warning",
          path: `${path}.sections`,
          message:
            "The Revit family builder currently lofts exactly two sections; extra sections preview in the studio but are skipped in the .rfa.",
        });
      }
    }
  } else if (kind === "revolve") {
    if (raw.axis !== undefined && !["x", "y", "z"].includes(text(raw.axis))) {
      issues.push({ severity: "error", path: `${path}.axis`, message: "axis must be x, y or z" });
    }
    if (raw.origin !== undefined) {
      requireVec("origin");
    }
    if (!Array.isArray(raw.points) || raw.points.length < 3) {
      issues.push({
        severity: "error",
        path: `${path}.points`,
        message: "points must be an array of at least 3 [radial, height] pairs",
      });
    }
    const angle = literalNumber(raw.angle);
    if (angle !== null && (angle <= 0 || angle > 360)) {
      issues.push({
        severity: "error",
        path: `${path}.angle`,
        message: "angle must be greater than zero and at most 360 degrees",
      });
    }
    if (Array.isArray(raw.points)) {
      raw.points.forEach((pt, ptIndex) => {
        if (!Array.isArray(pt) || pt.length < 2) {
          issues.push({
            severity: "error",
            path: `${path}.points[${ptIndex}]`,
            message: "each point must be an [r, h] pair",
          });
        } else {
          const r = literalNumber(pt[0]);
          if (r !== null && r < 0) {
            issues.push({
              severity: "error",
              path: `${path}.points[${ptIndex}][0]`,
              message: "radial distance must be zero or greater",
            });
          }
        }
      });
    }
  } else if (kind === "tube") {
    requireVec("start");
    requireVec("end");
    if (raw.radius === undefined) {
      issues.push({ severity: "error", path: `${path}.radius`, message: "radius is required" });
    }
    const radius = literalNumber(raw.radius);
    const innerRadius = literalNumber(raw.innerRadius);
    if (radius !== null && radius <= 0) {
      issues.push({
        severity: "error",
        path: `${path}.radius`,
        message: "radius must be greater than zero",
      });
    }
    if (innerRadius !== null && innerRadius < 0) {
      issues.push({
        severity: "error",
        path: `${path}.innerRadius`,
        message: "innerRadius must be zero or greater",
      });
    }
    if (innerRadius !== null && radius !== null && innerRadius >= radius) {
      issues.push({
        severity: "error",
        path: `${path}.innerRadius`,
        message: "innerRadius must be smaller than radius",
      });
    }

    if (isObject(raw.start) && isObject(raw.end)) {
      const coords = [
        literalNumber(raw.start.x),
        literalNumber(raw.start.y),
        literalNumber(raw.start.z),
        literalNumber(raw.end.x),
        literalNumber(raw.end.y),
        literalNumber(raw.end.z),
      ];
      if (coords.every((value): value is number => value !== null)) {
        const length = Math.hypot(
          coords[3] - coords[0],
          coords[4] - coords[1],
          coords[5] - coords[2],
        );
        if (length < 1e-9) {
          issues.push({
            severity: "error",
            path,
            message: "start and end must differ",
          });
        }
      }
    }

    const segments = literalNumber(raw.segments);
    if (segments !== null && (segments < 12 || segments > 96)) {
      issues.push({
        severity: "error",
        path: `${path}.segments`,
        message: "segments must be between 12 and 96",
      });
    }
  }
}

/** Collects every "[Parameter Name]" reference anywhere inside a raw subtree. */
function collectReferences(value: unknown, into: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const match of value.matchAll(/\[([^\]]+)\]/g)) {
      into.add(match[1].trim().toLowerCase());
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, into);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Json)) collectReferences(item, into);
  }
}

export interface ValidationResult {
  spec: FamilySpec;
  issues: Issue[];
}

export function validateSpec(raw: unknown): ValidationResult {
  const issues: Issue[] = [];
  const root: Json = isObject(raw) ? raw : {};

  if (!isObject(raw)) {
    issues.push({ severity: "error", path: "$", message: "The spec must be a JSON object" });
  }

  let name = text(root.name);
  if (!name) {
    name = "Untitled Family";
    issues.push({ severity: "warning", path: "name", message: 'Missing "name", using "Untitled Family"' });
  }

  const category = text(root.category) || "Generic Model";
  if (!CATEGORIES.includes(text(root.category))) {
    issues.push({
      severity: "warning",
      path: "category",
      message: `Category "${category}" is not mapped to a Revit template; using "Generic Model"`,
    });
  }
  const resolvedCategory = CATEGORIES.includes(category) ? category : "Generic Model";

  const rawParameters = Array.isArray(root.parameters) ? root.parameters : [];
  if (!Array.isArray(root.parameters)) {
    issues.push({ severity: "error", path: "parameters", message: "parameters must be an array" });
  }
  if (rawParameters.length > LIMITS.maxParameters) {
    issues.push({
      severity: "warning",
      path: "parameters",
      message: `Only the first ${LIMITS.maxParameters} parameters are used`,
    });
  }

  const parameters: FamilyParameter[] = [];
  const seen = new Set<string>();

  rawParameters.slice(0, LIMITS.maxParameters).forEach((entry, index) => {
    const path = `parameters[${index}]`;
    if (!isObject(entry)) {
      issues.push({ severity: "error", path, message: "Parameter must be an object" });
      return;
    }

    const paramName = text(entry.name);
    if (!paramName) {
      issues.push({ severity: "error", path: `${path}.name`, message: "name is required" });
      return;
    }
    if (paramName.length > LIMITS.maxNameLength) {
      issues.push({
        severity: "warning",
        path: `${path}.name`,
        message: `Name longer than ${LIMITS.maxNameLength} characters will be truncated`,
      });
    }

    const key = paramKey(paramName);
    if (seen.has(key)) {
      issues.push({
        severity: "warning",
        path: `${path}.name`,
        message: `Duplicate parameter "${paramName}" ignored`,
      });
      return;
    }
    seen.add(key);

    let type = text(entry.type) as ParameterType;
    if (!PARAMETER_TYPES.includes(type)) {
      const fallback: ParameterType = typeof entry.value === "string" ? "Text" : "Length";
      issues.push({
        severity: "warning",
        path: `${path}.type`,
        message: `Unknown type "${type ?? ""}", using "${fallback}"`,
      });
      type = fallback;
    }

    const groupText = text(entry.group);
    const group: ParameterGroup | undefined = PARAMETER_GROUPS.includes(groupText as ParameterGroup)
      ? (groupText as ParameterGroup)
      : undefined;
    if (groupText && !group) {
      issues.push({
        severity: "warning",
        path: `${path}.group`,
        message: `Unknown group "${groupText}", using a default group`,
      });
    }

    const axisText = text(entry.axis);
    let axis: "x" | "y" | "z" | undefined;
    if (axisText) {
      if (!["x", "y", "z"].includes(axisText)) {
        issues.push({
          severity: "error",
          path: `${path}.axis`,
          message: "axis must be x, y or z",
        });
      } else {
        axis = axisText as "x" | "y" | "z";
        if (type !== "Length") {
          issues.push({
            severity: "warning",
            path: `${path}.axis`,
            message: "axis only applies to Length parameters and is ignored",
          });
        }
      }
    }

    const formula = text(entry.formula) || undefined;
    let value =
      type === "Text" || type === "YesNo" ? entry.value : coerceNumericText(entry.value);

    if (formula && value !== undefined && value !== "") {
      issues.push({
        severity: "warning",
        path: `${path}.value`,
        message: "A parameter with a formula cannot also carry a value; the value is ignored",
      });
      value = undefined;
    }

    if (value === undefined && !formula) {
      issues.push({
        severity: "warning",
        path: `${path}.value`,
        message: "No value or formula provided, defaulting to zero",
      });
      value = type === "Text" ? "" : type === "YesNo" ? false : 0;
    }

    if (type === "Text" && value !== undefined) value = String(value);
    if (type === "YesNo" && value !== undefined) {
      const flag = typeof value === "boolean" ? value : String(value).toLowerCase() === "yes" || value === 1;
      value = flag;
    }

    parameters.push({
      name: paramName,
      type,
      group,
      instance: Boolean(entry.instance),
      description: text(entry.description) || undefined,
      axis,
      formula,
      value: value as number | string | boolean | undefined,
    });
  });

  for (const parameter of parameters) {
    if (!parameter.formula) continue;
    try {
      for (const dependency of expressionDependencies(parameter.formula)) {
        if (!seen.has(paramKey(dependency))) {
          issues.push({
            severity: "error",
            path: `parameters.${parameter.name}.formula`,
            message: `Formula references unknown parameter "${dependency}"`,
          });
        }
      }
    } catch (error) {
      issues.push({
        severity: "error",
        path: `parameters.${parameter.name}.formula`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const rawParts = Array.isArray(root.parts) ? root.parts : [];
  if (!Array.isArray(root.parts) || rawParts.length === 0) {
    issues.push({ severity: "error", path: "parts", message: "parts must be a non-empty array" });
  }
  if (rawParts.length > LIMITS.maxParts) {
    issues.push({
      severity: "warning",
      path: "parts",
      message: `Only the first ${LIMITS.maxParts} parts are used`,
    });
  }

  const parts: FamilyPart[] = [];
  const seenIds = new Set<string>();

  rawParts.slice(0, LIMITS.maxParts).forEach((entry, index) => {
    const path = `parts[${index}]`;
    if (!isObject(entry)) {
      issues.push({ severity: "error", path, message: "Part must be an object" });
      return;
    }

    const id = sanitizeId(text(entry.id) || text(entry.name), `part-${index + 1}`);
    if (seenIds.has(id)) {
      issues.push({ severity: "warning", path: `${path}.id`, message: `Duplicate part id "${id}" ignored` });
      return;
    }
    seenIds.add(id);

    checkSolid(entry.solid, `${path}.solid`, issues);

    if (entry.cuts !== undefined) {
      if (!Array.isArray(entry.cuts)) {
        issues.push({ severity: "error", path: `${path}.cuts`, message: "cuts must be an array" });
      } else {
        entry.cuts.forEach((cut, cutIndex) => checkSolid(cut, `${path}.cuts[${cutIndex}]`, issues));
      }
    }

    let array: FamilyPart["array"];
    if (entry.array !== undefined) {
      if (!isObject(entry.array)) {
        issues.push({ severity: "error", path: `${path}.array`, message: "array must be an object" });
      } else {
        const rawCount = entry.array.count;
        const axis = text(entry.array.axis) || "x";
        const countIsNumber = typeof rawCount === "number";

        if (rawCount === undefined || rawCount === null || rawCount === "") {
          issues.push({ severity: "error", path: `${path}.array.count`, message: "count is required" });
        } else if (
          countIsNumber &&
          (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > LIMITS.maxArrayCount)
        ) {
          issues.push({
            severity: "error",
            path: `${path}.array.count`,
            message: `count must be a whole number between 1 and ${LIMITS.maxArrayCount}`,
          });
        } else if (!countIsNumber && typeof rawCount !== "string") {
          issues.push({ severity: "error", path: `${path}.array.count`, message: "count must be a number" });
        } else if (!["x", "y", "z"].includes(axis)) {
          issues.push({ severity: "error", path: `${path}.array.axis`, message: "axis must be x, y or z" });
        } else if (entry.array.spacing === undefined) {
          issues.push({ severity: "error", path: `${path}.array.spacing`, message: "spacing is required" });
        } else {
          array = {
            count: rawCount as number | string,
            axis: axis as "x" | "y" | "z",
            spacing: entry.array.spacing as number | string,
          };
        }
      }
    }

    let anchor: FamilyPart["anchor"];
    if (entry.anchor !== undefined) {
      if (!isObject(entry.anchor)) {
        issues.push({ severity: "error", path: `${path}.anchor`, message: "anchor must be an object" });
      } else {
        for (const axis of ["x", "y", "z"] as const) {
          const rawSide = text(entry.anchor[axis]);
          if (!rawSide) continue;
          if (rawSide !== "min" && rawSide !== "max") {
            issues.push({
              severity: "error",
              path: `${path}.anchor.${axis}`,
              message: "anchor side must be min or max",
            });
            continue;
          }
          anchor = { ...anchor, [axis]: rawSide };
        }
      }
    }

    parts.push({
      id,
      name: text(entry.name) || id,
      material: text(entry.material) || undefined,
      color: text(entry.color) || undefined,
      solid: entry.solid as FamilyPart["solid"],
      cuts: Array.isArray(entry.cuts) ? (entry.cuts as FamilyPart["cuts"]) : [],
      array,
      anchor,
    });
  });

  // Numeric parameters exist to drive geometry; one that nothing references is dead
  // weight in the finished family. Text/YesNo parameters are legitimate metadata.
  const referenced = new Set<string>();
  collectReferences({ parts: root.parts, connectors: root.connectors }, referenced);
  for (const parameter of parameters) {
    if (parameter.formula) collectReferences(parameter.formula, referenced);
  }
  for (const parameter of parameters) {
    if (parameter.type === "Text" || parameter.type === "YesNo") continue;
    if (referenced.has(paramKey(parameter.name))) continue;
    issues.push({
      severity: "warning",
      path: `parameters.${parameter.name}`,
      message: "Parameter is declared but never used by a formula or a geometry field",
    });
  }

  const materials = Array.isArray(root.materials)
    ? root.materials
        .filter(isObject)
        .map((material) => ({
          name: text(material.name) || "Default",
          color: text(material.color) || undefined,
          metalness: typeof material.metalness === "number" ? material.metalness : undefined,
          roughness: typeof material.roughness === "number" ? material.roughness : undefined,
        }))
    : undefined;

  const connectors = Array.isArray(root.connectors)
    ? root.connectors
        .filter(isObject)
        .map((conn, idx) => ({
          id: sanitizeId(text(conn.id) || text(conn.name), `connector-${idx + 1}`),
          name: text(conn.name) || `Connector ${idx + 1}`,
          systemType: (text(conn.systemType) || "SupplyAir") as any,
          shape: (text(conn.shape) === "round" ? "round" : "rectangular") as any,
          direction: (["in", "out", "bidirectional"].includes(text(conn.direction))
            ? text(conn.direction)
            : "out") as any,
          host: (text(conn.host) === "reference-plane"
            ? "reference-plane"
            : text(conn.host) === "solid"
              ? "solid"
              : undefined) as any,
          origin: (isObject(conn.origin) ? conn.origin : { x: 0, y: 0, z: 0 }) as any,
          directionVector: isObject(conn.directionVector) ? (conn.directionVector as any) : undefined,
          width: conn.width as any,
          height: conn.height as any,
          diameter: conn.diameter as any,
          flow: conn.flow as any,
          flowUnit: conn.flowUnit as any,
          pressureDrop: conn.pressureDrop as any,
        }))
    : undefined;

  // The Types tab owns this list; an agent edit must not erase it.
  const types = Array.isArray(root.types)
    ? root.types
        .filter(isObject)
        .map((entry, index) => {
          const values: Record<string, number> = {};
          if (isObject(entry.values)) {
            for (const [key, value] of Object.entries(entry.values)) {
              const numeric = Number(value);
              if (Number.isFinite(numeric)) values[key] = numeric;
            }
          }

          return {
            name: text(entry.name) || `Type ${index + 1}`,
            values,
            autoName: entry.autoName === true ? true : undefined,
          };
        })
        .filter((entry) => Object.keys(entry.values).length > 0)
    : undefined;

  const spec: FamilySpec = {
    schemaVersion: "1.0",
    name,
    typeName: text(root.typeName) || undefined,
    category: resolvedCategory,
    template: text(root.template) || undefined,
    units: "mm",
    revitVersion: text(root.revitVersion) || undefined,
    lod: [200, 300, 350, 400].includes(Number(root.lod)) ? (Number(root.lod) as 200 | 300 | 350 | 400) : undefined,
    description: text(root.description) || undefined,
    parameters,
    parts,
    connectors,
    materials,
    types,
    notes: Array.isArray(root.notes) ? root.notes.map((note) => String(note)) : undefined,
  };

  return { spec, issues };
}
