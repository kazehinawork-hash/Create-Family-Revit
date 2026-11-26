/**
 * Sheet-metal macros.
 *
 * A macro is a compact, parametric description of a folded-sheet assembly (a tray run
 * with mitred corners, slots, …). `expandMacros` runs before validation and replaces
 * each macro with ordinary prism parts whose coordinates are still formulas over the
 * family parameters — so the viewer, the Revit add-in and later edits keep working
 * without knowing anything about macros.
 */
import type { FamilyPart, Issue, MepConnector, Numeric, SpecMacro, TrayRunMacro } from "./types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numeric(value: unknown): Numeric | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

/** Wrap a Numeric so it can be embedded in a larger expression safely. */
function expr(value: Numeric): string {
  return typeof value === "number" ? String(value) : `(${value})`;
}

/** A Numeric value scaled by a numeric constant; zero disappears from the sum. */
function scale(value: Numeric | string, factor: number): string | null {
  if (Math.abs(factor) < 1e-12) return null;
  const body = typeof value === "number" ? String(value) : `(${value})`;
  if (Math.abs(factor - 1) < 1e-12) return body;
  if (Math.abs(factor + 1) < 1e-12) return `-${body}`;
  return `${body} * ${Number(factor.toFixed(8))}`;
}

function add(base: Numeric | string, term: string | number | null): string {
  const first = typeof base === "number" ? String(base) : base;
  if (term === null || term === undefined) return first;
  return `(${first}) + (${term})`;
}

function macroId(macro: TrayRunMacro, index: number): string {
  const raw = text(macro.id) || `tray-run-${index + 1}`;
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || `tray-run-${index + 1}`;
}

interface Leg {
  index: number;
  length: Numeric;
  /** Heading in degrees, 0 = +X. */
  heading: number;
  start: { x: string; y: string };
  end: { x: string; y: string };
  /** Signed turn (degrees) at the start/end joint; 0 for a free end. */
  turnIn: number;
  turnOut: number;
}

const DIRECTION_TURNS: Record<string, number> = { left: 1, right: -1 };
const SUPPORTED_ANGLES = new Set([45, 90]);

function readSegments(
  raw: unknown,
  path: string,
  issues: Issue[],
): { straights: { length: Numeric; turn: number }[] } | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push({ severity: "error", path, message: "segments must be a non-empty array" });
    return null;
  }

  const straights: { length: Numeric; turn: number }[] = [];
  let pendingTurn = 0;
  let ok = true;

  raw.forEach((entry, index) => {
    const item = `${path}[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ severity: "error", path: item, message: "segment must be an object" });
      ok = false;
      return;
    }
    const kind = text(entry.kind);

    if (kind === "straight") {
      const length = numeric(entry.length);
      if (length === null) {
        issues.push({
          severity: "error",
          path: `${item}.length`,
          message: "length is required (number or formula)",
        });
        ok = false;
        return;
      }
      straights.push({ length, turn: pendingTurn });
      pendingTurn = 0;
      return;
    }

    if (kind === "bend") {
      const angle = Number(entry.angle);
      const direction = text(entry.direction) || "left";
      if (!Number.isFinite(angle) || angle <= 0 || angle >= 180) {
        issues.push({
          severity: "error",
          path: `${item}.angle`,
          message: "angle must be a number between 0 and 180 degrees",
        });
        ok = false;
        return;
      }
      if (!SUPPORTED_ANGLES.has(angle)) {
        issues.push({
          severity: "error",
          path: `${item}.angle`,
          message: "trayRun currently supports 45° and 90° plan bends",
        });
        ok = false;
        return;
      }
      if (direction === "up" || direction === "down") {
        issues.push({
          severity: "error",
          path: `${item}.direction`,
          message: "up/down bends are not supported yet; use a plan bend",
        });
        ok = false;
        return;
      }
      const turn = DIRECTION_TURNS[direction];
      if (!turn) {
        issues.push({
          severity: "error",
          path: `${item}.direction`,
          message: "direction must be left or right",
        });
        ok = false;
        return;
      }
      if (pendingTurn !== 0) {
        issues.push({
          severity: "error",
          path: item,
          message: "two bends cannot follow each other without a straight segment",
        });
        ok = false;
        return;
      }
      if (straights.length === 0) {
        issues.push({
          severity: "error",
          path: item,
          message: "a run must start with a straight segment",
        });
        ok = false;
        return;
      }
      pendingTurn = angle * turn;
      return;
    }

    issues.push({
      severity: "error",
      path: `${item}.kind`,
      message: `unknown segment kind "${kind}"; use straight or bend`,
    });
    ok = false;
  });

  if (pendingTurn !== 0) {
    issues.push({
      severity: "error",
      path,
      message: "the last bend needs a straight segment after it",
    });
    ok = false;
  }
  return ok ? { straights } : null;
}

/** Signed miter coefficient: offset point = vertex + s * (cx, cy). */
function miterCoefficient(turnDegrees: number): { cx: number; cy: number } {
  if (Math.abs(turnDegrees) < 1e-9) return { cx: 0, cy: 0 };
  // For an offset s on the left side of the incoming leg, the corner is the
  // intersection of the two offset lines: V + s*n_in + t*u_in with
  // t = -s * (1 - cos β) / sin β.
  const beta = (turnDegrees * Math.PI) / 180;
  const t = -(1 - Math.cos(beta)) / Math.sin(beta);
  // Incoming heading is baked in later; the coefficient is in the incoming frame:
  // n_in = (0, 1), u_in = (1, 0).
  return { cx: t, cy: 1 };
}

function rotate(x: number, y: number, headingDegrees: number): { x: number; y: number } {
  const angle = (headingDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

function bandPoint(
  vertex: { x: string; y: string },
  heading: number,
  turn: number,
  offset: Numeric,
): { x: string; y: string } {
  if (Math.abs(turn) < 1e-9) {
    const normal = rotate(0, 1, heading);
    return {
      x: add(vertex.x, scale(offset, normal.x)),
      y: add(vertex.y, scale(offset, normal.y)),
    };
  }
  const coef = miterCoefficient(turn);
  const world = rotate(coef.cx, coef.cy, heading);
  return {
    x: add(vertex.x, scale(offset, world.x)),
    y: add(vertex.y, scale(offset, world.y)),
  };
}

function buildLegs(
  straights: { length: Numeric; turn: number }[],
  start: { x: Numeric; y: Numeric },
): Leg[] {
  const legs: Leg[] = [];
  let heading = 0;
  let cursor = { x: expr(start.x), y: expr(start.y) };

  straights.forEach((segment, index) => {
    heading += segment.turn;
    const direction = rotate(1, 0, heading);
    const end = {
      x: add(cursor.x, scale(segment.length, direction.x)),
      y: add(cursor.y, scale(segment.length, direction.y)),
    };
    legs.push({
      index,
      length: segment.length,
      heading,
      start: cursor,
      end,
      turnIn: segment.turn,
      turnOut: index + 1 < straights.length ? straights[index + 1].turn : 0,
    });
    cursor = end;
  });

  return legs;
}

function bandPolygon(leg: Leg, offsets: [Numeric, Numeric]): [Numeric, Numeric][] {
  const startFrame = leg.heading - leg.turnIn;
  const start0 = bandPoint(leg.start, startFrame, leg.turnIn, offsets[0]);
  const start1 = bandPoint(leg.start, startFrame, leg.turnIn, offsets[1]);
  const end0 = bandPoint(leg.end, leg.heading, leg.turnOut, offsets[0]);
  const end1 = bandPoint(leg.end, leg.heading, leg.turnOut, offsets[1]);
  return [
    [start0.x, start0.y],
    [start1.x, start1.y],
    [end1.x, end1.y],
    [end0.x, end0.y],
  ];
}

function entryPart(
  macro: string,
  suffix: string,
  name: string,
  material: string | undefined,
  points: [Numeric, Numeric][],
  from: Numeric | string,
  to: Numeric | string,
): FamilyPart {
  const part: FamilyPart = {
    id: `${macro}-${suffix}`,
    name,
    solid: { kind: "prism", plane: "xy", points, from, to },
    cuts: [],
    from: macro,
  };
  if (material) part.material = material;
  return part;
}

function expandTrayRun(
  macro: TrayRunMacro,
  index: number,
  issues: Issue[],
): { parts: FamilyPart[]; connectors: MepConnector[]; macroId: string } {
  const path = `macros[${index}]`;
  const id = macroId(macro, index);

  const width = numeric(macro.width);
  const height = numeric(macro.height);
  const thickness = numeric(macro.thickness);
  const flange = numeric(macro.flange ?? 0);
  const lid = macro.lid === true;
  let ok = true;

  if (width === null) {
    issues.push({ severity: "error", path: `${path}.width`, message: "width is required" });
    ok = false;
  }
  if (height === null) {
    issues.push({ severity: "error", path: `${path}.height`, message: "height is required" });
    ok = false;
  }
  if (thickness === null) {
    issues.push({ severity: "error", path: `${path}.thickness`, message: "thickness is required" });
    ok = false;
  }
  if (flange === null) {
    issues.push({
      severity: "error",
      path: `${path}.flange`,
      message: "flange must be a number or formula",
    });
    ok = false;
  }

  const parsed = readSegments(macro.segments, `${path}.segments`, issues);
  if (!parsed) ok = false;
  if (
    !ok ||
    width === null ||
    height === null ||
    thickness === null ||
    flange === null ||
    !parsed
  ) {
    return { parts: [], connectors: [], macroId: id };
  }

  const startRaw: JsonRecord = isRecord(macro.start) ? macro.start : {};
  const start = {
    x: numeric(startRaw.x) ?? 0,
    y: numeric(startRaw.y) ?? 0,
    z: numeric(startRaw.z) ?? 0,
  };

  const legs = buildLegs(parsed.straights, start);

  const widthHalf: Numeric = scale(width, 0.5) ?? 0;
  const halfNegative: Numeric = scale(width, -0.5) ?? 0;
  const thicknessExpr = expr(thickness);
  const wallLeftOuter: Numeric = add(widthHalf, thicknessExpr);
  const wallRightOuter: Numeric = add(halfNegative, scale(thickness, -1) ?? 0);
  const flangeInner: Numeric = add(widthHalf, scale(flange, -1) ?? 0);
  const flangeRightOuter: Numeric = add(halfNegative, flange);

  const z0 = start.z;
  const zBottom = add(z0, expr(thickness));
  const zTop = add(z0, expr(height));
  const zFlangeBottom = add(zTop, scale(thickness, -1) ?? 0);
  const zLidTop = add(zTop, expr(thickness));

  const parts: FamilyPart[] = [];
  const material = text(macro.material) || undefined;
  legs.forEach((leg) => {
    const n = leg.index + 1;
    parts.push(
      entryPart(
        id,
        `bottom-${n}`,
        `Bottom Leg ${n}`,
        material,
        bandPolygon(leg, [scale(width, -0.5) ?? 0, widthHalf]),
        z0,
        zBottom,
      ),
      entryPart(
        id,
        `side-wall-left-${n}`,
        `Side Wall Left ${n}`,
        material,
        bandPolygon(leg, [widthHalf, wallLeftOuter]),
        z0,
        zTop,
      ),
      entryPart(
        id,
        `side-wall-right-${n}`,
        `Side Wall Right ${n}`,
        material,
        bandPolygon(leg, [wallRightOuter, halfNegative]),
        z0,
        zTop,
      ),
    );

    if (flange !== 0 && flange !== "0") {
      parts.push(
        entryPart(
          id,
          `top-flange-left-${n}`,
          `Top Flange Left ${n}`,
          material,
          bandPolygon(leg, [flangeInner, widthHalf]),
          zFlangeBottom,
          zTop,
        ),
        entryPart(
          id,
          `top-flange-right-${n}`,
          `Top Flange Right ${n}`,
          material,
          bandPolygon(leg, [halfNegative, flangeRightOuter]),
          zFlangeBottom,
          zTop,
        ),
      );
    }

    if (lid) {
      parts.push(
        entryPart(
          id,
          `lid-${n}`,
          `Lid ${n}`,
          material,
          bandPolygon(leg, [halfNegative, widthHalf]),
          zTop,
          zLidTop,
        ),
      );
    }
  });

  const connectors: MepConnector[] = [];
  if (macro.connectors !== false && legs.length > 0) {
    const first = legs[0];
    const last = legs[legs.length - 1];
    const inDir = rotate(-1, 0, first.heading);
    const outDir = rotate(1, 0, last.heading);
    const zMid = add(z0, scale(height, 0.5) ?? 0);
    const connector = (
      suffix: string,
      name: string,
      origin: { x: string; y: string },
      direction: { x: number; y: number },
    ): MepConnector => ({
      id: `${id}-${suffix}`,
      name,
      systemType: "CableTray",
      shape: "rectangular",
      direction: suffix === "in" ? "in" : "out",
      host: "reference-plane",
      origin: { x: origin.x, y: origin.y, z: zMid },
      directionVector: { x: direction.x, y: direction.y, z: 0 },
      width,
      height,
    });

    connectors.push(
      connector("in", "Connector In", first.start, inDir),
      connector("out", "Connector Out", last.end, outDir),
    );
  }

  return { parts, connectors, macroId: id };
}

export interface MacroExpansion {
  spec: unknown;
  issues: Issue[];
  /** Generated part id -> macro path; used to report downstream errors on the macro. */
  generated: Map<string, string>;
}

/**
 * Replace every macro with ordinary parts. Existing macro-generated parts are
 * dropped first (they carry `from`), so the expansion is idempotent and a macro
 * edit always regenerates current geometry.
 */
export function expandMacros(raw: unknown): MacroExpansion {
  const issues: Issue[] = [];
  const generated = new Map<string, string>();
  if (!isRecord(raw)) return { spec: raw, issues, generated };

  const rawMacros = Array.isArray(raw.macros) ? raw.macros : [];
  if (!Array.isArray(raw.macros) && raw.macros !== undefined) {
    issues.push({ severity: "error", path: "macros", message: "macros must be an array" });
    return { spec: raw, issues, generated };
  }

  const keptParts = Array.isArray(raw.parts)
    ? raw.parts.filter((part) => !(isRecord(part) && typeof part.from === "string"))
    : [];
  const keptConnectors = Array.isArray(raw.connectors)
    ? raw.connectors.filter(
        (connector) => !(isRecord(connector) && typeof connector.from === "string"),
      )
    : [];

  if (rawMacros.length === 0) {
    const partsChanged = Array.isArray(raw.parts) && keptParts.length !== raw.parts.length;
    const connectorsChanged =
      Array.isArray(raw.connectors) && keptConnectors.length !== raw.connectors.length;
    if (!partsChanged && !connectorsChanged) return { spec: raw, issues, generated };
    return {
      spec: {
        ...raw,
        ...(partsChanged ? { parts: keptParts } : {}),
        ...(connectorsChanged ? { connectors: keptConnectors } : {}),
      },
      issues,
      generated,
    };
  }

  const macroIds = new Set<string>();
  const generatedParts: FamilyPart[] = [];
  const generatedConnectors: unknown[] = [];

  rawMacros.forEach((entry, index) => {
    const path = `macros[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ severity: "error", path, message: "macro must be an object" });
      return;
    }
    const kind = text(entry.kind);
    if (kind !== "trayRun") {
      issues.push({
        severity: "error",
        path: `${path}.kind`,
        message: `unknown macro kind "${kind}"; use trayRun`,
      });
      return;
    }

    const macro = entry as unknown as TrayRunMacro;
    const id = macroId(macro, index);
    if (macroIds.has(id)) {
      issues.push({
        severity: "error",
        path: `${path}.id`,
        message: `duplicate macro id "${id}"`,
      });
      return;
    }
    macroIds.add(id);

    const expanded = expandTrayRun(macro, index, issues);
    for (const part of expanded.parts) {
      generated.set(part.id, path);
      if (keptParts.some((candidate) => isRecord(candidate) && candidate.id === part.id)) {
        issues.push({
          severity: "warning",
          path: `${path}.id`,
          message: `generated part "${part.id}" replaces an explicit part with the same id`,
        });
      }
      generatedParts.push(part);
    }
    for (const connector of expanded.connectors) {
      generatedConnectors.push({ ...connector, from: id });
    }
  });

  const spec = {
    ...raw,
    parts: [...keptParts, ...generatedParts],
    ...(generatedConnectors.length > 0 || Array.isArray(raw.connectors)
      ? { connectors: [...keptConnectors, ...generatedConnectors] }
      : {}),
  };
  return { spec, issues, generated };
}

/** A copy of the spec without macro-only fields; used by schema/UI helpers. */
export function macroList(raw: unknown): SpecMacro[] {
  if (!isRecord(raw) || !Array.isArray(raw.macros)) return [];
  return raw.macros.filter(isRecord) as unknown as SpecMacro[];
}
