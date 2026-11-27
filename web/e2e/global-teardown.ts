import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default async function globalTeardown() {
  const dataDir = process.env.E2E_DATA_DIR;
  if (!dataDir) return;

  const resolvedDataDir = path.resolve(dataDir);
  const resolvedTmp = path.resolve(os.tmpdir());
  if (!resolvedDataDir.startsWith(resolvedTmp + path.sep)) return;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(resolvedDataDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}
