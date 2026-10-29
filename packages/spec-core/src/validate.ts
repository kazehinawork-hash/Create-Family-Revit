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

function sanitizeId(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

const SOLID_KINDS = ["box", "cylinder", "prism"];

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
  } else if (kind === "cylinder") {
    requireVec("base");
    if (raw.radius === undefined) {
      issues.push({ severity: "error", path: `${path}.radius`, message: "radius is required" });
    }
    if (raw.height === undefined) {
      issues.push({ severity: "error", path: `${path}.height`, message: "height is required" });
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

    parts.push({
      id,
      name: text(entry.name) || id,
      material: text(entry.material) || undefined,
      color: text(entry.color) || undefined,
      solid: entry.solid as FamilyPart["solid"],
      cuts: Array.isArray(entry.cuts) ? (entry.cuts as FamilyPart["cuts"]) : [],
      array,
    });
  });

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
    notes: Array.isArray(root.notes) ? root.notes.map((note) => String(note)) : undefined,
  };

  return { spec, issues };
}
