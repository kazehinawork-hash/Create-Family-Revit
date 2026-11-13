const NUMERIC_TYPES = new Set(["Length", "Angle", "Number", "Integer"]);

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

/** Lowercase, no diacritics, single spaces: "Ladder Width 1" -> "ladder width 1". */
export function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[_\-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

/** Accepts mm, cm, m, inch and the " symbol. */
function convertValue(value, unit, type) {
  const normalized = String(unit ?? "").toLowerCase().replace(/\.$/, "");

  if (type === "Angle") {
    if (!normalized) return value;
    return ["deg", "°", "do", "độ"].includes(normalized) ? value : null;
  }
  if (type === "Number" || type === "Integer") return normalized ? null : value;

  if (!normalized || normalized === "mm") return value;
  if (normalized === "cm") return value * 10;
  if (normalized === "m") return value * 1000;
  if (normalized === "inch" || normalized === "in" || normalized === '"') return value * 25.4;
  return null;
}

const UNIT = '(mm|cm|m|inch|in|")';
const SET_VERB = "(?:đổi|thay\\s+đổi|chỉnh|sửa|đặt|gán|set|change|update|adjust|make)";
const UP_VERB = "(?:tăng|cộng\\s+thêm|cộng|nâng|increase|raise|bump|add)";
const DOWN_VERB = "(?:giảm|trừ|bớt|hạ|decrease|reduce|lower|subtract)";
const SET_OP = "(?:thành|sang|về|to|=|:)";

/**
 * Word boundaries written explicitly: JS `\b` is ASCII-only, so a Vietnamese verb
 * ending in "ừ"/"à" would otherwise match in the middle of another word.
 */
const verbPattern = (source) =>
  new RegExp(`(?<=^|[\\s,;:(])${source}(?=\\s|$|[.,;:!?])`, "iu");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** 1 = every token of the name appears in the clause (allow 1-2 typos). */
function nameScore(clauseNorm, nameNorm) {
  const clauseTokens = clauseNorm.split(" ").filter(Boolean);
  const nameTokens = nameNorm.split(" ").filter(Boolean);
  if (nameTokens.length === 0) return 0;

  let matched = 0;
  for (const token of nameTokens) {
    // "Ladder Width 1" and "Ladder Width 2" differ by one character: digits must match exactly.
    if (/^\d+$/.test(token)) {
      if (clauseTokens.includes(token)) matched += 1;
      continue;
    }

    const tolerance = token.length >= 5 ? 2 : 1;
    const hit = clauseTokens.some((candidate) => {
      if (candidate === token) return true;
      if (Math.abs(candidate.length - token.length) > tolerance) return false;
      return levenshtein(candidate, token) <= tolerance;
    });
    if (hit) matched += 1;
  }

  return matched / nameTokens.length;
}

/**
 * Finds the parameter/part/material a clause talks about. Two equally good names mean
 * the request is ambiguous, and guessing would silently edit the wrong dimension.
 */
export function matchTarget(text, candidates, { minScore = 0.8 } = {}) {
  const clauseNorm = normalizeName(text);
  if (!clauseNorm) return { match: null, ambiguous: false };

  const exact = candidates.filter((candidate) => {
    const name = normalizeName(candidate.name);
    return name.length > 0 && (` ${clauseNorm} `).includes(` ${name} `);
  });

  if (exact.length === 1) return { match: exact[0], ambiguous: false };
  if (exact.length > 1) {
    const sorted = [...exact].sort((a, b) => normalizeName(b.name).length - normalizeName(a.name).length);
    const longest = normalizeName(sorted[0].name).length;
    const second = normalizeName(sorted[1].name).length;
    return longest > second
      ? { match: sorted[0], ambiguous: false }
      : { match: null, ambiguous: true };
  }

  const scored = candidates
    .map((candidate) => ({ candidate, score: nameScore(clauseNorm, normalizeName(candidate.name)) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < minScore) return { match: null, ambiguous: false };

  const runnerUp = scored[1];
  if (runnerUp && runnerUp.score >= minScore && best.score - runnerUp.score < 0.05) {
    return { match: null, ambiguous: true };
  }

  return { match: best.candidate, ambiguous: false };
}

function parseColorEdit(text, spec) {
  const pattern = new RegExp(
    `(?:đổi|thay\\s+đổi|sửa|set|change)?\\s*màu(?:\\s+của)?\\s+(?:vật\\s+liệu\\s+|part\\s+)?([\\w\\s-]+?)\\s*(?:thành|to|=|:)\\s*(#[0-9a-fA-F]{3,6}|[a-zA-Zà-ỹÀ-Ỹ\\s]+)$`,
    "iu",
  );
  const match = text.trim().match(pattern);
  if (!match) return null;

  const targetName = match[1].trim();
  const rawColor = match[2].trim().toLowerCase();
  const hexColor = /^#[0-9a-fA-F]{3,6}$/.test(rawColor) ? rawColor : COLOR_MAP[rawColor];
  if (!hexColor) return null;

  const materials = (spec.materials ?? []).filter((material) => material?.name);
  const materialHit = matchTarget(targetName, materials);
  if (materialHit.ambiguous) return null;
  if (materialHit.match) {
    return { kind: "material-color", name: materialHit.match.name, color: hexColor };
  }

  const parts = (spec.parts ?? []).filter((part) => part?.name);
  const partHit = matchTarget(targetName, parts);
  if (partHit.ambiguous) return null;
  if (partHit.match) {
    return {
      kind: "part-color",
      name: partHit.match.name,
      partId: partHit.match.id,
      material: partHit.match.material,
      color: hexColor,
    };
  }

  return null;
}

const RENAME = new RegExp(
  `(?:đổi\\s+tên|đặt\\s+tên|rename)\\s+(.+?)\\s+(?:thành|sang|to|->|→)\\s+(.+)$`,
  "iu",
);

function parseRename(text, spec) {
  const match = text.trim().match(RENAME);
  if (!match) return null;

  const from = match[1].trim().replace(/^(tham\s+số|part|vật\s+liệu|family)\s+/i, "");
  const to = match[2].trim().replace(/^["']|["']$/g, "");
  if (!from || !to || from.length > 80 || to.length > 80) return null;

  const candidates = [
    ...(spec.parameters ?? []).map((param) => ({ ...param, target: "parameter" })),
    ...(spec.parts ?? []).map((part) => ({ ...part, target: "part" })),
    ...(spec.materials ?? []).map((material) => ({ ...material, target: "material" })),
    { name: spec.name, target: "family" },
  ].filter((candidate) => candidate?.name);

  const hit = matchTarget(from, candidates);
  if (hit.ambiguous || !hit.match) return null;
  if (normalizeName(hit.match.name) === normalizeName(to)) return null;

  return {
    kind: "rename",
    target: hit.match.target,
    from: hit.match.name,
    to,
    ...(hit.match.target === "parameter" ? { type: hit.match.type } : {}),
    ...(hit.match.target === "part" ? { partId: hit.match.id } : {}),
  };
}

function parseMaterialAssign(text, spec) {
  const match = text
    .trim()
    .match(
      /(?:gán|đổi|thay|assign|set)\s+vật\s+liệu\s+(?:của\s+)?(?:part\s+)?(.+?)\s+(?:thành|sang|to)\s+(.+)$/iu,
    );
  if (!match) return null;

  const parts = (spec.parts ?? []).filter((part) => part?.name || part?.id);
  const partHit = matchTarget(match[1], parts.map((part) => ({ ...part, name: part.name || part.id })));
  if (partHit.ambiguous || !partHit.match) return null;

  const materials = (spec.materials ?? []).filter((material) => material?.name);
  const materialHit = matchTarget(match[2], materials);
  if (materialHit.ambiguous || !materialHit.match) return null;

  return {
    kind: "material-assign",
    partId: partHit.match.id,
    partName: partHit.match.name,
    material: materialHit.match.name,
  };
}

const NUMBER = "(-?\\d+(?:[.,]\\d+)?)";

function numericTarget(text, spec) {
  const params = (spec.parameters ?? []).filter((param) => param?.name && typeof param.name === "string");
  const hit = matchTarget(text, params);
  if (hit.ambiguous) return { blocked: true };
  if (!hit.match) return { blocked: false, param: null };
  if (hit.match.formula || !NUMERIC_TYPES.has(hit.match.type)) return { blocked: true };
  if (typeof hit.match.value !== "number") return { blocked: true };
  return { blocked: false, param: hit.match };
}

function roundFor(param, value) {
  return param.type === "Integer" ? Math.round(value) : Math.round(value * 1000) / 1000;
}

function parseClause(clause, spec) {
  // 1. percentage: "tăng 10%", "giảm Ladder Height 5 %", "increase by 20 percent"
  const percent = clause.match(
    new RegExp(
      `(tăng|giảm|increase|decrease|reduce)\\s+(?:by\\s+)?(.{0,60}?)${NUMBER}\\s*(?:%|percent|phan\\s+tram)`,
      "iu",
    ),
  );
  if (percent) {
    const { blocked, param } = numericTarget(clause, spec);
    if (blocked || !param) return blocked ? null : undefined;
    const amount = parseNumber(percent[3]);
    if (amount === null) return null;
    const sign = /^(giảm|decrease|reduce)$/i.test(percent[1]) ? -1 : 1;
    const value = param.value * (1 + (sign * amount) / 100);
    return { name: param.name, type: param.type, value: roundFor(param, value) };
  }

  // 2. multiply / halve: "nhân đôi", "gấp đôi", "double", "giảm một nửa", "halve"
  const multiply = clause.match(
    /(nhân\s+đôi|gấp\s+đôi|nhân\s+(?:với\s+)?2|double|x2|×2|nhân\s+ba|triple|x3|×3)/iu,
  );
  const halve = clause.match(/(giảm\s+một\s+nửa|chia\s+đôi|halve|half)/iu);

  if (multiply || halve) {
    const { blocked, param } = numericTarget(clause, spec);
    if (blocked || !param) return blocked ? null : undefined;
    const factor = halve ? 0.5 : /(ba|triple|x3|×3)/i.test(multiply[0]) ? 3 : 2;
    return { name: param.name, type: param.type, value: roundFor(param, param.value * factor) };
  }

  // 3. relative delta: "tăng chiều cao thêm 100mm", "giảm X 50", "add 10 mm to X"
  // Detect the verb on the clause without the parameter name: "Lower Run Length"
  // contains the verb "lower" and would otherwise look like a decrease.
  const deltaTarget = numericTarget(clause, spec);
  const clauseWithoutName = deltaTarget.param
    ? clause.replace(new RegExp(escapeRegExp(deltaTarget.param.name), "gi"), " ")
    : clause;
  const delta = clauseWithoutName.match(verbPattern(`${UP_VERB}|${DOWN_VERB}`));

  if (delta) {
    const { blocked, param } = deltaTarget;
    if (blocked) return null;

    const withoutName = clauseWithoutName;
    const amount = withoutName.match(new RegExp(`${NUMBER}\\s*${UNIT}?`, "iu"));
    if (!amount) return param ? null : undefined;

    if (param) {
      const raw = parseNumber(amount[1]);
      const scaled = raw === null ? null : convertValue(raw, amount[2], param.type);
      if (scaled === null) return null;
      const sign = verbPattern(DOWN_VERB).test(delta[0]) ? -1 : 1;
      return {
        name: param.name,
        type: param.type,
        value: roundFor(param, param.value + sign * Math.abs(scaled)),
      };
    }

    // A number without a resolvable parameter is not an edit we can apply safely.
    return undefined;
  }

  // 4. absolute set: "đổi Ladder Width 1 thành 400", "set X to 1200 mm"
  const set = clause.match(
    new RegExp(`${SET_VERB}\\s+(?:tham\\s+số\\s+)?(.+?)\\s*${SET_OP}\\s*${NUMBER}\\s*${UNIT}?`, "iu"),
  );
  if (set) {
    const params = (spec.parameters ?? []).filter((param) => param?.name);
    const hit = matchTarget(set[1], params);
    if (hit.ambiguous || !hit.match) return hit.ambiguous ? null : undefined;

    const param = hit.match;
    if (param.formula || !NUMERIC_TYPES.has(param.type)) return null;

    const raw = parseNumber(set[2]);
    const value = raw === null ? null : convertValue(raw, set[3], param.type);
    if (value === null) return null;

    return { name: param.name, type: param.type, value: roundFor(param, value) };
  }

  // 5. bare assignment after a split clause: "… và Ladder Width 2 thành 250"
  const bare = clause.match(
    new RegExp(`^(.{2,60}?)\\s*${SET_OP}\\s*${NUMBER}\\s*${UNIT}?$`, "iu"),
  );
  if (bare) {
    const params = (spec.parameters ?? []).filter((param) => param?.name);
    const hit = matchTarget(bare[1], params);
    if (hit.ambiguous || !hit.match) return hit.ambiguous ? null : undefined;

    const param = hit.match;
    if (param.formula || !NUMERIC_TYPES.has(param.type)) return null;
    const raw = parseNumber(bare[2]);
    const value = raw === null ? null : convertValue(raw, bare[3], param.type);
    if (value === null) return null;

    return { name: param.name, type: param.type, value: roundFor(param, value) };
  }

  return undefined;
}

/**
 * Parses single or multi-parameter edits in Vietnamese and English.
 * Returns null whenever the request is not a pure local edit (the caller then
 * escalates to the patch tier instead of guessing).
 */
export function parseFastParameterEdit(prompt, spec) {
  if (!prompt || !spec || !Array.isArray(spec.parameters)) return null;
  if (spec.units && spec.units !== "mm") return null;

  const text = String(prompt).trim();
  if (!text) return null;

  const colorEdit = parseColorEdit(text, spec);
  if (colorEdit) return colorEdit;

  const rename = parseRename(text, spec);
  if (rename) return rename;

  const material = parseMaterialAssign(text, spec);
  if (material) return material;

  const clauses = text
    .split(/\s*[,;]\s+|\s+(?:và|and|then)\s+/iu)
    .map((clause) => clause.trim())
    .filter(Boolean);

  const edits = [];
  for (const clause of clauses) {
    // A clause that touches a formula/non-numeric parameter cannot be applied locally.
    const clauseNorm = normalizeName(clause);
    const blocked = (spec.parameters ?? []).some(
      (param) =>
        param?.name &&
        clauseNorm.includes(normalizeName(param.name)) &&
        (param.formula || !NUMERIC_TYPES.has(param.type)),
    );
    if (blocked) return null;

    const edit = parseClause(clause, spec);
    if (edit === null) return null; // explicit edit we cannot do deterministically
    if (edit === undefined) continue; // prose without a concrete edit
    edits.push(edit);
  }

  if (edits.length === 0) {
    // "tăng 10%" with no name anywhere: ambiguous, let the model read the request.
    return null;
  }

  const unique = new Map(edits.map((edit) => [edit.name, edit]));

  if (unique.size === 1) {
    return [...unique.values()][0];
  }

  const list = [...unique.values()];
  return { ...list[0], changes: list };
}

/**
 * Geometry fields reference parameters as "[Name]" inside plain strings. A rename
 * must rewrite those too, otherwise the part points at a parameter that no longer exists.
 */
function replaceParameterReference(node, oldName, newName) {
  const pattern = new RegExp(`\\[${escapeRegExp(oldName)}\\]`, "gi");
  const replacement = `[${newName}]`;

  if (typeof node === "string") return node.replace(pattern, replacement);
  if (Array.isArray(node)) return node.map((item) => replaceParameterReference(item, oldName, newName));
  if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      node[key] = replaceParameterReference(node[key], oldName, newName);
    }
  }
  return node;
}

/** Returns a new spec with the edit applied, or null when the target is invalid. */
export function applyFastParameterEdit(spec, edit) {
  if (!spec || !edit) return null;

  const next = JSON.parse(JSON.stringify(spec));
  next.notes = Array.isArray(next.notes) ? [...next.notes] : [];

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
    let mat = next.materials?.find(
      (m) => m && m.name && m.name.toLowerCase() === (edit.material || "").toLowerCase(),
    );
    if (mat) {
      mat.color = edit.color;
    } else {
      const newMatName = `${edit.name} Material`;
      next.materials = next.materials || [];
      next.materials.push({ name: newMatName, color: edit.color, metalness: 0.5, roughness: 0.5 });
      const part = next.parts?.find((p) => p && p.id === edit.partId);
      if (part) part.material = newMatName;
    }
    next.notes.push(`Đã đổi màu part ${edit.name} thành ${edit.color}.`);
    return next;
  }

  if (edit.kind === "material-assign") {
    const part = next.parts?.find((p) => p && p.id === edit.partId);
    if (!part) return null;
    const material = next.materials?.find(
      (m) => m && m.name && m.name.toLowerCase() === edit.material.toLowerCase(),
    );
    if (!material) return null;
    part.material = material.name;
    next.notes.push(`Đã gán vật liệu ${material.name} cho part ${part.name ?? part.id}.`);
    return next;
  }

  if (edit.kind === "rename") {
    if (edit.target === "family") {
      next.name = edit.to;
      next.typeName = edit.to;
      next.notes.push(`Đã đổi tên family thành ${edit.to}.`);
      return next;
    }

    if (edit.target === "material") {
      const material = next.materials?.find(
        (m) => m && m.name && m.name.toLowerCase() === edit.from.toLowerCase(),
      );
      if (!material) return null;
      material.name = edit.to;
      for (const part of next.parts ?? []) {
        if (part.material && part.material.toLowerCase() === edit.from.toLowerCase()) {
          part.material = edit.to;
        }
      }
      next.notes.push(`Đã đổi tên vật liệu ${edit.from} thành ${edit.to}.`);
      return next;
    }

    if (edit.target === "part") {
      const part = next.parts?.find((p) => p && p.id === edit.partId);
      if (!part) return null;
      part.name = edit.to;
      next.notes.push(`Đã đổi tên part ${edit.from} thành ${edit.to}.`);
      return next;
    }

    const param = next.parameters?.find(
      (p) => p && p.name && p.name.toLowerCase() === edit.from.toLowerCase(),
    );
    if (!param) return null;

    const oldName = param.name;
    param.name = edit.to;

    for (const other of next.parameters ?? []) {
      if (typeof other.formula === "string") {
        other.formula = replaceParameterReference(other.formula, oldName, edit.to);
      }
    }

    next.parts = replaceParameterReference(next.parts ?? [], oldName, edit.to);
    next.connectors = replaceParameterReference(next.connectors ?? [], oldName, edit.to);

    next.notes.push(`Đã đổi tên tham số ${oldName} thành ${edit.to}.`);
    return next;
  }

  const changes = Array.isArray(edit.changes) && edit.changes.length > 0 ? edit.changes : [edit];

  for (const item of changes) {
    if (!item.name) return null;
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
