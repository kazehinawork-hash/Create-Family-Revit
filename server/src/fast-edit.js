const NUMERIC_TYPES = new Set(["Length", "Angle", "Number", "Integer"]);
const VERBS = "(?:đổi|thay\\s+đổi|chỉnh|sửa|set|change|update|adjust)";
const OPERATORS = "(?:thành|thàn|sang|về|to|=|:)";
const UNITS = "(mm|cm|m|deg|°)";

// Color map for Vietnamese and common English color names
const COLOR_MAP = {
  đỏ: "#ff2222",
  red: "#ff2222",
  xanh: "#2288ff",
  "xanh dương": "#2288ff",
  blue: "#2288ff",
  "xanh lá": "#22aa44",
  green: "#22aa44",
  vàng: "#ffcc00",
  yellow: "#ffcc00",
  cam: "#ff8800",
  orange: "#ff8800",
  trắng: "#f8f8f8",
  white: "#f8f8f8",
  đen: "#1a1a1a",
  black: "#1a1a1a",
  xám: "#888888",
  gray: "#888888",
  grey: "#888888",
};

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
 * Checks for color edit request:
 * e.g. "đổi màu thân máy thành đỏ" or "đổi màu Steel thành #333333"
 */
function parseColorEdit(text, spec) {
  const colorPattern = new RegExp(
    `(?:đổi|thay\\s+đổi|sửa|set|change)\\s+màu(?:\\s+của)?\\s+(?:vật\\s+liệu\\s+|part\\s+)?([\\w\\s-]+?)\\s*(?:thành|to|=|:)\\s*(#[0-9a-fA-F]{3,6}|[a-zA-Zà-ỹÀ-Ỹ\\s]+)$`,
    "iu",
  );
  const match = text.trim().match(colorPattern);
  if (!match) return null;

  const targetName = match[1].trim().toLowerCase();
  const rawColor = match[2].trim().toLowerCase();
  const hexColor = /^#[0-9a-fA-F]{3,6}$/.test(rawColor) ? rawColor : COLOR_MAP[rawColor];
  if (!hexColor) return null;

  // Check if target is a material
  const mat = spec.materials?.find(
    (m) => m && m.name && m.name.toLowerCase() === targetName,
  );
  if (mat) {
    return { kind: "material-color", name: mat.name, color: hexColor };
  }

  // Check if target is a part
  const part = spec.parts?.find(
    (p) => p && p.name && p.name.toLowerCase() === targetName,
  );
  if (part) {
    return { kind: "part-color", name: part.name, partId: part.id, material: part.material, color: hexColor };
  }

  return null;
}

/**
 * Parses single or multi-parameter edit requests, including relative adjustments (tăng/giảm).
 * Returns an array of edits or a single edit object with changes.
 */
export function parseFastParameterEdit(prompt, spec) {
  if (!prompt || !spec || !Array.isArray(spec.parameters)) return null;
  if (spec.units && spec.units !== "mm") return null;

  const text = String(prompt).trim();

  // 1. Color edit check
  const colorEdit = parseColorEdit(text, spec);
  if (colorEdit) return colorEdit;

  // 2. Relative delta adjustment (e.g. "tăng Rack Length thêm 100mm", "giảm Rack Length 50")
  const deltaPattern = new RegExp(
    `(?:^|[\\s,;])(tăng|giảm|increase|decrease)\\s+(?:tham\\s+số\\s+)?([\\w\\s-]+?)(?:\\s+thêm|\\s+bớt|\\s+by)?\\s*(-?\\d+(?:[.,]\\d+)?)\\s*${UNITS}?`,
    "iu",
  );
  const deltaMatch = text.match(deltaPattern);
  if (deltaMatch) {
    const isDecrease = deltaMatch[1].toLowerCase() === "giảm" || deltaMatch[1].toLowerCase() === "decrease";
    const targetName = deltaMatch[2].trim().toLowerCase();
    const rawVal = parseNumber(deltaMatch[3]);
    const unit = deltaMatch[4];
    const param = spec.parameters.find(
      (p) => p && p.name && p.name.toLowerCase() === targetName,
    );
    if (param && !param.formula && NUMERIC_TYPES.has(param.type) && typeof param.value === "number") {
      const delta = convertValue(rawVal, unit, param.type);
      if (delta !== null) {
        const newValue = isDecrease ? param.value - Math.abs(delta) : param.value + Math.abs(delta);
        return {
          name: param.name,
          type: param.type,
          value: param.type === "Integer" ? Math.round(newValue) : newValue,
          changes: [{
            name: param.name,
            type: param.type,
            value: param.type === "Integer" ? Math.round(newValue) : newValue,
          }],
        };
      }
    }
  }

  // 3. Multi-clause parsing: split text by comma or "và" / "and"
  const clauses = text.split(/,|\bvà\b|\band\b/i).map((c) => c.trim()).filter(Boolean);

  const matchedEdits = [];
  let blocked = false;

  for (const clause of clauses) {
    for (const param of spec.parameters) {
      if (!param || typeof param.name !== "string") continue;

      const name = escapeRegExp(param.name.trim());
      const pattern = new RegExp(
        `(?:^|[\\s,;])${VERBS}\\s+(?:tham\\s+số\\s+)?${name}\\s*${OPERATORS}\\s*(-?\\d+(?:[.,]\\d+)?)\\s*${UNITS}?`,
        "iu",
      );
      const match = clause.match(pattern);
      if (!match) continue;

      // If this parameter is formula-driven or not numeric, block immediately
      if (param.formula || !NUMERIC_TYPES.has(param.type)) {
        blocked = true;
        break;
      }

      const raw = parseNumber(match[1]);
      const value = raw === null ? null : convertValue(raw, match[2], param.type);
      if (value === null) {
        blocked = true;
        break;
      }

      matchedEdits.push({
        name: param.name,
        type: param.type,
        value: param.type === "Integer" ? Math.round(value) : value,
      });
      break;
    }
    if (blocked) return null;

    // Check if the clause mentions another parameter with formula that wasn't matched as a valid numeric edit
    for (const param of spec.parameters) {
      if (!param || typeof param.name !== "string") continue;
      if (clause.toLowerCase().includes(param.name.toLowerCase()) && (param.formula || !NUMERIC_TYPES.has(param.type))) {
        return null;
      }
    }
  }

  if (blocked || matchedEdits.length === 0) return null;

  // If there is only 1 edit, return exact object for backwards-compatibility without extra keys
  if (matchedEdits.length === 1) {
    return matchedEdits[0];
  }

  const primary = matchedEdits[0];
  return {
    ...primary,
    changes: matchedEdits,
  };
}

/** Returns a new spec with the edit applied, or null when the target is invalid. */
export function applyFastParameterEdit(spec, edit) {
  if (!spec || !edit) return null;

  const next = JSON.parse(JSON.stringify(spec));
  next.notes = Array.isArray(next.notes) ? [...next.notes] : [];

  // Handle color edits
  if (edit.kind === "material-color") {
    const mat = next.materials?.find(
      (m) => m && m.name && m.name.toLowerCase() === edit.name.toLowerCase(),
    );
    if (!mat) return null;
    mat.color = edit.color;
    next.notes.push(`Đã đổi màu vật liệu ${edit.name} thành ${edit.color}.`);
    return next;
  }

  if (edit.kind === "part-color") {
    // If the part already has a dedicated material, update its color
    let mat = next.materials?.find(
      (m) => m && m.name && m.name.toLowerCase() === (edit.material || "").toLowerCase(),
    );
    if (mat) {
      mat.color = edit.color;
    } else {
      // Create new material for this part
      const newMatName = `${edit.name} Material`;
      next.materials = next.materials || [];
      next.materials.push({ name: newMatName, color: edit.color, metalness: 0.5, roughness: 0.5 });
      const part = next.parts?.find((p) => p && p.id === edit.partId);
      if (part) part.material = newMatName;
    }
    next.notes.push(`Đã đổi màu part ${edit.name} thành ${edit.color}.`);
    return next;
  }

  // Handle parameter edits
  const changes = Array.isArray(edit.changes) && edit.changes.length > 0 ? edit.changes : [edit];

  for (const item of changes) {
    if (!item.name) continue;
    const param = next.parameters?.find(
      (p) => p.name && p.name.toLowerCase() === item.name.toLowerCase(),
    );
    if (!param || param.formula || !NUMERIC_TYPES.has(param.type)) return null;

    param.value = item.value;
    delete param.formula;
    const suffix = item.type === "Angle" ? "°" : item.type === "Length" ? " mm" : "";
    next.notes.push(
      `Đã đổi ${item.name} thành ${item.value}${suffix}; các tham số phụ thuộc tự cập nhật theo formula.`,
    );
  }

  return next;
}

export { NUMERIC_TYPES };
