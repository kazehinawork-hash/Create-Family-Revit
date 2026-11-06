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
  fs.renameSync(temp, file);
}
