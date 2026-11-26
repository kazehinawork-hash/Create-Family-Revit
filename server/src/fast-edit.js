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

const UNIT = '(mm|cm|m|inch|in|"|deg|°|do)';
const SET_VERB = "(?:doi|thay\\s+doi|chinh|sua|dat|gan|set|change|update|adjust|make)";
const UP_VERB = "(?:tang|cong\\s+them|cong|nang|increase|raise|bump|add)";
const DOWN_VERB = "(?:giam|tru|bot|ha|decrease|reduce|lower|subtract)";
const SET_OP = "(?:thanh|sang|ve|to|=|:)";

/**
 * Strip Vietnamese diacritics while keeping punctuation (`°`, `"`, `%`, `.`, `,`) intact
 * so both accented and unaccented phrasings match the same patterns.
 */
function stripViDiacritics(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

/**
 * Ordered longest-phrase-first so specific compound phrases ("dai nhanh", "duong kinh ngoai")
 * resolve before generic suffixes ("dai", "duong kinh").
 */
const VI_PARAM_ALIASES = [
  { phrases: ["duong kinh danh nghia"], exact: ["nominal diameter"], suffix: [] },
  {
    phrases: ["duong kinh ngoai"],
    exact: ["outer diameter", "body od", "od"],
    suffix: ["outer diameter", "od"],
    subfeature: true,
  },
  {
    phrases: ["duong kinh trong"],
    exact: ["inner diameter", "bore diameter", "id"],
    suffix: ["inner diameter", "bore diameter", "id"],
    subfeature: true,
  },
  {
    phrases: [
      "chieu dai nhanh",
      "do dai nhanh",
      "dai nhanh",
      "doan nhanh",
      "chieu dai canh",
      "dai canh",
    ],
    exact: ["leg length", "arm length", "branch length", "run length"],
    suffix: ["leg length", "arm length", "branch length", "run length"],
    subfeature: true,
  },
  {
    phrases: [
      "chieu rong mep gap",
      "be rong mep gap",
      "do rong mep gap",
      "mep gap",
      "canh gap",
      "tai gap",
      "vien gap",
    ],
    exact: ["flange", "flange width", "lip", "lip width", "hem width"],
    suffix: ["flange", "flange width", "lip width", "lip", "hem width"],
    subfeature: true,
  },
  { phrases: ["chieu rong", "be rong", "do rong", "rong"], exact: ["width"], suffix: ["width"] },
  { phrases: ["chieu cao", "be cao", "do cao", "cao"], exact: ["height"], suffix: ["height"] },
  { phrases: ["chieu dai", "be dai", "do dai", "dai"], exact: ["length"], suffix: ["length"] },
  { phrases: ["chieu sau", "be sau", "do sau", "sau"], exact: ["depth"], suffix: ["depth"] },
  {
    phrases: ["day ton", "day tam"],
    exact: ["sheet thickness", "plate thickness"],
    suffix: ["sheet thickness", "plate thickness"],
  },
  {
    phrases: ["day thanh", "day vach"],
    exact: ["wall thickness", "panel thickness"],
    suffix: ["wall thickness", "panel thickness"],
  },
  { phrases: ["chieu day", "be day", "do day", "day"], exact: ["thickness"], suffix: ["thickness"] },
  { phrases: ["duong kinh", "co ong", "phi"], exact: ["diameter", "nominal diameter"], suffix: ["diameter"] },
  {
    phrases: ["ban kinh uon", "ban kinh cong"],
    exact: ["bend radius", "center radius", "radius"],
    suffix: ["bend radius", "center radius"],
  },
  { phrases: ["ban kinh"], exact: ["radius"], suffix: ["radius"] },
  { phrases: ["goc uon", "goc re", "goc co"], exact: ["bend angle", "angle"], suffix: ["bend angle"] },
  { phrases: ["goc"], exact: ["angle"], suffix: ["angle"] },
  { phrases: ["buoc bac", "khoang cach bac"], exact: ["rung pitch", "rung spacing"], suffix: ["pitch", "spacing"] },
  { phrases: ["so bac", "so luong bac"], exact: ["rung count"], suffix: ["rung count"] },
  {
    phrases: ["kich thuoc vat", "do vat"],
    exact: ["chamfer size", "chamfer", "miter offset"],
    suffix: ["chamfer size", "chamfer"],
  },
];

export { VI_PARAM_ALIASES };

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

function matchVietnameseAlias(text, candidates) {
  const clauseNorm = normalizeName(text);
  if (!clauseNorm) return { match: null, ambiguous: false, matchedPhrase: null };

  for (let entryIndex = 0; entryIndex < VI_PARAM_ALIASES.length; entryIndex += 1) {
    const entry = VI_PARAM_ALIASES[entryIndex];
    const earlierSubfeatures = VI_PARAM_ALIASES.slice(0, entryIndex).filter((e) => e.subfeature);
    const isClaimedBySubfeature = (base) =>
      earlierSubfeatures.some(
        (sub) =>
          sub.exact?.includes(base) ||
          sub.suffix?.some((sfx) => base === sfx || base.endsWith(` ${sfx}`)),
      );

    for (const phrase of entry.phrases) {
      const hit = clauseNorm.match(new RegExp(`(?:^| )(${escapeRegExp(phrase)})(?: (\\d+))?(?: |$)`, "u"));
      if (!hit) continue;

      const candidateSuffix = hit[2] ?? null;
      const hasSuffixCandidate =
        candidateSuffix !== null &&
        candidates.some((c) => {
          const words = normalizeName(c.name).split(" ").filter(Boolean);
          return words[words.length - 1] === candidateSuffix;
        });

      const suffixNum = hasSuffixCandidate ? candidateSuffix : null;
      const matchedPhrase = suffixNum ? `${hit[1]} ${suffixNum}` : hit[1];

      const scoped = suffixNum
        ? candidates.filter((c) => {
          const words = normalizeName(c.name).split(" ").filter(Boolean);
          return words[words.length - 1] === suffixNum;
        })
        : candidates;

      const stripTrailingNum = (nameNorm) =>
        suffixNum ? nameNorm.replace(new RegExp(` ${escapeRegExp(suffixNum)}$`), "") : nameNorm;

      const tier1 = scoped.filter((c) => {
        const base = stripTrailingNum(normalizeName(c.name));
        return Boolean(entry.exact?.includes(base));
      });
      if (tier1.length === 1) return { match: tier1[0], ambiguous: false, matchedPhrase };
      if (tier1.length > 1) return { match: null, ambiguous: true, matchedPhrase };

      const rawTier2 = scoped.filter((c) => {
        const base = stripTrailingNum(normalizeName(c.name));
        if (isClaimedBySubfeature(base)) return false;
        return entry.suffix?.some((sfx) => base === sfx || base.endsWith(` ${sfx}`));
      });
      // Ignore derived formula helpers when editable numeric matches exist (e.g. "Half Width" vs "Tray Width").
      const editableTier2 = rawTier2.filter((c) => !c.formula && NUMERIC_TYPES.has(c.type));
      const tier2 = editableTier2.length > 0 ? editableTier2 : rawTier2;
      if (tier2.length === 1) return { match: tier2[0], ambiguous: false, matchedPhrase };
      if (tier2.length > 1) return { match: null, ambiguous: true, matchedPhrase };
    }
  }

  return { match: null, ambiguous: false, matchedPhrase: null };
}

function matchParameterTarget(text, parameters) {
  const direct = matchTarget(text, parameters);
  if (direct.ambiguous || direct.match) {
    return { ...direct, matchedPhrase: direct.match?.name ?? null };
  }
  return matchVietnameseAlias(text, parameters);
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
  const hit = matchParameterTarget(text, params);
  if (hit.ambiguous) return { blocked: true };
  if (!hit.match) return { blocked: false, param: null, matchedPhrase: null };
  if (hit.match.formula || !NUMERIC_TYPES.has(hit.match.type)) return { blocked: true };
  if (typeof hit.match.value !== "number") return { blocked: true };
  return { blocked: false, param: hit.match, matchedPhrase: hit.matchedPhrase };
}

function roundFor(param, value) {
  return param.type === "Integer" ? Math.round(value) : Math.round(value * 1000) / 1000;
}

function applyAbsoluteMatch(targetText, rawNumber, unitText, spec) {
  const params = (spec.parameters ?? []).filter((param) => param?.name);
  const hit = matchParameterTarget(targetText, params);
  if (hit.ambiguous || !hit.match) return hit.ambiguous ? null : undefined;

  const param = hit.match;
  if (param.formula || !NUMERIC_TYPES.has(param.type)) return null;

  const raw = parseNumber(rawNumber);
  const value = raw === null ? null : convertValue(raw, unitText, param.type);
  if (value === null) return null;

  return { name: param.name, type: param.type, value: roundFor(param, value) };
}

function parseClause(rawClause, spec) {
  const clause = stripViDiacritics(rawClause);

  // 1. percentage: "tăng 10%", "giảm Ladder Height 5 %", "increase by 20 percent"
  const percent = clause.match(
    new RegExp(
      `(tang|giam|increase|decrease|reduce)\\s+(?:by\\s+)?(.{0,60}?)${NUMBER}\\s*(?:%|percent|phan\\s+tram)`,
      "iu",
    ),
  );
  if (percent) {
    const { blocked, param } = numericTarget(clause, spec);
    if (blocked || !param) return blocked ? null : undefined;
    const amount = parseNumber(percent[3]);
    if (amount === null) return null;
    const sign = /^(giam|decrease|reduce)$/i.test(percent[1]) ? -1 : 1;
    const value = param.value * (1 + (sign * amount) / 100);
    return { name: param.name, type: param.type, value: roundFor(param, value) };
  }

  // 2. multiply / halve: "nhân đôi", "gấp đôi", "double", "giảm một nửa", "halve"
  const multiply = clause.match(
    /(nhan\s+doi|gap\s+doi|nhan\s+(?:voi\s+)?2|double|x2|×2|nhan\s+ba|triple|x3|×3)/iu,
  );
  const halve = clause.match(/(giam\s+mot\s+nua|chia\s+doi|halve|half)/iu);

  if (multiply || halve) {
    const { blocked, param } = numericTarget(clause, spec);
    if (blocked || !param) return blocked ? null : undefined;
    const factor = halve ? 0.5 : /(ba|triple|x3|×3)/i.test(multiply[0]) ? 3 : 2;
    return { name: param.name, type: param.type, value: roundFor(param, param.value * factor) };
  }

  // 2b. target-level ("lên X" / "xuống X"): "tăng chiều cao lên 150", "giảm chiều rộng xuống 300" -> absolute X
  const levelTarget = clause.match(
    new RegExp(
      `^(?:(?:${UP_VERB}|${DOWN_VERB}|${SET_VERB})\\s+)?(?:tham\\s+so\\s+)?(.+?)(?:\\s+(?:${UP_VERB}|${DOWN_VERB}))?\\s+(?:len|xuong)(?!\\s+(?:them|bot))(?:\\s+(?:thanh|con|toi|den))?\\s+${NUMBER}\\s*${UNIT}?$`,
      "iu",
    ),
  );
  if (levelTarget) {
    return applyAbsoluteMatch(levelTarget[1], levelTarget[2], levelTarget[3], spec);
  }

  // 3. relative delta: "tăng chiều cao thêm 100mm", "giảm X 50", "add 10 mm to X"
  // Strip the matched parameter name or Vietnamese phrase so digits in "Ladder Width 1"
  // or verbs inside "Lower Run Length" never pollute delta detection or amount parsing.
  const deltaTarget = numericTarget(clause, spec);
  let clauseWithoutName = clause;
  if (deltaTarget.param) {
    clauseWithoutName = clauseWithoutName.replace(
      new RegExp(escapeRegExp(deltaTarget.param.name), "gi"),
      " ",
    );
    if (
      deltaTarget.matchedPhrase &&
      deltaTarget.matchedPhrase.toLowerCase() !== deltaTarget.param.name.toLowerCase()
    ) {
      clauseWithoutName = normalizeName(clauseWithoutName).replace(
        new RegExp(`(?:^| )${escapeRegExp(deltaTarget.matchedPhrase)}(?: |$)`, "gi"),
        " ",
      );
    }
  }
  const delta = clauseWithoutName.match(verbPattern(`${UP_VERB}|${DOWN_VERB}`));

  if (delta) {
    const { blocked, param } = deltaTarget;
    if (blocked) return null;

    const amount = clauseWithoutName.match(new RegExp(`${NUMBER}\\s*${UNIT}?`, "iu"));
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

  // 4. absolute set with explicit operator: "đổi chiều rộng thành 600 mm", "set X to 1200 mm"
  const set = clause.match(
    new RegExp(`${SET_VERB}\\s+(?:tham\\s+so\\s+)?(.+?)\\s*${SET_OP}\\s*${NUMBER}\\s*${UNIT}?`, "iu"),
  );
  if (set) {
    return applyAbsoluteMatch(set[1], set[2], set[3], spec);
  }

  // 4b. verb + target + value without separator word: "đổi chiều rộng 600 mm", "sua day 2"
  const setNoOp = clause.match(
    new RegExp(`${SET_VERB}\\s+(?:tham\\s+so\\s+)?(.+?)\\s+${NUMBER}\\s*${UNIT}?$`, "iu"),
  );
  if (setNoOp) {
    return applyAbsoluteMatch(setNoOp[1], setNoOp[2], setNoOp[3], spec);
  }

  // 5. bare assignment: "Tray Width = 600", "chiều rộng: 600mm", "… và Ladder Width 2 thành 250"
  const bare = clause.match(
    new RegExp(`^(.{2,60}?)\\s*${SET_OP}\\s*${NUMBER}\\s*${UNIT}?$`, "iu"),
  );
  if (bare) {
    return applyAbsoluteMatch(bare[1], bare[2], bare[3], spec);
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
    .split(/\s*[,;]\s+|\s+(?:và|va|and|then)\s+/iu)
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
