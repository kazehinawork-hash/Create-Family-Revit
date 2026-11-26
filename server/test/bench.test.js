import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBenchmark } from "../../bench/run.mjs";

test("benchmark stub mode runs before/after sheet-metal macro pipeline and generates report + previews", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "family-bench-"));
  try {
    const report = await runBenchmark({
      stub: true,
      mode: "both",
      runs: 1,
      limit: 4,
      out,
    });

    assert.equal(report.summary.before.cases, 4);
    assert.equal(report.summary.after.cases, 4);
    assert.equal(report.summary.after.passed, 4);
    assert.ok(
      report.summary.after.avgScore >= report.summary.before.avgScore,
      `expected after (${report.summary.after.avgScore}) >= before (${report.summary.before.avgScore})`,
    );

    assert.equal(fs.existsSync(path.join(out, "report.json")), true);
    assert.equal(fs.existsSync(path.join(out, "comparison.md")), true);
    const previews = fs.readdirSync(path.join(out, "previews")).filter((f) => f.endsWith(".png"));
    assert.equal(previews.length, 4);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
