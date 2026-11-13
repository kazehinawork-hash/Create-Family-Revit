import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { analyzeSpec } from "@family/spec-core";

import {
  buildSupplementPrompt,
  checkCompleteness,
  extractChecklistHeuristic,
  isComplexPrompt,
} from "../src/checklist.js";
import { crossSpec } from "../src/templates/cable-ladder.js";

const PROMPT = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "cross-prompt.txt"), "utf8");
const BROKEN = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "cross-broken.json"), "utf8"),
);

test("checklist: the user's cross prompt yields corners, rungs, connectors, parameters", () => {
  const checklist = extractChecklistHeuristic(PROMPT);

  assert.equal(checklist.family, "cross");
  assert.equal(checklist.connectors, 4);
  assert.equal(checklist.requiresMaterials, true);
  assert.equal(checklist.complex, true);

  const byRole = Object.fromEntries(checklist.groups.map((group) => [group.role, group.expected]));
  assert.equal(byRole.corner, 4);
  assert.equal(byRole.rung, 6);

  const values = Object.fromEntries(checklist.parameters.map((entry) => [entry.name, entry.value]));
  assert.equal(values["Ladder Width 1"], 400);
  assert.equal(values["Ladder Width 2"], 400);
  assert.equal(values["Ladder Height"], 100);
  assert.equal(values["Tangent Length"], 120);
  assert.equal(values["Miter Offset"], 150);
  assert.equal(values["Sheet Thickness"], 1.8);
});

test("completeness: the broken rung-only spec is missing 4 walls and 4 connectors", () => {
  const checklist = extractChecklistHeuristic(PROMPT);
  const analysis = analyzeSpec(BROKEN);
  const bounds = analysis.model.bounds.size;

  const result = checkCompleteness(BROKEN, checklist, { bounds });
  assert.equal(result.ok, false);

  const corner = result.missing.find((item) => item.role === "corner");
  assert.ok(corner, "corner walls are reported missing");
  assert.equal(corner.expected, 4);
  assert.equal(corner.actual, 0);

  const connectors = result.missing.find((item) => item.kind === "connectors");
  assert.ok(connectors);
  assert.equal(connectors.expected, 4);
  assert.equal(connectors.actual, 0);

  // Six rungs exist, so that group must NOT be reported.
  assert.ok(!result.missing.some((item) => item.role === "rung"));
  // Height is 15 mm -> the vertical walls are missing.
  assert.ok(result.missing.some((item) => item.kind === "bounds"));
});

test("completeness: the cross template satisfies the checklist and the bounds", () => {
  const checklist = extractChecklistHeuristic(PROMPT);
  const spec = crossSpec({ ladderWidth1: 400, ladderWidth2: 400, ladderHeight: 100, tangentLength: 120, miterOffset: 150 });
  const analysis = analyzeSpec(spec);

  assert.equal(analysis.ok, true, JSON.stringify(analysis.errors?.slice(0, 3)));
  const bounds = analysis.model.bounds.size;
  assert.equal(Math.round(bounds.x), 940);
  assert.equal(Math.round(bounds.y), 940);
  assert.equal(Math.round(bounds.z), 100);

  const result = checkCompleteness(spec, checklist, { bounds });
  assert.equal(result.ok, true, JSON.stringify(result.missing));
  assert.equal(result.summary.partUnits.corner, 4);
  assert.equal(result.summary.partUnits.rung, 6);
  assert.equal(result.summary.connectors, 4);
});

test("supplement prompt lists only the missing items", () => {
  const checklist = extractChecklistHeuristic(PROMPT);
  const missing = checkCompleteness(BROKEN, checklist).missing;
  const prompt = buildSupplementPrompt(missing, PROMPT);

  assert.match(prompt, /Thiếu 4 thành góc/);
  assert.match(prompt, /Thiếu 4 connector/);
  assert.match(prompt, /keep every existing part/);
});

test("complexity guard flags mitered crosses but not a simple box", () => {
  assert.equal(isComplexPrompt(PROMPT, extractChecklistHeuristic(PROMPT).groups), true);
  assert.equal(
    isComplexPrompt("tạo hộp thép 300x200x100 mm", [{ role: "rung", expected: 2 }]),
    false,
  );
});
