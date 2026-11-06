#!/usr/bin/env node
/**
 * Quality benchmark for generated family specs.
 *
 * Scores every spec it can find (examples, saved models, or a directory passed with
 * --specs) on the things that actually make a family usable:
 *
 *   parse  - the spec survives validation and resolves to geometry
 *   logic  - no physical-layout warnings (drain pan, inside casing, ...)
 *   drive  - how many parts are tied to parameters instead of baked numbers
 *   param  - how many declared parameters are actually used
 *
 * Usage:
 *   node scripts/eval.mjs
 *   node scripts/eval.mjs --specs spec/examples
 *   node scripts/eval.mjs --json
 *   node scripts/eval.mjs --strict      # exit 1 when any spec fails
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSpec } from "../packages/spec-core/dist/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REF = /\[([^\]]+)\]/g;

function args() {
  const out = { specs: [], json: false, strict: false };
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--strict") out.strict = true;
    else if (arg === "--specs") out.specs.push(process.argv[++i]);
    else if (!arg.startsWith("--")) out.specs.push(arg);
  }
  return out;
}

function collect(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

/** Saved models wrap the spec in { id, name, spec, entries, savedAt }. */
function loadSpec(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const spec = raw && typeof raw === "object" && raw.spec ? raw.spec : raw;
    if (!spec || typeof spec !== "object") return null;
    return { file, spec };
  } catch {
    return null;
  }
}

function references(value, into) {
  const text = JSON.stringify(value ?? null);
  for (const match of text.matchAll(REF)) into.add(match[1].trim().toLowerCase());
}

function score(analysis) {
  const { spec, model, errors, issues } = analysis;
  const parts = Array.isArray(spec.parts) ? spec.parts : [];
  const params = Array.isArray(spec.parameters) ? spec.parameters : [];

  const used = new Set();
  for (const part of parts) {
    references(part?.solid, used);
    references(part?.cuts, used);
    for (const cut of part?.cuts ?? []) references(cut, used);
  }
  for (const param of params) if (param?.formula) references(param.formula, used);

  const declared = new Set(params.map((param) => String(param?.name ?? "").trim().toLowerCase()));
  const unused = [...declared].filter((name) => name && !used.has(name));

  const partsText = JSON.stringify(parts);
  const parametricParts = parts.filter((part) => /\[[^\]]+\]/.test(JSON.stringify(part))).length;
  const driveRatio = parts.length ? parametricParts / parts.length : 0;
  const paramRatio = declared.size ? (declared.size - unused.length) / declared.size : 1;
  const logicIssues = issues.filter((issue) => issue.path.startsWith("logic."));

  const parseOk = errors.length === 0 && model.parts.length > 0;
  const passed =
    40 * (parseOk ? 1 : 0) +
    20 * (logicIssues.length === 0 ? 1 : 0) +
    20 * driveRatio +
    10 * paramRatio +
    10 * (partsText.includes("[") ? 1 : 0);

  return {
    ok: parseOk,
    score: Math.round(passed),
    parts: model.parts.length,
    instances: model.instances,
    parameters: declared.size,
    unused: unused.length,
    parametricParts,
    drivePercent: Math.round(driveRatio * 100),
    paramPercent: Math.round(paramRatio * 100),
    errors: errors.length,
    warnings: issues.length - errors.length,
    logic: logicIssues.length,
    errorSample: errors.slice(0, 2).map((issue) => `${issue.path}: ${issue.message}`),
    bounds: model.bounds
      ? [model.bounds.size.x, model.bounds.size.y, model.bounds.size.z].map((value) => Math.round(value))
      : null,
  };
}

function pad(text, width) {
  return String(text).padEnd(width);
}

function main() {
  const options = args();
  const dirs = options.specs.length
    ? options.specs.map((dir) => (path.isAbsolute(dir) ? dir : path.join(ROOT, dir)))
    : [path.join(ROOT, "spec", "examples"), path.join(ROOT, "saved-models")];

  const files = dirs.flatMap(collect);
  const rows = [];

  for (const file of files) {
    const loaded = loadSpec(file);
    if (!loaded) continue;
    const analysis = analyzeSpec(loaded.spec);
    rows.push({
      name: path.basename(file, ".json").slice(0, 34),
      ...score(analysis),
    });
  }

  if (rows.length === 0) {
    console.error("No specs found. Pass --specs <directory>.");
    process.exit(1);
  }

  const average = Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length);
  const failed = rows.filter((row) => !row.ok);

  if (options.json) {
    console.log(JSON.stringify({ average, count: rows.length, failed: failed.length, rows }, null, 2));
  } else {
    const head = [
      pad("spec", 35),
      pad("ok", 4),
      pad("score", 6),
      pad("parts", 6),
      pad("params", 7),
      pad("unused", 7),
      pad("drive%", 7),
      pad("logic", 6),
      pad("errors", 7),
    ].join("");
    console.log(head);
    console.log("-".repeat(head.length));
    for (const row of rows) {
      console.log(
        [
          pad(row.name, 35),
          pad(row.ok ? "yes" : "NO", 4),
          pad(row.score, 6),
          pad(row.parts, 6),
          pad(row.parameters, 7),
          pad(row.unused, 7),
          pad(row.drivePercent, 7),
          pad(row.logic, 6),
          pad(row.errors, 7),
        ].join(""),
      );
      for (const line of row.errorSample) console.log(`    ! ${line}`);
    }
    console.log("-".repeat(head.length));
    console.log(`${rows.length} specs · average score ${average}/100 · ${failed.length} failing`);
  }

  if (options.strict && failed.length > 0) process.exit(1);
}

main();
