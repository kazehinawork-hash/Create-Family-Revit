#!/usr/bin/env node
/**
 * Cross-language parity check: resolve every spec/examples file with the TS
 * resolver and with the C# Core resolver, then compare part counts and bounds.
 *
 *   npm run parity
 *
 * The C# side is dumped by FamilyAgent.SelfTest --dump-parity. Keeping this in
 * CI catches a primitive that works in the studio but drifts in the add-in.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSpec, partBounds } from "../packages/spec-core/dist/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = path.join(ROOT, "spec", "examples");
const SELF_TEST = path.join(
  ROOT,
  "revit-addin",
  "FamilyAgent.SelfTest",
  "bin",
  "Release",
  "net8.0",
  "FamilyAgent.SelfTest.dll",
);
const TOLERANCE_MM = 0.01;

function dumpCSharp() {
  if (!process.argv.includes("--no-build")) {
    execFileSync(
      "dotnet",
      [
        "build",
        path.join(ROOT, "revit-addin", "FamilyAgent.SelfTest", "FamilyAgent.SelfTest.csproj"),
        "-c",
        "Release",
      ],
      { cwd: ROOT, stdio: "inherit" },
    );
  }

  const output = execFileSync("dotnet", [SELF_TEST, "--dump-parity"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const start = output.indexOf("[");
  if (start < 0) throw new Error("C# parity dump did not return JSON");
  return JSON.parse(output.slice(start));
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function diffAxis(a, b) {
  return Math.max(
    Math.abs(Number(a?.x ?? 0) - Number(b?.x ?? 0)),
    Math.abs(Number(a?.y ?? 0) - Number(b?.y ?? 0)),
    Math.abs(Number(a?.z ?? 0) - Number(b?.z ?? 0)),
  );
}

function compare(csharp) {
  const rows = [];
  const failures = [];

  for (const entry of csharp) {
    const filePath = path.join(EXAMPLES, entry.file);
    const tsAnalysis = analyzeSpec(JSON.parse(fs.readFileSync(filePath, "utf8")));
    const tsBounds = tsAnalysis.model.bounds;
    const tsParts = new Map(tsAnalysis.model.parts.map((part) => [part.id, part]));

    const problems = [];
    if (entry.ok !== tsAnalysis.ok) problems.push(`ok ${entry.ok}/${tsAnalysis.ok}`);
    if (entry.parts !== tsAnalysis.model.parts.length) {
      problems.push(`parts ${entry.parts}/${tsAnalysis.model.parts.length}`);
    }
    if (entry.instances !== tsAnalysis.model.instances) {
      problems.push(`instances ${entry.instances}/${tsAnalysis.model.instances}`);
    }
    if (entry.parameters !== tsAnalysis.parameters.parameters.length) {
      problems.push(`params ${entry.parameters}/${tsAnalysis.parameters.parameters.length}`);
    }

    const boundsDelta = tsBounds
      ? Math.max(
          diffAxis(entry.bounds?.min, tsBounds.min),
          diffAxis(entry.bounds?.max, tsBounds.max),
        )
      : 0;
    if (boundsDelta > TOLERANCE_MM) problems.push(`bounds Δ${boundsDelta.toFixed(3)}`);

    let maxPartDelta = 0;
    for (const part of entry.partBounds ?? []) {
      const tsPart = tsParts.get(part.id);
      if (!tsPart) {
        problems.push(`C# part ${part.id} missing in TS`);
        continue;
      }
      const tsPartBounds = partBounds(tsPart);
      maxPartDelta = Math.max(
        maxPartDelta,
        diffAxis(part.min, tsPartBounds.min),
        diffAxis(part.max, tsPartBounds.max),
      );
    }
    if (maxPartDelta > TOLERANCE_MM) {
      problems.push(`part bounds Δ${maxPartDelta.toFixed(3)}`);
    }

    rows.push({
      file: entry.file,
      parts: `${entry.parts}/${tsAnalysis.model.parts.length}`,
      instances: `${entry.instances}/${tsAnalysis.model.instances}`,
      params: `${entry.parameters}/${tsAnalysis.parameters.parameters.length}`,
      boundsDelta,
      maxPartDelta,
      ok: problems.length === 0,
    });
    if (problems.length > 0) failures.push({ file: entry.file, problems });
  }

  return { rows, failures };
}

const csharp = dumpCSharp();
const { rows, failures } = compare(csharp);

console.log(
  [
    pad("spec", 26),
    pad("parts", 9),
    pad("inst", 9),
    pad("params", 10),
    pad("bounds Δ", 11),
    pad("part Δ", 10),
    "result",
  ].join(""),
);
console.log("-".repeat(86));
for (const row of rows) {
  console.log(
    [
      pad(row.file, 26),
      pad(row.parts, 9),
      pad(row.instances, 9),
      pad(row.params, 10),
      pad(row.boundsDelta.toFixed(3), 11),
      pad(row.maxPartDelta.toFixed(3), 10),
      row.ok ? "PASS" : "FAIL",
    ].join(""),
  );
}
console.log("-".repeat(86));

if (failures.length > 0) {
  console.error(`\n${failures.length} parity mismatch${failures.length === 1 ? "" : "es"}:`);
  for (const failure of failures) {
    console.error(`- ${failure.file}: ${failure.problems.join(", ")}`);
  }
  process.exit(1);
}

console.log(`${rows.length} specs · TS and C# resolvers agree within ${TOLERANCE_MM} mm`);
