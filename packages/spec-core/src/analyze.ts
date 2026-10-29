import { resolveModel, type ResolvedModel } from "./geometry.js";
import { checkModelLogic } from "./logic.js";
import { resolveParameters, type ParameterResolution } from "./parameters.js";
import { validateSpec } from "./validate.js";
import type { FamilySpec, Issue } from "./types.js";

export interface Analysis {
  spec: FamilySpec;
  parameters: ParameterResolution;
  model: ResolvedModel;
  issues: Issue[];
  errors: Issue[];
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
  const all = dedupe([...issues, ...parameters.issues, ...model.issues, ...checkModelLogic(model)]);
  const errors = all.filter((issue) => issue.severity === "error");

  return {
    spec,
    parameters,
    model,
    issues: all,
    errors,
    ok: errors.length === 0 && model.parts.length > 0,
  };
}

export function formatIssues(issues: Issue[], limit = 20): string {
  return issues
    .slice(0, limit)
    .map((issue) => `- [${issue.severity}] ${issue.path}: ${issue.message}`)
    .join("\n");
}
