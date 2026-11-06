import { paramKey } from "./parameters.js";
import type { FamilyParameter, FamilySpec } from "./types.js";

const REFERENCE = /\[([^\]]+)\]/g;

export interface ParameterDependency {
  name: string;
  formula?: string;
  /** Parameters this one reads directly. */
  dependsOn: string[];
  /** Parameters that read this one directly. */
  dependents: string[];
}

export interface PartDependency {
  id: string;
  name: string;
  parameters: string[];
}

export interface ConnectorDependency {
  id: string;
  name: string;
  parameters: string[];
}

export interface ParameterGraph {
  parameters: ParameterDependency[];
  byKey: Map<string, ParameterDependency>;
  impactOf(names: string[]): string[];
}

function collectReferences(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(REFERENCE)) {
      const name = match[1]?.trim();
      if (name) out.add(name);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectReferences(item, out);
  }
  return out;
}

function parameterExpression(param: FamilyParameter): string {
  if (param.formula) return param.formula;
  return typeof param.value === "string" ? param.value : "";
}

/** Direct dependency graph extracted from parameter formulas. Unknown names are ignored. */
export function buildParameterGraph(parameters: FamilyParameter[]): ParameterGraph {
  const byKey = new Map<string, ParameterDependency>();

  for (const param of parameters) {
    if (!param || typeof param.name !== "string" || !param.name.trim()) continue;
    const key = paramKey(param.name);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      name: param.name.trim(),
      formula: param.formula?.trim() || undefined,
      dependsOn: [],
      dependents: [],
    });
  }

  for (const param of parameters) {
    if (!param || typeof param.name !== "string" || !param.name.trim()) continue;
    const node = byKey.get(paramKey(param.name));
    if (!node) continue;

    for (const reference of collectReferences(parameterExpression(param))) {
      const target = byKey.get(paramKey(reference));
      if (!target || target === node) continue;
      if (!node.dependsOn.includes(target.name)) node.dependsOn.push(target.name);
      if (!target.dependents.includes(node.name)) target.dependents.push(node.name);
    }
  }

  for (const node of byKey.values()) {
    node.dependsOn.sort((a, b) => a.localeCompare(b));
    node.dependents.sort((a, b) => a.localeCompare(b));
  }

  const impactOf = (names: string[]): string[] => {
    const seen = new Set<string>();
    const queue = names
      .map((name) => byKey.get(paramKey(name)))
      .filter((node): node is ParameterDependency => Boolean(node));
    const changed = new Set(queue.map((node) => node.name));

    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const dependent of node.dependents) {
        const key = paramKey(dependent);
        if (seen.has(key)) continue;
        seen.add(key);
        const next = byKey.get(key);
        if (next) queue.push(next);
      }
    }

    return [...seen]
      .map((key) => byKey.get(key)?.name)
      .filter((name): name is string => typeof name === "string" && !changed.has(name));
  };

  return { parameters: [...byKey.values()], byKey, impactOf };
}

/** Parameters referenced by each part's solid/cuts/array expressions. */
export function collectPartDependencies(spec: FamilySpec): PartDependency[] {
  const out: PartDependency[] = [];
  for (const part of spec.parts ?? []) {
    if (!part || typeof part.id !== "string") continue;
    const references = collectReferences({
      solid: part.solid,
      cuts: part.cuts,
      array: part.array,
    });
    out.push({
      id: part.id,
      name: part.name || part.id,
      parameters: [...references].sort((a, b) => a.localeCompare(b)),
    });
  }
  return out;
}

/** Parameters referenced by connector position and size expressions. */
export function collectConnectorDependencies(spec: FamilySpec): ConnectorDependency[] {
  const out: ConnectorDependency[] = [];
  for (const connector of spec.connectors ?? []) {
    if (!connector || typeof connector.id !== "string") continue;
    const references = collectReferences({
      origin: connector.origin,
      directionVector: connector.directionVector,
      width: connector.width,
      height: connector.height,
      diameter: connector.diameter,
      flow: connector.flow,
      pressureDrop: connector.pressureDrop,
    });
    if (references.size === 0) continue;
    out.push({
      id: connector.id,
      name: connector.name || connector.id,
      parameters: [...references].sort((a, b) => a.localeCompare(b)),
    });
  }
  return out;
}

/**
 * Compact text for the agent: which parameters move together, and which parts
 * consume them. Kept bounded so a large family cannot blow the prompt budget.
 */
export function parameterDependencySummary(spec: FamilySpec, maxChars = 6000, focus = ""): string {
  const graph = buildParameterGraph(spec.parameters ?? []);
  const parts = collectPartDependencies(spec);
  const connectors = collectConnectorDependencies(spec);
  const lines: string[] = [];

  const focusText = focus.trim().toLowerCase();
  const focusKeys = new Set<string>();
  if (focusText) {
    for (const node of graph.parameters) {
      if (focusText.includes(node.name.toLowerCase())) focusKeys.add(paramKey(node.name));
    }
  }
  const nodes = focusKeys.size > 0
    ? graph.parameters.filter((node) => focusKeys.has(paramKey(node.name)))
    : graph.parameters;

  for (const node of nodes) {
    const affected = graph.impactOf([node.name]);
    const affectedKeys = new Set(affected.map(paramKey));
    const isAffected = (name: string) =>
      paramKey(name) === paramKey(node.name) || affectedKeys.has(paramKey(name));

    const partConsumers = parts.filter((part) => part.parameters.some(isAffected)).map((part) => part.name);
    const connectorConsumers = connectors
      .filter((connector) => connector.parameters.some(isAffected))
      .map((connector) => connector.name);

    if (affected.length === 0 && partConsumers.length === 0 && connectorConsumers.length === 0) continue;

    const chain = affected.length > 0 ? ` -> ${affected.slice(0, 12).join(", ")}` : "";
    const usedParts = partConsumers.length > 0 ? ` | parts: ${partConsumers.slice(0, 12).join(", ")}` : "";
    const usedConnectors =
      connectorConsumers.length > 0
        ? ` | connectors: ${connectorConsumers.slice(0, 8).join(", ")}`
        : "";
    lines.push(`- ${node.name}${chain}${usedParts}${usedConnectors}`);
  }

  if (lines.length === 0) return "";
  const text = `PARAMETER DEPENDENCY MAP (computed from the current spec):\n${lines.join("\n")}`;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[... truncated]` : text;
}
