/**
 * Section, supplement and repair turns do not need to repeat the whole family.
 * They return a patch and this module merges it into the spec the turn was given.
 *
 * A full spec is still accepted: if the answer carries `schemaVersion` and `parts`,
 * the caller keeps it untouched.
 */

const PART_KEYS = ["addParts", "updateParts", "removePartIds"];
const MACRO_KEYS = ["macros", "addMacros", "updateMacros", "removeMacroIds"];
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
  return (
    isPlainObject(value) &&
    (Array.isArray(value.parts) || Array.isArray(value.macros)) &&
    "schemaVersion" in value
  );
}

export function isSpecPatch(value) {
  if (!isPlainObject(value)) return false;
  return [...PART_KEYS, ...MACRO_KEYS, ...PARAMETER_KEYS, ...CONNECTOR_KEYS].some(
    (key) => key in value,
  );
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

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) sorted[key] = canonicalValue(value[key]);
    }
    return sorted;
  }
  if (typeof value === "string") return value.trim();
  return value;
}

function geometrySignature(part) {
  if (!isPlainObject(part?.solid)) return "";
  return JSON.stringify({
    solid: canonicalValue(part.solid),
    cuts: Array.isArray(part.cuts) && part.cuts.length > 0 ? canonicalValue(part.cuts) : null,
    array: isPlainObject(part.array) ? canonicalValue(part.array) : null,
  });
}

function numericPartBox(part) {
  const solid = part?.solid;
  if (!isPlainObject(solid)) return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  if (solid.kind === "box" && solid.origin && solid.size) {
    const ox = num(solid.origin.x), oy = num(solid.origin.y), oz = num(solid.origin.z);
    const sx = num(solid.size.x), sy = num(solid.size.y), sz = num(solid.size.z);
    if ([ox, oy, oz, sx, sy, sz].some((v) => v === null) || sx <= 0 || sy <= 0 || sz <= 0) return null;
    return {
      min: [ox - sx / 2, oy - sy / 2, oz],
      max: [ox + sx / 2, oy + sy / 2, oz + sz],
    };
  }
  if ((solid.kind === "cylinder" || solid.kind === "frustum") && solid.base) {
    const bx = num(solid.base.x), by = num(solid.base.y), bz = num(solid.base.z);
    const r =
      num(solid.radius) ??
      Math.max(num(solid.radiusBottom) ?? 0, num(solid.radiusTop) ?? 0);
    const h = num(solid.height);
    if ([bx, by, bz, r, h].some((v) => v === null) || r <= 0 || h === 0) return null;
    const axis = solid.axis || "z";
    const h0 = Math.min(0, h);
    const h1 = Math.max(0, h);
    if (axis === "x") return { min: [bx + h0, by - r, bz - r], max: [bx + h1, by + r, bz + r] };
    if (axis === "y") return { min: [bx - r, by + h0, bz - r], max: [bx + r, by + h1, bz + r] };
    return { min: [bx - r, by - r, bz + h0], max: [bx + r, by + r, bz + h1] };
  }
  return null;
}

function boxesStronglyOverlap(a, b) {
  if (!a || !b) return false;
  let intersectVol = 1;
  let volA = 1;
  let volB = 1;
  for (let i = 0; i < 3; i += 1) {
    const overlap = Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]);
    if (overlap <= 0) return false;
    intersectVol *= overlap;
    volA *= Math.max(1e-6, a.max[i] - a.min[i]);
    volB *= Math.max(1e-6, b.max[i] - b.min[i]);
  }
  const unionVol = volA + volB - intersectVol;
  return unionVol > 0 && intersectVol / unionVol >= 0.35;
}

function uniqueKeyMap(items, keyFn) {
  const counts = new Map();
  const positions = new Map();
  items.forEach((item, position) => {
    const key = keyFn(item);
    if (!key) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    positions.set(key, position);
  });
  return { counts, positions };
}

/**
 * Detect when a repair patch tries to re-emit a parallel translated copy of the
 * existing model via `addParts` (leaving `updateParts` and `removePartIds` empty
 * while placing new parts directly on top of the majority of existing parts).
 */
export function isOverlappingRepairDuplicatePatch(spec, patch) {
  if (!isPlainObject(spec) || !isPlainObject(patch)) return false;
  if (isFullSpec(patch) || !isSpecPatch(patch)) return false;

  const baseParts = Array.isArray(spec.parts) ? spec.parts : [];
  if (baseParts.length < 2) return false;

  const removeIds = Array.isArray(patch.removePartIds)
    ? patch.removePartIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const updates = list(patch.updateParts);
  const additions = list(patch.addParts);
  if (removeIds.length > 0 || updates.length > 0 || additions.length < Math.max(2, Math.ceil(baseParts.length * 0.6))) {
    return false;
  }

  const baseIds = new Set(
    baseParts.map((part) => (typeof part?.id === "string" ? part.id.trim().toLowerCase() : "")).filter(Boolean),
  );
  if (additions.some((part) => {
    const id = typeof part?.id === "string" ? part.id.trim().toLowerCase() : "";
    return id && baseIds.has(id);
  })) {
    return false;
  }

  const usedBase = new Set();
  let overlapMatches = 0;
  for (const addPart of additions) {
    const addBox = numericPartBox(addPart);
    const addSig = geometrySignature(addPart);
    const matchIdx = baseParts.findIndex((basePart, idx) => {
      if (usedBase.has(idx)) return false;
      if (addSig && geometrySignature(basePart) === addSig) return true;
      if (addPart?.solid?.kind && addPart.solid.kind === basePart?.solid?.kind) {
        return boxesStronglyOverlap(addBox, numericPartBox(basePart));
      }
      return false;
    });
    if (matchIdx !== -1) {
      usedBase.add(matchIdx);
      overlapMatches += 1;
    }
  }

  return overlapMatches >= Math.max(2, Math.ceil(baseParts.length * 0.6));
}

function mergeParts(baseParts, { add = [], update = [], removeIds = [] } = {}, mode = "edit") {
  const out = [...baseParts];
  const idIndex = new Map();
  out.forEach((item, position) => {
    const id = typeof item?.id === "string" ? item.id.trim().toLowerCase() : "";
    if (id) idIndex.set(id, position);
  });

  const baseNames = uniqueKeyMap(out, (item) =>
    typeof item?.name === "string" ? item.name.trim().toLowerCase() : "",
  );
  const baseGeoms = uniqueKeyMap(out, geometrySignature);
  const matchedBasePositions = new Set();

  const findMatchPosition = (item, { allowName = false, allowGeometry = false } = {}) => {
    const id = typeof item?.id === "string" ? item.id.trim().toLowerCase() : "";
    if (id && idIndex.has(id)) return idIndex.get(id);

    if (allowName) {
      const name = typeof item?.name === "string" ? item.name.trim().toLowerCase() : "";
      if (name && baseNames.counts.get(name) === 1) {
        return baseNames.positions.get(name);
      }
    }

    if (allowGeometry) {
      const sig = geometrySignature(item);
      if (sig && baseGeoms.counts.get(sig) === 1) {
        const position = baseGeoms.positions.get(sig);
        if (!matchedBasePositions.has(position)) return position;
      }
    }

    return undefined;
  };

  for (const item of add) {
    const position = findMatchPosition(item, {
      allowName: mode === "repair",
      allowGeometry: mode === "repair",
    });
    if (position === undefined) {
      out.push(item);
      const id = typeof item?.id === "string" ? item.id.trim().toLowerCase() : "";
      if (id) idIndex.set(id, out.length - 1);
    } else {
      matchedBasePositions.add(position);
      out[position] = mergeDeep(out[position], item);
    }
  }

  for (const item of update) {
    const position = findMatchPosition(item, { allowName: true });
    if (position === undefined) {
      out.push(item);
      const id = typeof item?.id === "string" ? item.id.trim().toLowerCase() : "";
      if (id) idIndex.set(id, out.length - 1);
    } else {
      matchedBasePositions.add(position);
      out[position] = mergeDeep(out[position], item);
    }
  }

  return removeByIds(out, removeIds);
}

/**
 * Merge a patch into a spec. Pure: the base spec is never mutated.
 * Unknown keys are ignored so a chatty model cannot corrupt the spec.
 */
export function applySpecPatch(spec, patch, options = {}) {
  if (!isPlainObject(spec) || !isPlainObject(patch)) return spec;
  // A complete spec is a valid answer to a patch request — use it as-is.
  if (isFullSpec(patch)) return patch;
  if (!isSpecPatch(patch)) return spec;

  const mode = options.mode || "edit";
  const out = { ...spec };

  for (const key of ["name", "typeName", "description", "category", "units"]) {
    if (typeof patch[key] === "string" && patch[key].trim()) out[key] = patch[key];
  }

  out.parts = mergeParts(
    Array.isArray(spec.parts) ? spec.parts : [],
    {
      add: list(patch.addParts),
      update: list(patch.updateParts),
      removeIds: patch.removePartIds,
    },
    mode,
  );

  out.parameters = updateExisting(
    upsert(Array.isArray(spec.parameters) ? spec.parameters : [], list(patch.addParameters)),
    list(patch.updateParameters),
  );

  const connectors = updateExisting(
    upsert(Array.isArray(spec.connectors) ? spec.connectors : [], list(patch.addConnectors)),
    list(patch.updateConnectors),
  );
  out.connectors = connectors;

  if (Array.isArray(patch.macros)) {
    out.macros = list(patch.macros);
  } else if (
    Array.isArray(patch.addMacros) ||
    Array.isArray(patch.updateMacros) ||
    Array.isArray(patch.removeMacroIds)
  ) {
    const macros = updateExisting(
      upsert(Array.isArray(spec.macros) ? spec.macros : [], list(patch.addMacros)),
      list(patch.updateMacros),
    );
    out.macros = removeByIds(macros, patch.removeMacroIds);
  }

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
