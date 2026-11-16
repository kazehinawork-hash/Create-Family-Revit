import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./files.js";
import { ensureGroup, readLibrary } from "./library.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const TRASH_DIR = ".trash";

/** Ids are file names: reject anything that could escape saved-models. */
export function isSafeModelId(id) {
  const value = String(id ?? "");
  return (
    value.length > 0 &&
    value.length <= 200 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    /^[\w.\- ]+$/.test(value)
  );
}

function trashDir(savedDir, key) {
  return path.join(savedDir, TRASH_DIR, key);
}

/** Trash keys are `<id>__<deletedAt>`; legacy entries are just `<id>`. */
export function isSafeTrashKey(key) {
  const value = String(key ?? "");
  if (!value || value.length > 220 || value.includes("..") || value.includes("/") || value.includes("\\")) {
    return false;
  }
  return /^[\w.\- ]+(__\d+)?$/.test(value);
}

function splitTrashKey(key) {
  const match = /^(.+)__(\d+)$/.exec(key);
  if (!match) return { id: key, dirName: key };
  return { id: match[1], dirName: key };
}

/** One trash folder, decoded from its key. */
export function resolveTrashEntry(savedDir, key) {
  if (!isSafeTrashKey(key)) return null;
  const dir = trashDir(savedDir, key);
  if (!fs.existsSync(dir)) return null;
  const meta = readMeta(dir);
  const { id } = splitTrashKey(key);
  return { key, dir, id: meta?.id || id, meta };
}

function movePath(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
  return true;
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Move a saved model into saved-models/.trash/<id>/ instead of deleting it.
 * The model file, its thumbnail and its history all travel together.
 */
export function trashModel(savedDir, id, { group = "", now = Date.now() } = {}) {
  if (!isSafeModelId(id)) return { error: "ID mô hình không hợp lệ.", status: 400 };

  const file = path.join(savedDir, `${id}.json`);
  if (!fs.existsSync(file)) return { error: "Model not found", status: 404 };

  let name = id;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    name = data.spec?.name || data.name || id;
  } catch {
    /* the file is still moved; the name falls back to the id */
  }

  const dir = trashDir(savedDir, `${id}__${now}`);
  const key = `${id}__${now}`;
  const meta = { key, id, name, deletedAt: now, group: group || "" };
  writeJsonAtomic(path.join(dir, "meta.json"), meta);

  movePath(file, path.join(dir, `${id}.json`));
  movePath(path.join(savedDir, `${id}.thumb.jpg`), path.join(dir, `${id}.thumb.jpg`));
  movePath(path.join(savedDir, ".history", id), path.join(dir, "history"));

  return { ok: true, key, id, deletedAt: now, group: meta.group };
}

/** Trash entries, newest first, with the remaining days computed from the TTL. */
export function listTrash(savedDir, { ttlDays = 30, now = Date.now() } = {}) {
  const root = path.join(savedDir, TRASH_DIR);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const resolved = resolveTrashEntry(savedDir, entry.name);
    if (!resolved) continue;

    const { key, id } = resolved;
    const meta = resolved.meta ?? { id, name: id, deletedAt: 0, group: "" };
    const deletedAt = Number(meta.deletedAt) || 0;
    const remainingMs = deletedAt + ttlDays * DAY_MS - now;
    const hasThumbnail =
      fs.existsSync(path.join(resolved.dir, `${id}.thumb.jpg`)) ||
      fs.existsSync(path.join(resolved.dir, `${entry.name}.thumb.jpg`));

    items.push({
      key,
      id,
      name: meta.name || id,
      deletedAt,
      group: meta.group || "",
      daysLeft: Math.max(0, Math.ceil(remainingMs / DAY_MS)),
      hasThumbnail,
      thumbUrl: hasThumbnail ? `/api/trash/${encodeURIComponent(key)}/thumb` : null,
    });
  }
  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Put a trashed model back where it was. Never overwrites an existing file. */
export function restoreModel(savedDir, key) {
  const resolved = resolveTrashEntry(savedDir, key);
  if (!resolved) {
    return {
      error: isSafeTrashKey(key) ? "Không tìm thấy mục trong thùng rác." : "ID mô hình không hợp lệ.",
      status: isSafeTrashKey(key) ? 404 : 400,
    };
  }

  const { dir, id } = resolved;
  const file = path.join(savedDir, `${id}.json`);
  if (fs.existsSync(file)) {
    return {
      error: `Đã có model cùng ID "${id}" trong thư viện; đổi tên hoặc xoá model đó trước khi khôi phục.`,
      status: 409,
    };
  }

  const meta = resolved.meta ?? { group: "" };
  movePath(path.join(dir, `${id}.json`), file);
  movePath(path.join(dir, `${id}.thumb.jpg`), path.join(savedDir, `${id}.thumb.jpg`));
  movePath(path.join(dir, "history"), path.join(savedDir, ".history", id));

  // A group that was deleted while the model sat in the trash cannot come back.
  const groups = readLibrary(savedDir).groups;
  const stillExists = groups.some(
    (group) => group.name.toLowerCase() === String(meta.group ?? "").trim().toLowerCase(),
  );
  const group = stillExists ? meta.group : "";

  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.group = group;
    writeJsonAtomic(file, data);
  } catch {
    /* keep the file as it was if it cannot be parsed */
  }
  if (group) ensureGroup(savedDir, group);

  fs.rmSync(path.join(dir, "meta.json"), { force: true });
  try {
    fs.rmdirSync(dir);
  } catch {
    /* a stray file keeps the folder; it is harmless */
  }

  return { ok: true, id, key, group };
}

/** Permanently delete one trash entry. */
export function purgeTrash(savedDir, key) {
  const resolved = resolveTrashEntry(savedDir, key);
  if (!resolved) {
    return {
      error: isSafeTrashKey(key) ? "Không tìm thấy mục trong thùng rác." : "ID mô hình không hợp lệ.",
      status: isSafeTrashKey(key) ? 404 : 400,
    };
  }
  fs.rmSync(resolved.dir, { recursive: true, force: true });
  return { ok: true, key, id: resolved.id };
}

/** Empty the whole trash folder. */
export function purgeAllTrash(savedDir) {
  const root = path.join(savedDir, TRASH_DIR);
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      removed += 1;
    }
  } catch {
    /* nothing to empty */
  }
  return { ok: true, removed };
}

/** Delete trash entries older than the retention window. */
export function cleanupTrash(savedDir, { ttlDays = 30, now = Date.now() } = {}) {
  const root = path.join(savedDir, TRASH_DIR);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const meta = readMeta(dir);
    const deletedAt = Number(meta?.deletedAt) || 0;
    if (!deletedAt || deletedAt + ttlDays * DAY_MS > now) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* retried on the next maintenance run */
    }
  }
  return { removed };
}
