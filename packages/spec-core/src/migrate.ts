/**
 * Versioned spec migration for legacy saved families.
 *
 * Old saved models may predate `specVersion`, miss required arrays/fields, or carry
 * corrupted formula strings produced by earlier auto-heal regexes (e.g. `1mm0mm`).
 * `migrateSpec` produces a clean copy in memory without touching the file on disk.
 */

export const CURRENT_SPEC_VERSION = 2;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Repair doubled/split unit suffixes left by legacy regexes, e.g. `1mm0mm` -> `10mm`. */
export function repairCorruptedUnits(expression: string): string {
  return expression
    .replace(/(\d+)\s*(mm|cm|ft|in|deg|m)\s*(\d+(?:\.\d+)?)\s*\2\b/gi, "$1$3$2")
    .replace(/(\d+(?:\.\d+)?)(mm|cm|ft|in|deg|m)\s+\2\b/gi, "$1$2")
    .replace(/(\d+(?:\.\d+)?)(mm|cm|ft|in|deg)\2\b/gi, "$1$2");
}

function walkExpressionStrings(value: unknown, changes: string[], path: string): unknown {
  if (typeof value === "string") {
    const repaired = repairCorruptedUnits(value);
    if (repaired !== value) {
      changes.push(`${path}: repaired corrupted unit expression`);
    }
    return repaired;
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => walkExpressionStrings(item, changes, `${path}[${idx}]`));
  }
  if (isRecord(value)) {
    const out: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      // Never touch descriptive metadata strings; only numeric/formula fields.
      if (key === "id" || key === "name" || key === "material" || key === "color" || key === "from") {
        out[key] = entry;
      } else {
        out[key] = walkExpressionStrings(entry, changes, `${path}.${key}`);
      }
    }
    return out;
  }
  return value;
}

export interface MigrationResult {
  spec: JsonRecord;
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
  changes: string[];
}

export function migrateSpec(raw: unknown): MigrationResult {
  if (!isRecord(raw)) {
    return {
      spec: {},
      migrated: false,
      fromVersion: 1,
      toVersion: CURRENT_SPEC_VERSION,
      changes: [],
    };
  }

  const rawVersion = typeof raw.specVersion === "number" && Number.isFinite(raw.specVersion)
    ? raw.specVersion
    : 1;

  if (
    rawVersion >= CURRENT_SPEC_VERSION &&
    raw.schemaVersion === "1.0" &&
    raw.units === "mm" &&
    Array.isArray(raw.parameters) &&
    Array.isArray(raw.parts)
  ) {
    return {
      spec: raw,
      migrated: false,
      fromVersion: rawVersion,
      toVersion: CURRENT_SPEC_VERSION,
      changes: [],
    };
  }

  const changes: string[] = [];
  const next: JsonRecord = structuredClone(raw);

  if (next.schemaVersion !== "1.0") {
    changes.push(`schemaVersion: ${String(next.schemaVersion ?? "missing")} -> "1.0"`);
    next.schemaVersion = "1.0";
  }

  if (next.units !== "mm") {
    changes.push(`units: ${String(next.units ?? "missing")} -> "mm"`);
    next.units = "mm";
  }

  if (!Array.isArray(next.parameters)) {
    changes.push("parameters: normalized to []");
    next.parameters = [];
  } else {
    next.parameters = next.parameters.map((param, idx) => {
      if (!isRecord(param) || typeof param.formula !== "string") return param;
      const fixed = repairCorruptedUnits(param.formula);
      if (fixed === param.formula) return param;
      changes.push(`parameters[${idx}].formula: repaired corrupted unit expression`);
      return { ...param, formula: fixed };
    });
  }

  if (!Array.isArray(next.parts)) {
    changes.push("parts: normalized to []");
    next.parts = [];
  } else {
    next.parts = next.parts.map((part, idx) => {
      if (!isRecord(part)) return part;
      const updated: JsonRecord = { ...part };
      if (!Array.isArray(updated.cuts)) {
        updated.cuts = [];
      }
      if (updated.solid !== undefined) {
        updated.solid = walkExpressionStrings(updated.solid, changes, `parts[${idx}].solid`);
      }
      if (Array.isArray(updated.cuts) && updated.cuts.length > 0) {
        updated.cuts = walkExpressionStrings(updated.cuts, changes, `parts[${idx}].cuts`);
      }
      if (updated.array !== undefined) {
        updated.array = walkExpressionStrings(updated.array, changes, `parts[${idx}].array`);
      }
      return updated;
    });
  }

  if (Array.isArray(next.connectors)) {
    next.connectors = next.connectors.map((conn, idx) =>
      walkExpressionStrings(conn, changes, `connectors[${idx}]`),
    );
  }

  if (Array.isArray(next.macros)) {
    next.macros = next.macros.map((macro, idx) =>
      walkExpressionStrings(macro, changes, `macros[${idx}]`),
    );
  }

  if (rawVersion < CURRENT_SPEC_VERSION) {
    changes.push(`specVersion: ${rawVersion} -> ${CURRENT_SPEC_VERSION}`);
  }
  next.specVersion = CURRENT_SPEC_VERSION;

  return {
    spec: next,
    migrated: changes.length > 0 || rawVersion < CURRENT_SPEC_VERSION,
    fromVersion: rawVersion,
    toVersion: CURRENT_SPEC_VERSION,
    changes,
  };
}
