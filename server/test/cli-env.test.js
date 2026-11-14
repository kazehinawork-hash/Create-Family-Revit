import assert from "node:assert/strict";
import test from "node:test";

import { cliEnvFor } from "../src/agents.js";

test("a pasted Command Code key is exported to the CLI process only", () => {
  const env = cliEnvFor("  cc_live_123  ");

  assert.equal(env.COMMAND_CODE_API_KEY, "cc_live_123");
  assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path, "inherits the env");
  assert.equal(process.env.COMMAND_CODE_API_KEY, undefined, "global env is untouched");
});

test("no key keeps the CLI on its normal login", () => {
  assert.equal(cliEnvFor(""), undefined);
  assert.equal(cliEnvFor(undefined), undefined);
  assert.equal(cliEnvFor("   "), undefined);
});
