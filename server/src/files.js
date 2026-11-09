import fs from "node:fs";
import path from "node:path";

/**
 * Writes JSON through a temp file + rename so a crash mid-write cannot leave a
 * half-serialised model or revision behind.
 */
export function writeJsonAtomic(file, value, space = 2) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });

  const temp = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );

  fs.writeFileSync(temp, JSON.stringify(value, null, space), "utf8");

  // On Windows/OneDrive, file synchronization locks recently created temp files,
  // causing fs.renameSync to intermittently throw EPERM / EBUSY.
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    if (err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES")) {
      try {
        fs.copyFileSync(temp, file);
        try { fs.unlinkSync(temp); } catch {}
        return;
      } catch {
        // Fall back to direct write if rename and copy both fail
        fs.writeFileSync(file, JSON.stringify(value, null, space), "utf8");
        try { fs.unlinkSync(temp); } catch {}
        return;
      }
    }
    throw err;
  }
}
