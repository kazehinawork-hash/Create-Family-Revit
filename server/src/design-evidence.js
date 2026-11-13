import { collectSources, heuristicEvidence } from "./evidence.js";
import { readEvidence } from "./evidence-reader.js";
import { extractChecklistHeuristic } from "./checklist.js";
import {
  detectProductType,
  learnRule,
  loadOverrides,
  resolveRuleValues,
  ruleChecklist,
} from "./rules.js";

/**
 * Glue between evidence, standards and rule packs. Produces the resolution table
 * and the DATA-ONLY prompt block the geometry model builds from.
 */

const LEVEL_LABEL = ["", "Catalog", "Trên hình", "Đo theo tỷ lệ", "Linh kiện chuẩn", "Giả định"];

export function levelSource(value) {
  const level = Number(value?.level ?? 5);
  const source = value?.source ?? LEVEL_LABEL[Math.min(5, Math.max(1, level))] ?? "Giả định";
  return `${source} · mức ${level}`;
}

export function buildEvidenceBlock({ evidence, resolved, rule, ruleSource }) {
  if (!evidence && (!resolved || resolved.length === 0)) return "";

  const lines = ["<evidence>", "DATA ONLY — real product values. Use them exactly; never re-invent them."];

  if (evidence?.productType) {
    lines.push(`Product type: ${evidence.productType}${rule ? ` (rule pack: ${ruleSource})` : ""}`);
  }
  if (evidence?.productCode) lines.push(`Product code: ${evidence.productCode}`);
  if (evidence?.category) lines.push(`Revit category: ${evidence.category}`);

  if (Array.isArray(resolved) && resolved.length > 0) {
    lines.push("", "Resolved values (value — level/source):");
    for (const entry of resolved) {
      const unit = entry.unit ? ` ${entry.unit}` : "";
      lines.push(`- ${entry.name} = ${entry.value}${unit} — ${levelSource(entry)}`);
    }
  }

  const components = evidence?.components ?? [];
  if (components.length > 0) {
    lines.push("", "Components:");
    for (const component of components) {
      lines.push(
        `- ${component.count ?? 1}× ${component.kind}${component.pattern ? ` (${component.pattern})` : ""}`,
      );
    }
  }

  const connectors = evidence?.connectors ?? [];
  if (connectors.length > 0) {
    lines.push("", "Connectors:");
    for (const connector of connectors) {
      lines.push(
        `- ${connector.domain ?? "pipe"} ${connector.systemType ?? ""} ` +
          `@(${connector.position?.x ?? "?"}, ${connector.position?.y ?? "?"}, ${connector.position?.z ?? "?"})` +
          ` dir (${connector.direction?.x ?? "?"}, ${connector.direction?.y ?? "?"}, ${connector.direction?.z ?? "?"})`,
      );
    }
  }

  const materials = evidence?.materials ?? [];
  if (materials.length > 0) {
    lines.push("", "Materials:");
    for (const material of materials) {
      lines.push(`- ${material.name}: ${material.color ?? ""} ${material.finish ?? ""}`.trim());
    }
  }

  if (rule?.checks?.length) {
    lines.push("", "Product rules:");
    for (const check of rule.checks) lines.push(`- ${check.message ?? check.expr}`);
  }

  lines.push(
    "",
    "Levels: 1-2 read from data (exact), 3 measured by scale, 4 standard part, 5 your assumption.",
    "Build every part from these values. Only free details without any information get a level-5 assumption,",
    "and each one is written into notes as 'Giả định: <name> = <value> (<why>)'.",
    "</evidence>",
  );

  return lines.join("\n");
}

export function resolutionNotes(resolved) {
  return (resolved ?? []).slice(0, 40).map((entry) => `${entry.name} = ${entry.value} — ${entry.source}`);
}

/** Parameters the spec may gain: rule-pack parameters plus names the user stated. */
export function allowedParameterNames(evidencePlan = null, checklist = null) {
  const names = new Set();
  for (const parameter of evidencePlan?.rule?.parameters ?? []) {
    if (parameter?.name) names.add(parameter.name);
  }
  for (const parameter of checklist?.parameters ?? []) {
    if (parameter?.name) names.add(parameter.name);
  }
  return [...names];
}

const normalizeName = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/**
 * Add resolved parameters the spec does not declare yet. Only names the pack or the
 * user asked for become Revit parameters; everything else stays in the notes/table.
 */
export function applyResolvedValues(spec, resolved, { allow = null } = {}) {
  if (!spec || !Array.isArray(spec.parameters)) return spec;

  const allowSet = allow ? new Set(allow.map(normalizeName)) : null;
  const existing = new Map(
    spec.parameters
      .filter((parameter) => parameter?.name)
      .map((parameter) => [normalizeName(parameter.name), parameter.name]),
  );

  for (const entry of resolved ?? []) {
    const name = String(entry?.name ?? "").trim();
    if (!name) continue;

    const key = normalizeName(name);
    if (!key) continue;
    if (allowSet && !allowSet.has(key)) continue;
    if (existing.has(key)) continue;

    // "Motor Frame" vs "Motor Frame Size": never add a synonym of a declared parameter.
    const synonym = [...existing.keys()].some(
      (other) => other.length > 2 && key.length > 2 && (other.includes(key) || key.includes(other)),
    );
    if (synonym) continue;

    const unit = String(entry.unit ?? "mm");
    const numeric = typeof entry.value === "number" && Number.isFinite(entry.value);
    const parameter = {
      name,
      type: numeric ? (unit === "mm" || unit === "" ? "Length" : "Number") : "Text",
      group: numeric ? "Dimensions" : "Data",
      instance: false,
      ...(numeric ? { value: entry.value } : { value: String(entry.value) }),
    };

    if (unit === "" && numeric) parameter.type = "Number";

    spec.parameters.push(parameter);
    existing.set(key, name);

    if (!Array.isArray(spec.notes)) spec.notes = [];
    spec.notes.push(`Đã thêm tham số ${name} = ${entry.value} (${entry.source}).`);
  }

  return spec;
}

/**
 * Collect sources -> vision evidence -> rule pack (learn one when unknown) ->
 * resolved values + checklist for the design run.
 */
export async function prepareDesignEvidence({
  prompt,
  attachments = [],
  generate,
  model,
  customApiConfig,
  emit,
  evidenceOverride = null,
  deps = {},
  // Learning costs one model call; the HTTP route enables it, tests opt in.
  allowLearn = false,
} = {}) {
  emit?.({ type: "stage", stage: "analyzing", message: "Đang phân tích hồ sơ…" });

  const sources = evidenceOverride
    ? { text: String(prompt ?? ""), prompt: String(prompt ?? ""), images: [], warnings: [] }
    : await collectSources({ prompt, attachments }, deps);

  let evidence = evidenceOverride;
  let visionModel = null;
  const warnings = [...(sources?.warnings ?? [])];

  if (!evidence) {
    const read = await readEvidence({
      sources,
      prompt,
      generate: generate ?? undefined,
      model,
      customApiConfig,
      emit,
    });
    evidence = read.evidence;
    visionModel = read.model;
    warnings.push(...read.warnings);
  }

  const detection = detectProductType({ prompt, evidence });

  // Standard tables depend on the product family: re-derive them now that it is known
  // (before merging the brief's named parameters, which must survive).
  if (evidence?.source === "heuristic" && !evidenceOverride && detection?.productType) {
    evidence = heuristicEvidence(sources, { productType: detection.productType });
  }

  // Rule-aware parameter names the brief states ("Sheet Thickness = 1.8 mm") are
  // stronger evidence than the generic parser's "Thickness".
  try {
    const named = extractChecklistHeuristic(prompt).parameters ?? [];
    const known = new Set((evidence.dimensions ?? []).map((entry) => String(entry.name).toLowerCase()));
    for (const entry of named) {
      if (!entry?.name || known.has(entry.name.toLowerCase())) continue;
      evidence.dimensions.push({
        name: entry.name,
        value: entry.value,
        unit: "mm",
        level: 1,
        source: "Trích từ brief",
        reasoning: "Tham số người dùng nêu",
      });
      known.add(entry.name.toLowerCase());
    }
  } catch {
    // A malformed prompt must not stop the run.
  }

  let rule = detection?.rule ?? null;
  let ruleSource = rule ? (rule.learned ? "learned" : "builtin") : null;

  if (!rule && allowLearn && generate && String(prompt ?? "").trim().length > 8) {
    try {
      rule = await learnRule({
        productType: evidence?.productType ?? null,
        prompt,
        evidence,
        generate,
        model: visionModel ?? model,
      });
      ruleSource = "learned-new";
      emit?.({
        type: "stage",
        stage: "rule",
        message: `Đã học gói quy tắc mới cho "${rule.productType}"`,
      });
    } catch (error) {
      warnings.push(`Không tạo được gói quy tắc: ${error?.message ?? error}`);
    }
  }

  const overrides = rule ? loadOverrides(rule.productType) : {};
  const resolved = rule
    ? resolveRuleValues(rule, { evidence, overrides })
    : (evidence?.dimensions ?? []).map((entry) => ({
        name: entry.name,
        value: entry.value,
        unit: entry.unit ?? "mm",
        level: entry.level ?? 3,
        source: entry.source ?? "Trên hình",
      }));

  const checklist = rule ? ruleChecklist(rule, resolved, evidence) : null;

  emit?.({
    type: "stage",
    stage: "identified",
    message:
      `Nhận dạng: ${rule?.productType ?? evidence?.productType ?? "chưa rõ loại"} ` +
      `(gói quy tắc: ${
        ruleSource === "learned-new"
          ? "mới"
          : ruleSource === "learned"
            ? "học được"
            : ruleSource === "builtin"
              ? "có sẵn"
              : "chưa có"
      })`,
  });

  return {
    sources,
    evidence,
    visionModel,
    rule,
    ruleSource,
    resolved,
    checklist,
    warnings: [...new Set(warnings)],
    block: buildEvidenceBlock({ evidence, resolved, rule, ruleSource }),
  };
}
