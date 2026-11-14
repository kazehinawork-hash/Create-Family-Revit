import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./files.js";

/** File that stores group names and their order; it must never appear as a model. */
export const LIBRARY_FILE = "_library.json";
export const MAX_GROUP_NAME = 60;
/** Characters Revit refuses in a family name, which also break file paths. */
export const FORBIDDEN_GROUP_CHARS = /[\\/:*?"<>|]/;

export function isModelFile(name) {
  return (
    typeof name === "string" &&
    name.toLowerCase().endsWith(".json") &&
    !name.startsWith("_") &&
    !name.startsWith(".")
  );
}

/**
 * Trim + validate a group name. `""` is allowed and means "Chưa nhóm"; it is never
 * stored as a group entry.
 */
export function normalizeGroupName(value) {
  if (typeof value !== "string") return { error: "Tên nhóm phải là chuỗi." };
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) return { name: "" };
  if (name.length > MAX_GROUP_NAME) {
    return { error: `Tên nhóm tối đa ${MAX_GROUP_NAME} ký tự.` };
  }
  if (FORBIDDEN_GROUP_CHARS.test(name)) {
    return { error: 'Tên nhóm không được chứa các ký tự \\ / : * ? " < > |.' };
  }
  return { name };
}

function sameName(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function libraryPath(savedDir) {
  return path.join(savedDir, LIBRARY_FILE);
}

/**
 * Read the group list. Missing/corrupt file yields an empty list; duplicate names are
 * dropped and any group found on a model file is appended so no model loses its group.
 */
export function readLibrary(savedDir) {
  const groups = [];
  const seen = new Set();

  const add = (name, createdAt = Date.now()) => {
    const normalized = normalizeGroupName(name);
    if (normalized.error || !normalized.name) return false;
    const key = normalized.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    groups.push({ name: normalized.name, createdAt });
    return true;
  };

  try {
    const raw = JSON.parse(fs.readFileSync(libraryPath(savedDir), "utf8"));
    for (const entry of Array.isArray(raw?.groups) ? raw.groups : []) {
      const name = typeof entry === "string" ? entry : entry?.name;
      add(name, Number(entry?.createdAt) || Date.now());
    }
  } catch {
    // No library file yet (or unreadable): start from the model files below.
  }

  for (const summary of readModelSummaries(savedDir)) add(summary.group);

  return { groups };
}

export function writeLibrary(savedDir, state) {
  writeJsonAtomic(libraryPath(savedDir), {
    version: 1,
    groups: (state?.groups ?? []).map((group) => ({
      name: group.name,
      createdAt: group.createdAt ?? Date.now(),
    })),
  });
}

/** Add a group to the list (case-insensitive) and return the stored name. */
export function ensureGroup(savedDir, name) {
  const normalized = normalizeGroupName(name);
  if (normalized.error || !normalized.name) return normalized;

  const state = readLibrary(savedDir);
  const existing = state.groups.find((group) => sameName(group.name, normalized.name));
  if (existing) return { name: existing.name };

  state.groups.push({ name: normalized.name, createdAt: Date.now() });
  writeLibrary(savedDir, state);
  return { name: normalized.name };
}

export function renameGroup(savedDir, from, to) {
  const normalized = normalizeGroupName(to);
  if (normalized.error) return normalized;
  if (!normalized.name) return { error: "Tên nhóm không được để trống." };

  const state = readLibrary(savedDir);
  const index = state.groups.findIndex((group) => sameName(group.name, from));
  if (index === -1) return { error: "Nhóm không tồn tại.", status: 404 };

  const clash = state.groups.find(
    (group, position) => position !== index && sameName(group.name, normalized.name),
  );
  if (clash) return { error: "Nhóm đã tồn tại.", status: 400 };

  const previous = state.groups[index].name;
  state.groups[index] = { ...state.groups[index], name: normalized.name };
  writeLibrary(savedDir, state);

  // Every model in the old group moves with it.
  let updated = 0;
  for (const summary of readModelSummaries(savedDir)) {
    if (!sameName(summary.group, previous)) continue;
    const filePath = path.join(savedDir, `${summary.id}.json`);
    const data = readModelFile(filePath);
    if (!data) continue;
    data.group = normalized.name;
    writeJsonAtomic(filePath, data);
    updated += 1;
  }

  return { name: normalized.name, previous, updated };
}

/** Remove a group; its models fall back to "Chưa nhóm" and are never deleted. */
export function deleteGroup(savedDir, name) {
  const state = readLibrary(savedDir);
  const index = state.groups.findIndex((group) => sameName(group.name, name));
  if (index === -1) return { error: "Nhóm không tồn tại.", status: 404 };

  const previous = state.groups[index].name;
  state.groups.splice(index, 1);
  writeLibrary(savedDir, state);

  let updated = 0;
  for (const summary of readModelSummaries(savedDir)) {
    if (!sameName(summary.group, previous)) continue;
    const filePath = path.join(savedDir, `${summary.id}.json`);
    const data = readModelFile(filePath);
    if (!data) continue;
    data.group = "";
    writeJsonAtomic(filePath, data);
    updated += 1;
  }

  return { name: previous, updated };
}

export function readModelFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** The meta row the library grid needs, read straight from one model file. */
export function readModelSummary(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const stats = fs.statSync(filePath);
    const spec = data?.spec && typeof data.spec === "object" ? data.spec : {};
    return {
      id: path.basename(filePath).replace(/\.json$/i, ""),
      name: spec.name || data.name || path.basename(filePath),
      typeName: spec.typeName || data.typeName || "",
      category: spec.category || data.category || "Mechanical Equipment",
      lod: Number(spec.lod) || null,
      group: typeof data.group === "string" ? data.group : "",
      updatedAt: stats.mtimeMs,
      partsCount: spec.parts?.length || data.parts?.length || 0,
      paramsCount: spec.parameters?.length || data.parameters?.length || 0,
    };
  } catch {
    return null;
  }
}

export function readModelSummaries(savedDir) {
  let files;
  try {
    files = fs.readdirSync(savedDir).filter(isModelFile);
  } catch {
    return [];
  }
  return files
    .map((file) => readModelSummary(path.join(savedDir, file)))
    .filter(Boolean);
}

/** Group list plus the counts the sidebar shows. */
export function librarySnapshot(savedDir) {
  const models = readModelSummaries(savedDir).sort((a, b) => b.updatedAt - a.updatedAt);
  const state = readLibrary(savedDir);
  const groups = state.groups.map((group) => ({
    name: group.name,
    createdAt: group.createdAt,
    count: models.filter((model) => sameName(model.group, group.name)).length,
  }));

  return {
    groups,
    ungrouped: models.filter((model) => !model.group.trim()).length,
    total: models.length,
  };
}

/** Move one model between groups without writing a history revision. */
export function setModelGroup(savedDir, id, group) {
  const normalized = normalizeGroupName(group);
  if (normalized.error) return normalized;

  const filePath = path.join(savedDir, `${id}.json`);
  if (!filePath.startsWith(path.join(savedDir, path.sep)) || !fs.existsSync(filePath)) {
    return { error: "Model not found", status: 404 };
  }

  const data = readModelFile(filePath);
  if (!data) return { error: "Model file is not readable", status: 500 };

  data.group = normalized.name;
  writeJsonAtomic(filePath, data);
  if (normalized.name) ensureGroup(savedDir, normalized.name);

  return { ok: true, id, group: normalized.name };
}
