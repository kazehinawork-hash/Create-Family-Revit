import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";
import { writeJsonAtomic } from "./files.js";
import { forgetJob, JOBS_DIR } from "./jobs.js";
import { cleanupTrash } from "./trash.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuses that mean the job will never run again. */
const FINISHED_STATUSES = new Set(["done", "succeeded", "failed", "error", "cancelled"]);
/** Statuses that still expect work; a very old one is a leftover from a restart. */
const ACTIVE_STATUSES = new Set(["queued", "running", "awaiting_revit"]);

export const ABANDONED_MESSAGE = "Bị bỏ dở";

/**
 * Remove finished jobs after their retention window and flag jobs that were left
 * running by a restart. Files only: the in-memory map is cleared through `forget`.
 */
export function cleanupJobs({
  dir = JOBS_DIR,
  now = Date.now(),
  ttlDays = config.agent.jobTtlDays,
  stuckHours = 24,
  forget = forgetJob,
} = {}) {
  const result = { removed: 0, abandoned: 0 };

  let files;
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith(".json") && !file.startsWith("_"));
  } catch {
    return result;
  }

  for (const file of files) {
    const filePath = path.join(dir, file);
    let job;
    try {
      job = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }

    const stamp = Date.parse(job?.updated_at || job?.created_at || "");
    if (!Number.isFinite(stamp)) continue;
    const age = now - stamp;
    const id = job.job_id || file.replace(/\.json$/, "");

    if (ACTIVE_STATUSES.has(job.status) && age > stuckHours * 60 * 60 * 1000) {
      job.status = "error";
      job.error = ABANDONED_MESSAGE;
      job.updated_at = new Date(now).toISOString();
      try {
        writeJsonAtomic(filePath, job);
        result.abandoned += 1;
      } catch {
        // A locked file is retried on the next run.
      }
      continue;
    }

    if (FINISHED_STATUSES.has(job.status) && age > ttlDays * DAY_MS) {
      try {
        fs.rmSync(filePath, { force: true });
        forget?.(id);
        result.removed += 1;
      } catch {
        // A locked file is retried on the next run.
      }
    }
  }

  return result;
}

/**
 * Delete uploaded datasheets that no saved model references any more. A file that a
 * saved model still points at is always kept, however old it is.
 */
export function cleanupUploads({
  dir = config.dirs.uploads,
  savedDir = config.dirs.saved,
  now = Date.now(),
  ttlDays = 14,
} = {}) {
  const result = { removed: 0 };

  const referenced = new Set();
  try {
    const addReferences = (text) => {
      for (const match of text.matchAll(
        /["']([^"']+\.(?:pdf|png|jpe?g|webp|docx?|xlsx?|csv|txt))["']/gi,
      )) {
        referenced.add(path.basename(match[1]));
      }
    };

    for (const file of fs.readdirSync(savedDir)) {
      if (!file.endsWith(".json") || file.startsWith("_")) continue;
      try {
        addReferences(fs.readFileSync(path.join(savedDir, file), "utf8"));
      } catch {
        // An unreadable model must not make its uploads deletable.
        return result;
      }
    }

    // Trashed models still own their attachments until they are purged.
    try {
      const trashRoot = path.join(savedDir, ".trash");
      for (const entry of fs.readdirSync(trashRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(trashRoot, entry.name);
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith(".json") || file === "meta.json") continue;
          try {
            addReferences(fs.readFileSync(path.join(dir, file), "utf8"));
          } catch {
            return result;
          }
        }
      }
    } catch {
      /* no trash folder yet */
    }
  } catch {
    return result;
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || referenced.has(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    try {
      if (now - fs.statSync(filePath).mtimeMs <= ttlDays * DAY_MS) continue;
      fs.rmSync(filePath, { force: true });
      result.removed += 1;
    } catch {
      // Locked or already gone: the next run retries.
    }
  }

  return result;
}

/** Keep only the newest `keep` revision files (ISO names sort oldest first). */
export function pruneHistoryDir(dir, keep) {
  if (!keep || keep <= 0) return { removed: 0 };

  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json") && !file.startsWith("."))
      .sort();
  } catch {
    return { removed: 0 };
  }

  let removed = 0;
  for (const file of files.slice(0, Math.max(0, files.length - keep))) {
    try {
      fs.rmSync(path.join(dir, file), { force: true });
      removed += 1;
    } catch {
      // Retried on the next maintenance run.
    }
  }
  return { removed };
}

/** Trim every live model's .history folder; trashed histories are left untouched. */
export function pruneHistories({ savedDir = config.dirs.saved, keep = config.agent.historyKeep } = {}) {
  if (!keep || keep <= 0) return { removed: 0 };

  let entries;
  try {
    entries = fs.readdirSync(path.join(savedDir, ".history"), { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    removed += pruneHistoryDir(path.join(savedDir, ".history", entry.name), keep).removed;
  }
  return { removed };
}

/** Startup + six-hourly maintenance; one line in the server log. */
export function runCleanup(logger = console) {
  const jobs = cleanupJobs();
  const uploads = cleanupUploads();
  const trash = cleanupTrash(config.dirs.saved, { ttlDays: config.agent.trashTtlDays });
  const history = pruneHistories();
  logger.log(
    `[cleanup] jobs removed=${jobs.removed} abandoned=${jobs.abandoned} ` +
      `uploads removed=${uploads.removed} trash removed=${trash.removed} ` +
      `history removed=${history.removed}`,
  );
  return {
    ...jobs,
    uploads: uploads.removed,
    trash: trash.removed,
    history: history.removed,
  };
}

export const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
