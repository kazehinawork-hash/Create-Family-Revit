import { matchTemplateFamily } from "./templates/cable-ladder.js";

/**
 * Requirement checklist: what the user asked for, extracted before the model runs,
 * then verified against the spec the model produced.
 */

const ROLE_SUFFIX =
  /\b(web|flange|lip|top|bottom|outer|inner|plate|panel|side|back|front|left|right|centre|center|no\.?\s*\d+)\b/gi;

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "Corner Rail East North Web" -> "corner rail east north" */
export function partUnitKey(part) {
  const base = normalize(`${part.name ?? ""} ${part.id ?? ""}`);
  return base.replace(ROLE_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

const GROUP_MATCHERS = {
  // "web" alone is too generic: a rung has a web too, so rungs are excluded below.
  // "Thành …" is the side rail of a tray: the model names them "Thành cổ trục X" or
  // "Thành vát 45°", neither of which contains the word "góc".
  corner: /(corner|thanh goc|thanh dung|rail|side wall|vertical wall|^thanh )/,
  // Bare "bac" would match "Bắc" (north) in part names; a rung is "bậc thang".
  rung: /(rung|bac thang)/,
  connector: /(connector|cong|dau noi|port)/,
};

const GROUP_EXCLUDES = {
  corner: /(rung|bac thang)/,
};

const ALIASES = {
  w1: "Ladder Width 1",
  w2: "Ladder Width 2",
  h: "Ladder Height",
  width1: "Ladder Width 1",
  width2: "Ladder Width 2",
  height: "Ladder Height",
  tangent: "Tangent Length",
  tangentlength: "Tangent Length",
  miter: "Miter Offset",
  miteroffset: "Miter Offset",
  thickness: "Sheet Thickness",
  sheetthickness: "Sheet Thickness",
};

const FAMILY_DEFAULTS = {
  cross: { corners: 4, connectors: 4 },
  tee: { corners: 2, connectors: 3 },
  elbow: { corners: 2, connectors: 2 },
};

/** Coordinates and 0-valued constraints are not parameters. */
const COORDINATE_NAMES = new Set(["x", "y", "z", "x1", "x2", "y1", "y2", "z1", "z2"]);

/** Title Case identifiers ("Ladder Width 1") or snake_case ones ("Miter_Offset"). */
const PARAMETER_NAME =
  /^(?:[A-Z][A-Za-z0-9]*(?:\s+(?:[A-Z][A-Za-z0-9]*|\d+))*|[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)$/;

function canonicalParameterName(rawName) {
  const raw = String(rawName ?? "").replace(/[`"]/g, "").trim();
  if (!raw) return null;

  const key = normalize(raw).replace(/[\s_-]+/g, "");
  if (ALIASES[key]) return ALIASES[key];
  if (COORDINATE_NAMES.has(key)) return null;
  if (!PARAMETER_NAME.test(raw)) return null;

  return raw.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Only real parameters are collected:
 *  - "`Ladder_Width_1` … Mặc định `400 mm`"
 *  - "Ladder Width 1 = 400 mm" / "W1 = 400"
 * Zero values, coordinates (X/Y/Z/Z1...), formulas and prose are ignored.
 */
function collectParameters(text) {
  const found = [];

  const add = (rawName, rawValue) => {
    const name = canonicalParameterName(rawName);
    const value = Number(String(rawValue ?? "").replace(",", "."));
    if (!name || !Number.isFinite(value) || value <= 0) return;
    if (found.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) return;
    found.push({ name, value });
  };

  for (const match of text.matchAll(
    /`([^`\n]{2,40})`[^\n`]{0,40}?mặc\s*định\s*`?\s*(-?\d+(?:[.,]\d+)?)\s*(?:mm|cm|deg|°)?/gi,
  )) {
    add(match[1], match[2]);
  }

  for (const match of text.matchAll(
    // No letter/digit/operator before the name (so "…× Miter_Offset = 940" and the
    // tail "iter_Offset" are not read as parameters), optional closing backtick.
    /(?<![×*/+A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*(?:[ \t]+[A-Za-z0-9][A-Za-z0-9_]*){0,3})[`"]?[ \t]*[=:][ \t]*(-?\d+(?:[.,]\d+)?)\s*(mm|cm|deg|°)?/g,
  )) {
    add(match[1], match[2]);
  }

  return found;
}

/**
 * Heuristic extraction (no model call): counts, parameters and material needs.
 * A cheap model pass can refine it when the prompt is long and the heuristic is thin.
 */
export function extractChecklistHeuristic(prompt) {
  const text = String(prompt ?? "");
  const normalized = normalize(text);
  const family = matchTemplateFamily(text);
  const defaults = FAMILY_DEFAULTS[family] ?? { corners: 0, connectors: 0 };

  const readCount = (patterns) => {
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value > 0) return value;
      }
    }
    return null;
  };

  // Connectors first: "4 connector" must not be read as "4 walls".
  const connectors = readCount([
    /(\d+)\s*(?:connector|cong|dau noi|port)/,
  ]);
  const rungs = readCount([/(\d+)\s*(?:bac|rung)/]);
  const corners = readCount([
    /(\d+)\s*(?:cum\s+)?(?:thanh goc|thanh dung|corner|rail)/,
  ]);

  const groups = [];
  if (corners ?? defaults.corners) {
    groups.push({
      role: "corner",
      label: `${corners ?? defaults.corners} thành góc vát`,
      expected: corners ?? defaults.corners,
      matcher: GROUP_MATCHERS.corner,
    });
  }
  if (rungs) {
    groups.push({
      role: "rung",
      label: `${rungs} bậc thang`,
      expected: rungs,
      matcher: GROUP_MATCHERS.rung,
    });
  }

  // "W1=400, H=100, Tangent=120, Miter_Offset=150" / "`Ten` … Mặc định `400 mm`"
  const parameters = collectParameters(text);

  const requiresMaterials = /(vat lieu|material|mau|ral\s*\d|son)/i.test(text);

  return {
    family,
    category: family === "cross" || family === "tee" || family === "elbow" ? "Electrical Equipment" : null,
    groups,
    connectors: connectors ?? defaults.connectors,
    parameters,
    requiresMaterials,
    complex: isComplexPrompt(text, groups),
    source: "heuristic",
  };
}

/** Complex geometry (mitres, C sections, sweeps) needs a stronger model than flash. */
export function isComplexPrompt(prompt, groups = []) {
  const text = normalize(prompt);
  const complexShape =
    /(miter|vat|45|chu c|c section|sweep|da giac|polygon|xoan|helix|nga tu|nga ba|cross|tee)/.test(text);
  const partCount = groups.reduce((total, group) => total + (group.expected ?? 0), 0);
  return complexShape || partCount >= 12 || String(prompt ?? "").length > 1200;
}

/** Optional refinement with one cheap model call; never blocks the run on failure. */
export async function refineChecklistWithModel(prompt, base, { generate, model } = {}) {
  if (!generate) return base;

  try {
    const result = await generate(
      [
        {
          role: "system",
          content:
            "You extract build requirements. Reply with ONE JSON object only: " +
            '{"family":"cross|tee|elbow|null","groups":[{"role":"corner|rung|connector","count":N}],' +
            '"connectors":N,"parameters":[{"name":"...","value":123}],"requiresMaterials":true}',
        },
        { role: "user", content: String(prompt).slice(0, 6000) },
      ],
      { model, timeoutMs: 45000 },
    );

    const json = typeof result?.json === "object" ? result.json : null;
    if (!json) return base;

    const groups = Array.isArray(json.groups)
      ? json.groups
          .filter((group) => group && GROUP_MATCHERS[group.role] && Number(group.count) > 0)
          .map((group) => ({
            role: group.role,
            expected: Number(group.count),
            label: `${Number(group.count)} ${group.role}`,
            matcher: GROUP_MATCHERS[group.role],
          }))
      : base.groups;

    return {
      ...base,
      family: json.family && json.family !== "null" ? json.family : base.family,
      groups: groups.length > 0 ? groups : base.groups,
      connectors: Number.isFinite(Number(json.connectors)) ? Number(json.connectors) : base.connectors,
      parameters: Array.isArray(json.parameters) && json.parameters.length > 0 ? json.parameters : base.parameters,
      requiresMaterials: Boolean(json.requiresMaterials ?? base.requiresMaterials),
      source: "model",
    };
  } catch (error) {
    console.warn("[design] checklist refinement skipped:", error?.message);
    return base;
  }
}

export async function extractChecklist(prompt, options = {}) {
  const base = extractChecklistHeuristic(prompt);
  const thin = base.groups.length < 2 || base.parameters.length === 0;
  if (!thin || !options.generate) return base;
  if (String(prompt ?? "").length < 400) return base;

  return refineChecklistWithModel(prompt, base, options);
}

function countUnits(parts, matcher, exclude) {
  const units = new Set();
  for (const part of parts) {
    const text = normalize(`${part.name ?? ""} ${part.id ?? ""}`);
    if (!matcher.test(text)) continue;
    if (exclude && exclude.test(text)) continue;
    units.add(partUnitKey(part) || part.id || part.name);
  }
  return units.size;
}

/**
 * Compare a spec with the checklist. Returns concrete, human-readable gaps.
 */
export function checkCompleteness(spec, checklist, { minHeightRatio = 0.5, bounds = null } = {}) {
  const missing = [];
  const parts = (spec?.parts ?? []).filter((part) => part && !part.instanceOf);
  const connectors = spec?.connectors ?? [];

  const summary = {
    partUnits: {},
    connectors: connectors.length,
    parametersMissing: [],
    materialsMissing: 0,
    height: null,
  };

  for (const group of checklist?.groups ?? []) {
    if (group.forCompleteness === false) continue;
    const actual = countUnits(parts, group.matcher, group.exclude ?? GROUP_EXCLUDES[group.role]);
    summary.partUnits[group.role] = actual;
    if (actual < group.expected) {
      missing.push({
        kind: "parts",
        role: group.role,
        label: group.label ?? `${group.expected} ${group.role}`,
        expected: group.expected,
        actual,
        message: `Thiếu ${group.expected - actual} ${group.role === "corner" ? "thành góc" : group.role === "rung" ? "bậc thang" : group.role}`,
      });
    }
  }

  const expectedConnectors = Number(checklist?.connectors ?? 0);
  if (expectedConnectors > connectors.length) {
    missing.push({
      kind: "connectors",
      label: `${expectedConnectors} connector`,
      expected: expectedConnectors,
      actual: connectors.length,
      message: `Thiếu ${expectedConnectors - connectors.length} connector`,
    });
  }

  for (const parameter of checklist?.parameters ?? []) {
    const name = normalize(parameter.name);
    const found = (spec?.parameters ?? []).some((entry) => normalize(entry.name) === name);
    // A missing parameter is not an incomplete model: the designer inserts the
    // user's value into the spec (fillMissingParameters) instead of failing it.
    if (!found) summary.parametersMissing.push(parameter.name);
  }

  if (checklist?.requiresMaterials) {
    const materialNames = new Set((spec?.materials ?? []).map((material) => material.name));
    if (materialNames.size === 0) {
      missing.push({ kind: "materials", label: "vật liệu", message: "Chưa có vật liệu nào" });
    }
    const unassigned = parts.filter((part) => !part.material || !materialNames.has(part.material));
    if (unassigned.length > 0) {
      summary.materialsMissing = unassigned.length;
      missing.push({
        kind: "materials",
        label: "gán vật liệu",
        expected: parts.length,
        actual: parts.length - unassigned.length,
        message: `${unassigned.length} part chưa được gán vật liệu`,
      });
    }
  }

  // Walls that never rise above rung height mean the vertical walls are missing.
  const needsHeight = (checklist?.groups ?? []).some((group) => group.role === "corner");
  const size = bounds ?? (spec ? safeBounds(spec) : null);
  if (needsHeight && size) {
    summary.height = size.z;
    const width = Math.max(size.x, size.y);
    if (size.z > 0 && size.z < width * minHeightRatio && size.z < 40) {
      missing.push({
        kind: "bounds",
        label: "thành đứng",
        message: `Chiều cao model chỉ ${Math.round(size.z)} mm — thiếu thành đứng`,
      });
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    summary,
  };
}

function safeBounds(spec) {
  try {
    const geometry = spec?.parts?.[0]?.solid;
    if (!geometry) return null;

    // Cheap bounds from numeric parts only; the full analysis is done elsewhere.
    let min = { x: Infinity, y: Infinity, z: Infinity };
    let max = { x: -Infinity, y: -Infinity, z: -Infinity };
    const add = (x, y, z) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      min = { x: Math.min(min.x, x), y: Math.min(min.y, y), z: Math.min(min.z, z) };
      max = { x: Math.max(max.x, x), y: Math.max(max.y, y), z: Math.max(max.z, z) };
    };

    for (const part of spec.parts ?? []) {
      const solid = part?.solid;
      if (!solid) continue;
      if (solid.kind === "box" && solid.origin && solid.size) {
        const o = solid.origin;
        const s = solid.size;
        const nums = [o.x, o.y, o.z, s.x, s.y, s.z].map(Number);
        if (nums.some((value) => !Number.isFinite(value))) continue;
        add(o.x - s.x / 2, o.y - s.y / 2, o.z - s.z / 2);
        add(o.x + s.x / 2, o.y + s.y / 2, o.z + s.z / 2);
      }
    }

    if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) return null;
    return { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  } catch {
    return null;
  }
}

/** Prompt for a supplemental turn: only the missing items, keep everything else. */
export function buildSupplementPrompt(missing, originalRequest) {
  const lines = missing.map((item) => `- ${item.label}: ${item.message ?? "còn thiếu"}`);
  return (
    "The current spec is missing required items. Add ONLY these, keep every existing part,\n" +
    "parameter and connector unchanged:\n" +
    `${lines.join("\n")}\n\n` +
    `Original request (for reference): ${String(originalRequest).slice(0, 1200)}`
  );
}
