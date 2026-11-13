import {
  buildParameterGraph,
  collectPartDependencies,
} from "@family/spec-core";

import { config } from "./config.js";
import { parseFastParameterEdit } from "./fast-edit.js";

/**
 * Request routing: spend the cheapest call that can do the job.
 *
 * tier 0 = deterministic local edit (fast-edit), no model
 * tier 1 = small change on an existing spec (patch prompt, cheap model)
 * tier 2 = new family or a structural change (primary model, may split)
 * tier 3 = one strong-model repair pass, only when errors survive tier 2 + code fixes
 */
export const TIER = { FAST: 0, PATCH: 1, STRUCTURE: 2, REPAIR: 3 };

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[_\-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STRUCTURAL =
  /(tao\s+(moi|family|model)|thiet\s+ke\s+lai|lam\s+lai|dung\s+lai|thiet\s+ke\s+moi|from\s+scratch|redesign|rebuild|thay\s+doi\s+toan\s+bo|doi\s+(loai|kieu|category)|chuyen\s+sang\s+(loai|family)|them\s+(tang|nhanh|branch)\s+moi)/;
const LOCAL =
  /(them|bot|go|bo|xoa|thay\s+connector|doi\s+connector|connector|add|remove|delete|insert|thay\s+vat\s+lieu|gan\s+vat\s+lieu|material)/;

/**
 * @returns {{ tier: number, reason: string, fastEdit?: object, normalized: string }}
 */
export function classifyRequest(prompt, { spec = null, fastEdit = parseFastParameterEdit } = {}) {
  const text = String(prompt ?? "").trim();
  const normalized = normalizeText(text);

  if (!text) return { tier: TIER.PATCH, reason: "empty", normalized };

  if (spec) {
    let edit;
    try {
      edit = fastEdit?.(text, spec) ?? null;
    } catch {
      edit = null;
    }
    if (edit) return { tier: TIER.FAST, reason: "fast-edit", fastEdit: edit, normalized };

    if (STRUCTURAL.test(normalized)) {
      return { tier: TIER.STRUCTURE, reason: "structural-change", normalized };
    }

    if (LOCAL.test(normalized)) {
      return { tier: TIER.PATCH, reason: "local-change", normalized };
    }

    // A number that points at a known parameter but was not a clean edit (ambiguity,
    // formula target) must not be guessed: let the model read the request.
    return { tier: TIER.PATCH, reason: "edit-on-existing", normalized };
  }

  return { tier: TIER.STRUCTURE, reason: "new-family", normalized };
}

function pickCheapest(ids) {
  const cheap = ids.filter((id) => /flash|lite|mini|haiku|low|fast/i.test(id));
  const notHeavy = cheap.filter((id) => !/(pro|max|opus|ultra)/i.test(id));
  return notHeavy[0] ?? cheap[0] ?? ids[0] ?? null;
}

function pickStrongest(ids) {
  const strong = ids.filter((id) => /(pro|max|opus|ultra|high)/i.test(id));
  return strong.find((id) => /pro|opus|max/i.test(id)) ?? strong[0] ?? ids[0] ?? null;
}

function pickMedium(ids) {
  const medium = ids.filter((id) => /(medium|standard|sonnet|v4\.1)/i.test(id));
  return medium[0] ?? pickStrongest(ids) ?? ids[0] ?? null;
}

/**
 * Pure so the mapping can be tested: env wins, otherwise the cheapest/medium/strongest
 * model the machine can actually run.
 */
export function chooseTierModels({ env = {}, cmdcModelIds = [], backends = {} } = {}) {
  const ids = (cmdcModelIds ?? []).filter(
    (id) => id && !id.startsWith("codex:") && !id.startsWith("claude:") && id !== "custom:api",
  );

  const codex = Boolean(backends.codex);
  const claude = Boolean(backends.claude);

  const defaults = {
    1:
      (codex && "codex:gpt-6-astra:low") ||
      pickCheapest(ids) ||
      (claude && "claude:default") ||
      "default",
    2:
      (codex && "codex:gpt-6-astra:medium") ||
      pickMedium(ids) ||
      pickStrongest(ids) ||
      "default",
    3:
      (codex && "codex:gpt-6-astra:high") ||
      pickStrongest(ids) ||
      (claude && "claude:claude-3-7-sonnet") ||
      "default",
  };

  return {
    1: env.AGENT_TIER1_MODEL || defaults[1],
    2: env.AGENT_TIER2_MODEL || defaults[2],
    3: env.AGENT_TIER3_MODEL || defaults[3],
  };
}

/**
 * A model the user picked overrides tiers 1-2. Tier 3 may still upgrade when the
 * "allow upgrade" option is on (default), because a stuck model cannot fix itself.
 */
export function modelForTier(tier, { userModel, tierModels, allowUpgrade = true } = {}) {
  if (userModel && (tier === TIER.PATCH || tier === TIER.STRUCTURE)) return userModel;
  if (userModel && tier === TIER.REPAIR && !allowUpgrade) return userModel;
  return tierModels?.[tier] ?? userModel ?? "default";
}

/** Small, human-readable dependency numbers for the patch prompt. */
function parameterLines(spec) {
  return (spec.parameters ?? [])
    .map((param) => {
      if (!param?.name) return null;
      const type = param.type || "Length";
      const value = param.formula ? `= ${param.formula}` : `${param.value ?? 0}`;
      return `${param.name} (${type}): ${value}`;
    })
    .filter(Boolean);
}

function partLine(part) {
  const solid = part?.solid ?? {};
  const kind = solid.kind ?? "unknown";
  const geometry = [];
  if (solid.size) geometry.push(`size ${JSON.stringify(solid.size)}`);
  if (solid.origin) geometry.push(`origin ${JSON.stringify(solid.origin)}`);
  if (solid.radius != null) geometry.push(`r ${solid.radius}`);
  if (solid.points) geometry.push(`${solid.points.length} pts`);
  return `- ${part.id} "${part.name}" [${kind}]${part.material ? ` mat=${part.material}` : ""}${
    geometry.length ? ` ${geometry.join(" ")}` : ""
  }`;
}

/** Compact spec for a prompt: params + formulas, part list, connectors. Never the whole spec. */
export function summarizeSpec(spec, { maxParts = 80 } = {}) {
  if (!spec) return "";

  const params = parameterLines(spec);
  const parts = (spec.parts ?? []).slice(0, maxParts).map(partLine);
  const connectors = (spec.connectors ?? []).map(
    (connector) =>
      `- ${connector.id} ${connector.shape ?? "rect"} ${connector.systemType ?? ""} ` +
      `@${JSON.stringify(connector.origin ?? {})} dir=${JSON.stringify(
        connector.directionVector ?? connector.direction ?? "?",
      )} w=${connector.width ?? "?"} h=${connector.height ?? "?"}`,
  );

  return [
    `Family: ${spec.name ?? "?"} (${spec.category ?? "?"}), units ${spec.units ?? "mm"}`,
    `Parameters (${params.length}):`,
    ...params,
    `Parts (${(spec.parts ?? []).length}, showing ${parts.length}):`,
    ...parts,
    `Connectors (${connectors.length}):`,
    ...connectors,
  ].join("\n");
}

/** Which parameters the request talks about (exact, case/diacritic-insensitive). */
export function mentionedParameters(prompt, spec) {
  const text = normalizeText(prompt);
  return (spec?.parameters ?? [])
    .filter((param) => param?.name && text.includes(normalizeText(param.name)))
    .map((param) => param.name);
}

/** Dependency map + only the parts the request can affect. */
export function affectedContext(prompt, spec) {
  const names = mentionedParameters(prompt, spec);
  if (names.length === 0) return { names: [], parts: [] };

  const graph = buildParameterGraph(spec.parameters ?? []);
  const impacted = new Set([...names, ...graph.impactOf(names)].map((name) => name.toLowerCase()));

  const parts = collectPartDependencies(spec)
    .filter((entry) => entry.parameters.some((name) => impacted.has(name.toLowerCase())))
    .map((entry) => entry.partId ?? entry.id ?? entry.name);

  return { names: [...impacted], parts: parts.filter(Boolean) };
}

export function buildTierPrompt({ tier, request, spec, issues = [], before = null }) {
  const summary = summarizeSpec(spec, { maxParts: tier === TIER.REPAIR ? 120 : 80 });
  const context = affectedContext(request, spec);

  const partsOfInterest = context.parts
    .map((id) => spec.parts?.find((part) => part.id === id))
    .filter(Boolean)
    .map((part) => JSON.stringify(part));

  const blocks = [];

  if (tier === TIER.REPAIR) {
    blocks.push(
      `Fix ONLY the problems listed below in this family. Do not redesign anything else.`,
      `Problems:\n${issues
        .slice(0, 20)
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  } else {
    blocks.push(
      `Apply this request to the existing family. Keep everything else unchanged.\n` +
        `Request: ${request}`,
    );
  }

  if (context.names.length > 0) {
    blocks.push(`Parameters involved: ${context.names.join(", ")}`);
  }

  if (partsOfInterest.length > 0) {
    blocks.push(`Relevant part JSON (edit these, leave the rest as-is):\n${partsOfInterest.join("\n")}`);
  }

  if (before) {
    blocks.push(
      `Current size: ${Math.round(before.x)} x ${Math.round(before.y)} x ${Math.round(before.z)} mm, ` +
        `${spec.parts?.length ?? 0} parts. Keep the same order of magnitude unless the request says otherwise.`,
    );
  }

  blocks.push(`Family summary:\n${summary}`);

  return blocks.join("\n\n");
}

/** Hard cap: a light tier must stay light. */
export function limitPrompt(text, maxChars) {
  if (!maxChars || text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n\n[... prompt truncated at ${maxChars} characters]`,
    truncated: true,
  };
}

/** Cache key input: normalised request + trimmed spec + model/tier. */
export function cacheSignature({ normalizedRequest, spec, model, tier }) {
  const specSignature = {
    name: spec?.name ?? null,
    parameters: (spec?.parameters ?? []).map((param) => [param.name, param.value ?? param.formula]),
    parts: (spec?.parts ?? []).map((part) => [part.id, part.name, part.solid?.kind]),
    connectors: (spec?.connectors ?? []).map((connector) => connector.id),
    materials: (spec?.materials ?? []).map((material) => [material.name, material.color]),
  };

  return { normalizedRequest, spec: specSignature, model: model ?? "", tier };
}

/**
 * A stronger model for complex geometry, staying on the same backend: crossing to
 * another CLI whose model id is not installed produces empty specs, not better ones.
 */
export function strongerAvailableModel(model, tierModels, { cmdcModelIds = [] } = {}) {
  // Already a strong/medium model: nothing to upgrade.
  if (!model || !/flash|mini|lite|low|fast/i.test(model)) return model;

  const backend = model.startsWith("codex:") ? "codex" : model.startsWith("claude:") ? "claude" : "cmdc";

  if (backend === "codex") return tierModels?.[2] ?? model;
  if (backend === "claude") return tierModels?.[3] ?? model;

  const strong = (cmdcModelIds ?? []).filter(
    (id) => id && !/flash|mini|lite|low|fast/i.test(id) && !id.startsWith("codex:") && !id.startsWith("claude:"),
  );
  // Unknown list (the CLI listing failed): keep the user's model rather than
  // jumping to another backend whose model ids may not even exist.
  return strong.find((id) => /pro|max|opus/i.test(id)) ?? strong[0] ?? model;
}

/** Strongest model of the same backend as `model` (null when nothing is known). */
export function strongestSameBackend(model, cmdcModelIds = []) {
  if (!model) return null;
  if (model.startsWith("codex:")) return "codex:default";
  if (model.startsWith("claude:")) return model;

  const strong = (cmdcModelIds ?? []).filter(
    (id) => id && !/flash|mini|lite|low|fast/i.test(id) && !id.startsWith("codex:") && !id.startsWith("claude:"),
  );
  return strong.find((id) => /pro|max|opus/i.test(id)) ?? strong[0] ?? null;
}

export function promptBudgetFor(tier) {
  if (tier === TIER.PATCH) return config.agent.promptMaxTier1;
  if (tier === TIER.STRUCTURE) return config.agent.promptMaxTier2;
  return config.agent.promptMaxTier3;
}
