import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";

/**
 * Product rule packs. One JSON file per product type, shared schema, no code per
 * product: the designer only reads parameters/components/connectors/checks.
 */

const normalize = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Same text with Vietnamese diacritics kept, lowercased. */
const accented = (value) => String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** True when the phrase loses characters when de-accented (đ, è, ộ...). */
const hasDiacritics = (phrase) => accented(phrase) !== normalize(phrase);

/** Unicode-aware word boundaries (JS \b is ASCII only and breaks on "đèn"). */
function wordPattern(phrase) {
  const escaped = String(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
}

export function rulesDir() {
  // Env first so tests can point at a temporary directory.
  return process.env.FAMILY_RULES_DIR || config.dirs.rules;
}

function readDir(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8")))
      .filter((rule) => rule && typeof rule.productType === "string");
  } catch {
    return [];
  }
}

let cache = null;

/** Built-in packs first, then learned ones (learned wins on duplicate type). */
export function loadRules({ fresh = false } = {}) {
  if (cache && !fresh) return cache;

  const builtin = readDir(rulesDir());
  const learned = readDir(path.join(rulesDir(), "learned"));
  const byType = new Map();

  for (const rule of builtin) byType.set(rule.productType, { ...rule, learned: false });
  for (const rule of learned) byType.set(rule.productType, { ...rule, learned: true });

  cache = [...byType.values()];
  return cache;
}

export function findRule(productType) {
  if (!productType) return null;
  return loadRules().find((rule) => rule.productType === productType) ?? null;
}

/** Best matching pack for a brief, or null when this product type is new. */
export function detectProductType({ prompt = "", evidence = null } = {}) {
  const source = `${prompt} ${evidence?.productType ?? ""} ${evidence?.productCode ?? ""} ${evidence?.category ?? ""}`;
  const plain = ` ${normalize(source)} `;
  const exact = ` ${accented(source)} `;

  let best = null;

  for (const rule of loadRules()) {
    let score = 0;
    let matchedLength = 0;

    for (const keyword of rule.matchers?.keywords ?? rule.aliases ?? []) {
      const phrase = String(keyword ?? "").trim();
      if (!phrase) continue;

      // Accented keywords are matched before de-accenting, so "đèn" never matches
      // "đen"/"đến"; ASCII keywords match the plain text with word boundaries.
      const hit = hasDiacritics(phrase)
        ? wordPattern(accented(phrase)).test(exact)
        : wordPattern(normalize(phrase)).test(plain);

      if (hit) {
        score += 2 + Math.min(4, Math.floor(phrase.length / 8));
        matchedLength = Math.max(matchedLength, phrase.length);
      }
    }

    for (const pattern of rule.matchers?.codePatterns ?? []) {
      try {
        if (new RegExp(pattern, "i").test(evidence?.productCode ?? "")) score += 3;
      } catch {
        // An invalid pattern in a hand-written pack must not break detection.
      }
    }

    if (evidence?.productType && normalize(evidence.productType) === normalize(rule.productType)) {
      score += 4;
    }

    if (rule.category && normalize(evidence?.category ?? "") === normalize(rule.category)) score += 1;

    // Longest matched phrase wins a tie ("thang cáp" over "cáp").
    if (score > 0 && (!best || score > best.score || (score === best.score && matchedLength > best.matchedLength))) {
      best = { score, matchedLength, rule };
    }
  }

  return best
    ? {
        productType: best.rule.productType,
        rule: best.rule,
        learned: Boolean(best.rule.learned),
        score: best.score,
      }
    : null;
}

/** Evaluate "[A] * 2 + 40" against resolved values. Arithmetic only. */
export function evaluateFormula(formula, values) {
  const source = String(formula ?? "");
  if (!source) return null;

  const expression = source.replace(/\[([^\]]+)\]/g, (match, name) => {
    const value = values[name] ?? values[normalize(name)];
    return Number.isFinite(Number(value)) ? String(Number(value)) : "0";
  });

  if (!/^[\d\s+\-*/().]+$/.test(expression)) return null;

  try {
    const result = Function(`"use strict"; return (${expression});`)();
    return Number.isFinite(result) ? Math.round(result * 100) / 100 : null;
  } catch {
    return null;
  }
}

export function loadOverrides(productType, dir = rulesDir()) {
  if (!productType) return {};
  try {
    const file = path.join(dir, "overrides", `${productType}.json`);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")).values ?? {};
  } catch {
    return {};
  }
}

export function saveOverride(productType, name, value) {
  if (!productType || !name) return null;

  const dir = path.join(rulesDir(), "overrides");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${productType}.json`);

  let current = { productType, values: {} };
  try {
    if (fs.existsSync(file)) current = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // A corrupt override file is replaced.
  }

  current.productType = productType;
  current.values = { ...(current.values ?? {}), [name]: Number(value) };
  current.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(current, null, 2));
  return current;
}

/**
 * Template option names differ from the rule parameter names. This bridge lets a
 * deterministic template start from the resolved values instead of its defaults.
 */
export function resolvedToTemplateOptions(family, resolved) {
  if (family !== "cable-ladder") return {};

  const byName = Object.fromEntries((resolved ?? []).map((entry) => [normalize(entry.name), entry.value]));
  const pick = (...names) => {
    for (const name of names) {
      const value = byName[normalize(name)];
      if (Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
    }
    return undefined;
  };

  const options = {
    ladderWidth1: pick("Ladder Width 1", "Width"),
    ladderWidth2: pick("Ladder Width 2"),
    ladderHeight: pick("Ladder Height", "Height"),
    sheetThickness: pick("Sheet Thickness", "Thickness"),
    flangeWidth: pick("Flange Width"),
    safetyLip: pick("Safety Lip"),
    tangentLength: pick("Tangent Length"),
    miterOffset: pick("Miter Offset"),
    rungWidth: pick("Rung Width"),
    rungHeight: pick("Rung Height"),
    rungThickness: pick("Rung Thickness"),
  };

  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}
/**
 * Merge evidence + standards + rule defaults into one resolved table.
 * A value may only land in a parameter the pack maps explicitly (`fromEvidence`);
 * lower level numbers win and nothing overwrites a stronger source.
 */
export function resolveRuleValues(rule, { evidence = null, overrides = {} } = {}) {
  const resolved = new Map();

  const set = (name, value, level, source) => {
    if (!name) return;
    if (!Number.isFinite(Number(value)) && typeof value !== "string") return;
    const existing = resolved.get(name);
    if (existing && existing.level <= level) return;
    resolved.set(name, { name, value, level, source });
  };

  // One entry per name, keeping the strongest (lowest) level when the parser
  // reports the same name twice.
  const evidenceByName = new Map();
  for (const entry of evidence?.dimensions ?? []) {
    const key = normalize(entry.name);
    const current = evidenceByName.get(key);
    if (!current || (entry.level ?? 3) < (current.level ?? 3)) {
      evidenceByName.set(key, entry);
    }
  }

  // 0. Every evidence value keeps its own name in the table (the prompt/web show it);
  // only the pack's `fromEvidence` decides which parameter it fills.
  for (const entry of evidenceByName.values()) {
    set(entry.name, entry.value, entry.level ?? 3, entry.source ?? "Trên hình");
  }

  // 1. Explicit mapping from a generic parser name to the pack's parameter.
  for (const parameter of rule?.parameters ?? []) {
    for (const sourceName of parameter.fromEvidence ?? []) {
      const entry = evidenceByName.get(normalize(sourceName));
      if (!entry) continue;
      set(parameter.name, entry.value, entry.level ?? 3, entry.source ?? "Trên hình");
      break;
    }
  }

  // 2. Evidence that already uses the parameter's own name.
  for (const parameter of rule?.parameters ?? []) {
    const entry = evidenceByName.get(normalize(parameter.name));
    if (entry) set(parameter.name, entry.value, entry.level ?? 1, entry.source ?? "Catalog");
  }

  // 3. Remembered choices: level 2 — useful, but a real brief/catalogue wins.
  for (const [name, value] of Object.entries(overrides ?? {})) {
    set(name, value, 2, "Theo lựa chọn trước của bạn");
  }

  // 4. Pack defaults/formulas: level 4.
  for (const parameter of rule?.parameters ?? []) {
    if (resolved.has(parameter.name)) continue;

    if (parameter.default !== undefined) {
      set(parameter.name, parameter.default, 4, `Quy tắc ${rule.productType}`);
      continue;
    }

    if (parameter.formula) {
      const byName = Object.fromEntries([...resolved.values()].map((entry) => [entry.name, entry.value]));
      const value = evaluateFormula(parameter.formula, byName);
      if (value !== null) set(parameter.name, value, 4, `Quy tắc ${rule.productType}`);
    }
  }

  return [...resolved.values()];
}

const KIND_SYNONYMS = {
  "corner-rail": ["corner", "rail", "thanh goc"],
  rung: ["rung", "bac"],
  body: ["body", "than"],
  flange: ["flange", "bich"],
  disc: ["disc", "dia"],
  stem: ["stem", "truc"],
  handle: ["handle", "tay"],
  casing: ["casing", "vo"],
  impeller: ["impeller", "canh"],
  blade: ["blade", "canh"],
  motor: ["motor", "dong co"],
  door: ["door", "cua"],
  "din-rail": ["din rail", "ray"],
  "gland-plate": ["gland plate", "mat"],
  "cable-gland": ["cable gland", "oc siet"],
  coil: ["coil", "dan"],
  filter: ["filter", "loc"],
  fan: ["fan", "quat"],
  base: ["base", "de"],
  bracket: ["bracket", "gia do"],
  rod: ["rod", "thanh treo"],
  clamp: ["clamp", "kep"],
  housing: ["housing", "vo"],
  diffuser: ["diffuser", "tan"],
  "led-board": ["led board", "mach led"],
  enclosure: ["enclosure", "vo tu"],
  "access-door": ["access door", "cua tham"],
  guard: ["guard", "luoi"],
};

export function matcherForKind(kind) {
  const words = KIND_SYNONYMS[kind] ?? [kind.replace(/-/g, " ")];
  return new RegExp(words.map((word) => normalize(word).replace(/\s+/g, "\\s+")).join("|"), "i");
}

/** Checklist compatible with checkCompleteness, built from the pack + evidence. */
export function ruleChecklist(rule, resolved, evidence = null) {
  const groups = [];

  for (const component of rule?.components ?? []) {
    const fromEvidence = (evidence?.components ?? []).find(
      (entry) => normalize(entry.kind) === normalize(component.kind),
    );
    const count = Number(fromEvidence?.count ?? component.countFormula ?? 0);
    if (!Number.isFinite(count) || count <= 0) continue;

    groups.push({
      role: component.kind,
      label: `${count} ${component.kind}`,
      expected: count,
      matcher: matcherForKind(component.kind),
      forCompleteness: Boolean(component.required),
    });
  }

  return {
    family: rule?.productType ?? null,
    groups,
    connectors: Number(evidence?.connectors?.length ?? 0) || (rule?.connectors?.length ?? 0),
    parameters: (resolved ?? []).map((entry) => ({ name: entry.name, value: entry.value })),
    requiresMaterials: (rule?.materials ?? []).length > 0,
    complex: groups.reduce((total, group) => total + group.expected, 0) >= 8,
    source: rule?.learned ? "learned" : "rules",
  };
}

export function validateRule(rule, { productType } = {}) {
  const problems = [];
  if (!rule || typeof rule !== "object") return { ok: false, problems: ["empty rule"] };
  if (!rule.productType && !productType) problems.push("missing productType");
  if (!Array.isArray(rule.parameters)) problems.push("parameters must be an array");
  if (!Array.isArray(rule.components)) problems.push("components must be an array");

  for (const parameter of rule.parameters ?? []) {
    if (!parameter?.name) problems.push("parameter without a name");
  }

  return { ok: problems.length === 0, problems };
}

export function saveLearnedRule(productType, rule) {
  const dir = path.join(rulesDir(), "learned");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${productType}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ ...rule, productType, learned: true, createdAt: new Date().toISOString() }, null, 2),
  );
  cache = null;
  return file;
}

/**
 * One cheap model call proposes a pack for an unknown product type.
 */
export async function learnRule({ productType, prompt, evidence, generate, model }) {  const system =
    "You are a mechanical engineer. Propose a reusable rule pack for this product type. " +
    "Reply with ONE JSON object only: " +
    '{"productType":"kebab-case","aliases":[],"category":"one Revit category","matchers":{"keywords":[],"codePatterns":[]},' +
    '"parameters":[{"name":"Title Case","group":"Dimensions","unit":"mm","default":number,"range":[min,max],"note":"why"}],' +
    '"components":[{"kind":"kebab-case","required":true,"countFormula":"1","placement":"..."}],' +
    '"connectors":[{"domain":"pipe|duct|cable|CableTray","sizeFrom":"Parameter","placement":"..."}],' +
    '"materials":[{"name":"...","color":"#rrggbb","finish":"..."}],"checks":[]}. ' +
    "Use realistic Vietnamese market values, every parameter must have default or formula.";

  const result = await generate(
    [
      { role: "system", content: system },
      {
        role: "user",
        content:
          `Product type: ${productType}\nBrief: ${String(prompt ?? "").slice(0, 2000)}\n` +
          `Evidence: ${JSON.stringify(evidence?.dimensions ?? []).slice(0, 3000)}`,
      },
    ],
    { model, timeoutMs: 45000 },
  );

  const rule = result?.json;
  // The model names the type; fall back to the caller's guess only when it is silent.
  const finalType = String(rule?.productType ?? productType ?? "").trim();
  const check = validateRule(rule, { productType: finalType });
  if (!check.ok || !finalType) {
    throw new Error(`Gói quy tắc không hợp lệ: ${check.problems.join(", ") || "thiếu productType"}`);
  }

  saveLearnedRule(finalType, rule);
  return { ...rule, productType: finalType, learned: true };
}

/**
 * Remember a value the user changed, per product type. Only detail parameters the
 * pack marks `remember` are kept, and never when the original value came from the
 * brief/catalogue (level 1-2).
 */
export function recordUserEdit({ prompt = "", spec = null, name, value, level = null }) {
  if (!name || !Number.isFinite(Number(value))) return null;

  const detection = detectProductType({
    prompt: `${prompt} ${spec?.name ?? ""} ${spec?.category ?? ""}`,
    evidence: null,
  });

  const productType = detection?.productType;
  if (!productType) return null;

  const parameter = (detection.rule?.parameters ?? []).find(
    (entry) => normalize(entry.name) === normalize(name),
  );
  if (!parameter || parameter.remember !== true) return null;
  if (level !== null && Number(level) <= 2) return null;

  saveOverride(productType, name, value);
  return productType;
}
