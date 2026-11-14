import assert from "node:assert/strict";
import test from "node:test";

import { extractAnswerText } from "../src/agents.js";

test("takes the final text frame, not a span across frames", () => {
  const stdout = [
    '{"type":"progress","message":"thinking {not json"}',
    '{"type":"tool","input":{"path":"a.txt"}}',
    '{"type":"assistant","finalText":"{\\"schemaVersion\\":\\"1.0\\",\\"parts\\":[]}"}',
  ].join("\n");
  assert.equal(extractAnswerText(stdout), '{"schemaVersion":"1.0","parts":[]}');
});

test("accepts a bare spec line", () => {
  const stdout = 'log line\n{"schemaVersion":"1.0","parts":[{"id":"a"}]}\n';
  assert.equal(extractAnswerText(stdout), '{"schemaVersion":"1.0","parts":[{"id":"a"}]}');
});

test("returns empty when nothing usable is printed", () => {
  assert.equal(extractAnswerText('{"type":"progress"}\n{"type":"tool"}'), "");
  assert.equal(extractAnswerText("plain text only"), "");
});
