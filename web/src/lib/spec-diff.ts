import {
  buildParameterGraph,
  collectPartDependencies,
  paramKey,
  type FamilyParameter,
  type FamilySpec,
} from "@family/spec-core";

export interface SpecPartChange {
  id: string;
  name: string;
  kind: "added" | "updated" | "removed";
}

export interface SpecParameterChange {
  name: string;
  kind: "added" | "updated" | "removed";
  from?: string;
  to?: string;
}

export interface SpecDiff {
  parts: SpecPartChange[];
  parameters: SpecParameterChange[];
  changedPartIds: string[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((out, key) => {
        out[key] = stableValue(record[key]);
        return out;
      }, {});
  }
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

export function parameterValueText(parameter: FamilyParameter): string {
  if (parameter.formula) return `= ${parameter.formula}`;
  if (parameter.value === undefined || parameter.value === null || parameter.value === "") {
    return "—";
  }
  return String(parameter.value);
}

export function diffSpecs(previous: FamilySpec | null | undefined, next: FamilySpec): SpecDiff {
  const previousParts = new Map((previous?.parts ?? []).map((part) => [part.id, part]));
  const nextParts = new Map(next.parts.map((part) => [part.id, part]));
  const parts: SpecPartChange[] = [];
  for (const [id, part] of nextParts) {
    const old = previousParts.get(id);
    if (!old) parts.push({ id, name: part.name, kind: "added" });
    else if (!sameValue(old, part)) parts.push({ id, name: part.name, kind: "updated" });
  }
  for (const [id, part] of previousParts) {
    if (!nextParts.has(id)) parts.push({ id, name: part.name, kind: "removed" });
  }

  const previousParameters = new Map(
    (previous?.parameters ?? []).map((parameter) => [parameter.name, parameter]),
  );
  const nextParameters = new Map(next.parameters.map((parameter) => [parameter.name, parameter]));
  const parameters: SpecParameterChange[] = [];
  for (const [name, parameter] of nextParameters) {
    const old = previousParameters.get(name);
    if (!old) {
      parameters.push({ name, kind: "added", to: parameterValueText(parameter) });
    } else if (
      old.type !== parameter.type ||
      old.formula !== parameter.formula ||
      old.value !== parameter.value
    ) {
      parameters.push({
        name,
        kind: "updated",
        from: parameterValueText(old),
        to: parameterValueText(parameter),
      });
    }
  }
  for (const [name, parameter] of previousParameters) {
    if (!nextParameters.has(name)) {
      parameters.push({ name, kind: "removed", from: parameterValueText(parameter) });
    }
  }

  // A parameter edit can change rendered geometry without changing the part JSON:
  // mark the parts that consume the edited parameter (or one of its dependents).
  const changedParameterNames = parameters.map((parameter) => parameter.name);
  if (changedParameterNames.length > 0) {
    const graph = buildParameterGraph(next.parameters);
    const impacted = new Set(
      [...changedParameterNames, ...graph.impactOf(changedParameterNames)].map(paramKey),
    );
    const known = new Set(parts.map((part) => part.id));
    for (const dependency of collectPartDependencies(next)) {
      if (known.has(dependency.id)) continue;
      if (!dependency.parameters.some((name) => impacted.has(paramKey(name)))) continue;
      const part = nextParts.get(dependency.id);
      if (part) parts.push({ id: part.id, name: part.name, kind: "updated" });
    }
  }

  return {
    parts,
    parameters,
    changedPartIds: parts.filter((part) => part.kind !== "removed").map((part) => part.id),
  };
}

const ASSUMPTION_PREFIX = /^\s*Giả định\s*:/i;

/** Same parameter + same value is still the same assumption, even if reworded. */
function assumptionKey(note: string): string {
  const body = note.replace(ASSUMPTION_PREFIX, "").trim();
  const equals = body.indexOf("=");
  if (equals < 0) return body.toLowerCase();
  const name = paramKey(body.slice(0, equals).trim());
  const value = body
    .slice(equals + 1)
    .split(/[(\n]/)[0]
    .trim()
    .toLowerCase();
  return `${name}=${value}`;
}

export interface NotesDiff {
  /** One short sentence answering this turn, when the model supplied one. */
  answer?: string;
  /** Assumptions introduced or changed this turn. */
  fresh: string[];
  /** Assumptions kept from previous turns. */
  old: string[];
}

export function diffNotes(
  previous: string[] | undefined,
  next: string[] | undefined,
): NotesDiff {
  const previousNotes = previous ?? [];
  const nextNotes = next ?? [];
  const answerCandidates = nextNotes.filter(
    (note) => !ASSUMPTION_PREFIX.test(note) && !/^[^=]+=\s*.+—/.test(note),
  );
  const answer = answerCandidates.find((note) => !previousNotes.includes(note));
  const nextAssumptions = nextNotes.filter((note) => ASSUMPTION_PREFIX.test(note));
  const uniqueKeys = new Set<string>();
  const uniqueAssumptions = nextAssumptions.filter((note) => {
    const key = assumptionKey(note);
    if (uniqueKeys.has(key)) return false;
    uniqueKeys.add(key);
    return true;
  });
  const previousKeys = new Set(
    previousNotes.filter((note) => ASSUMPTION_PREFIX.test(note)).map(assumptionKey),
  );
  const fresh = uniqueAssumptions.filter(
    (note) => !previousNotes.includes(note) && !previousKeys.has(assumptionKey(note)),
  );
  const old = uniqueAssumptions.filter((note) => !fresh.includes(note));
  return { answer, fresh, old };
}
