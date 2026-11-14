/**
 * Section, supplement and repair turns do not need to repeat the whole family.
 * They return a patch and this module merges it into the spec the turn was given.
 *
 * A full spec is still accepted: if the answer carries `schemaVersion` and `parts`,
 * the caller keeps it untouched.
 */

const PART_KEYS = ["addParts", "updateParts", "removePartIds"];
const PARAMETER_KEYS = ["addParameters", "updateParameters"];
const CONNECTOR_KEYS = ["addConnectors", "updateConnectors"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function keyOf(item) {
  const id = typeof item?.id === "string" ? item.id.trim() : "";
  if (id) return `id:${id.toLowerCase()}`;
  const name = typeof item?.name === "string" ? item.name.trim() : "";
  return name ? `name:${name.toLowerCase()}` : "";
}

/** Recursive merge for plain objects; arrays and scalars are replaced. */
export function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) return patch;
  const out = { ...(isPlainObject(base) ? base : {}) };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) ? mergeDeep(out[key], value) : value;
  }

  return out;
}

function upsert(base, additions) {
  const out = [...base];
  const index = new Map();

  out.forEach((item, position) => {
    const key = keyOf(item);
    if (key) index.set(key, position);
  });

  for (const item of additions) {
    const key = keyOf(item);
    const position = key ? index.get(key) : undefined;

    if (position === undefined) {
      out.push(item);
      if (key) index.set(key, out.length - 1);
    } else {
      // The same id/name is an update, never a second copy.
      out[position] = mergeDeep(out[position], item);
    }
  }

  return out;
}

function updateExisting(base, updates) {
  const out = [...base];
  const index = new Map();

  out.forEach((item, position) => {
    const key = keyOf(item);
    if (key) index.set(key, position);
  });

  for (const item of updates) {
    const key = keyOf(item);
    const position = key ? index.get(key) : undefined;
    if (position === undefined) out.push(item);
    else out[position] = mergeDeep(out[position], item);
  }

  return out;
}

function removeByIds(items, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return items;
  const drop = new Set(ids.map((id) => String(id).trim().toLowerCase()).filter(Boolean));
  return items.filter((item) => {
    const id = String(item?.id ?? "").trim().toLowerCase();
    return !id || !drop.has(id);
  });
}

export function isFullSpec(value) {
  return isPlainObject(value) && Array.isArray(value.parts) && "schemaVersion" in value;
}

export function isSpecPatch(value) {
  if (!isPlainObject(value)) return false;
  return [...PART_KEYS, ...PARAMETER_KEYS, ...CONNECTOR_KEYS].some((key) => key in value);
}

/** Human-readable summary for the server log ("+6 parts, ~2 params"). */
export function describeSpecPatch(patch) {
  if (!isSpecPatch(patch)) return "không phải patch";
  const parts = isPlainObject(patch) ? list(patch.addParts).length + list(patch.updateParts).length : 0;
  const removed = Array.isArray(patch?.removePartIds) ? patch.removePartIds.length : 0;
  const params = list(patch?.addParameters).length + list(patch?.updateParameters).length;
  const connectors = list(patch?.addConnectors).length + list(patch?.updateConnectors).length;
  return `+${parts} parts, -${removed} parts, ${params} params, ${connectors} connectors`;
}

/**
 * Merge a patch into a spec. Pure: the base spec is never mutated.
 * Unknown keys are ignored so a chatty model cannot corrupt the spec.
 */
export function applySpecPatch(spec, patch) {
  if (!isPlainObject(spec) || !isPlainObject(patch)) return spec;
  // A complete spec is a valid answer to a patch request — use it as-is.
  if (isFullSpec(patch)) return patch;
  if (!isSpecPatch(patch)) return spec;

  const out = { ...spec };

  for (const key of ["name", "typeName", "description", "category", "units"]) {
    if (typeof patch[key] === "string" && patch[key].trim()) out[key] = patch[key];
  }

  const parts = updateExisting(
    upsert(Array.isArray(spec.parts) ? spec.parts : [], list(patch.addParts)),
    list(patch.updateParts),
  );
  out.parts = removeByIds(parts, patch.removePartIds);

  out.parameters = updateExisting(
    upsert(Array.isArray(spec.parameters) ? spec.parameters : [], list(patch.addParameters)),
    list(patch.updateParameters),
  );

  const connectors = updateExisting(
    upsert(Array.isArray(spec.connectors) ? spec.connectors : [], list(patch.addConnectors)),
    list(patch.updateConnectors),
  );
  out.connectors = connectors;

  if (Array.isArray(patch.materials)) {
    out.materials = upsert(Array.isArray(spec.materials) ? spec.materials : [], list(patch.materials));
  }

  if (Array.isArray(patch.notes)) {
    const notes = Array.isArray(spec.notes) ? [...spec.notes] : [];
    for (const note of patch.notes) {
      if (typeof note === "string" && note.trim() && !notes.includes(note)) notes.push(note);
    }
    out.notes = notes;
  }

  return out;
}
