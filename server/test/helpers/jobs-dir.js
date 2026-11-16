import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A throwaway job store for one test process. Import this FIRST (before anything
 * that touches config/jobs) so FAMILY_JOBS_DIR is set before the modules load.
 * The directory is removed when the test process exits.
 */
export const TEST_JOBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "family-agent-jobs-"));

process.env.FAMILY_JOBS_DIR = TEST_JOBS_DIR;

process.once("exit", () => {
  try {
    fs.rmSync(TEST_JOBS_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
