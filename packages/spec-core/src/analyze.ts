import { resolveModel, type ResolvedModel } from "./geometry.js";
import { checkGeometryHealth } from "./geometry-health.js";
import { checkModelLogic } from "./logic.js";
import { analyzeParity, type ParityRisk, type PartParity } from "./parity.js";
import { resolveParameters, type ParameterResolution } from "./parameters.js";
import { checkTopology } from "./topology.js";
import { validateSpec } from "./validate.js";
import type { FamilySpec, Issue } from "./types.js";

export interface Analysis {
  spec: FamilySpec;
  parameters: ParameterResolution;
  model: ResolvedModel;
  issues: Issue[];
  errors: Issue[];
  /** Preview-vs-RFA risks, kept separate from validation issues. */
  parity: ParityRisk[];
  /** One build status per resolved part, used by the studio badges. */
  partParity: PartParity[];
  ok: boolean;
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const issue of issues) {
    const key = `${issue.severity}|${issue.path}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

export function analyzeSpec(
  raw: unknown,
  overrides: Record<string, number | string> = {},
): Analysis {
  const { spec, issues } = validateSpec(raw);
  const parameters = resolveParameters(spec.parameters, overrides);
  const model = resolveModel(spec, parameters);
  const all = dedupe([
    ...issues,
    ...parameters.issues,
    ...model.issues,
    ...checkModelLogic(model, spec.lod),
    ...checkGeometryHealth(model),
    ...checkTopology(model),
  ]);
  const errors = all.filter((issue) => issue.severity === "error");
  const parity = analyzeParity(model);

  return {
    spec,
    parameters,
    model,
    issues: all,
    errors,
    parity: parity.risks,
    partParity: parity.parts,
    ok: errors.length === 0 && model.parts.length > 0,
  };
}

export function formatIssues(issues: Issue[], limit = 20): string {
  return issues
    .slice(0, limit)
    .map((issue) => `- [${issue.severity}] ${issue.path}: ${issue.message}`)
    .join("\n");
}
