const NUMERIC_TYPES = new Set(["Length", "Angle", "Number", "Integer"]);
const VERBS = "(?:đổi|thay\\s+đổi|chỉnh|sửa|set|change|update|adjust)";
const OPERATORS = "(?:thành|thàn|sang|về|to|=|:)";
const UNITS = "(mm|cm|m|deg|°)";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}

function parseNumber(text) {
  const normalized = /^\d{1,3}([.,]\d{3})+$/.test(text)
    ? text.replace(/[.,]/g, "")
    : text.includes(",") && !text.includes(".")
      ? text.replace(",", ".")
      : text.replace(/,/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function convertValue(value, unit, type) {
  if (type === "Angle") {
    if (unit && unit.toLowerCase() !== "deg" && unit !== "°") return null;
    return value;
  }
  if (type === "Number" || type === "Integer") {
    return unit ? null : value;
  }
  if (!unit || unit.toLowerCase() === "mm") return value;
  if (unit.toLowerCase() === "cm") return value * 10;
  if (unit.toLowerCase() === "m") return value * 1000;
  return null;
}

/**
 * Parses a single, explicit parameter edit such as
 * "đổi Rack Length thành 2000 mm". Returns null for anything ambiguous:
 * multiple matches, formula-driven parameters, or a non-numeric type.
 */
export function parseFastParameterEdit(prompt, spec) {
  if (!prompt || !spec || !Array.isArray(spec.parameters)) return null;
  if (spec.units && spec.units !== "mm") return null;

  const text = String(prompt);
  const lower = text.toLowerCase();
  const mentioned = spec.parameters.filter(
    (param) => param && typeof param.name === "string" && lower.includes(param.name.toLowerCase()),
  );
  // Multiple names can mean a multi-parameter or explanatory request; let the agent
  // handle that rather than guessing which one the user wants to overwrite.
  if (mentioned.length > 1) return null;

  const matches = [];
  let blocked = false;

  for (const param of spec.parameters) {
    if (!param || typeof param.name !== "string") continue;

    const name = escapeRegExp(param.name.trim());
    const pattern = new RegExp(
      `(?:^|[\\s,;])${VERBS}\\s+(?:tham\\s+số\\s+)?${name}\\s*${OPERATORS}\\s*(-?\\d+(?:[.,]\\d+)?)\\s*${UNITS}?`,
      "iu",
    );
    const match = text.match(pattern);
    if (!match) continue;

    // A formula parameter or a non-numeric type cannot be safely overwritten:
    // ask the agent instead of silently dropping the formula.
    if (param.formula || !NUMERIC_TYPES.has(param.type)) {
      blocked = true;
      continue;
    }

    const raw = parseNumber(match[1]);
    const value = raw === null ? null : convertValue(raw, match[2], param.type);
    if (value === null) {
      blocked = true;
      continue;
    }

    matches.push({
      name: param.name,
      type: param.type,
      value: param.type === "Integer" ? Math.round(value) : value,
    });
  }

  if (blocked) return null;
  return matches.length === 1 ? matches[0] : null;
}

/** Returns a new spec with the edit applied, or null when the target is invalid. */
export function applyFastParameterEdit(spec, edit) {
  if (!spec || !edit?.name) return null;

  const next = JSON.parse(JSON.stringify(spec));
  const param = next.parameters?.find(
    (item) => item.name && item.name.toLowerCase() === edit.name.toLowerCase(),
  );
  if (!param || param.formula || !NUMERIC_TYPES.has(param.type)) return null;

  param.value = edit.value;
  delete param.formula;
  const suffix = edit.type === "Angle" ? "°" : edit.type === "Length" ? " mm" : "";
  next.notes = Array.isArray(next.notes) ? [...next.notes] : [];
  next.notes.push(
    `Đã đổi ${edit.name} thành ${edit.value}${suffix}; các tham số phụ thuộc tự cập nhật theo formula.`,
  );
  return next;
}

export { NUMERIC_TYPES };
