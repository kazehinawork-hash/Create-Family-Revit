process.env.FAMILY_AGENT_NO_LISTEN = "1";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

const agents = await import("../src/agents.js");

/**
 * Stand-in for the spawned CLI. The payload is emitted on a timer, after the runner
 * has attached its listeners (emitting inline would resolve before they exist).
 */
function fakeChild({ stdout = "", stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // The runner attaches an error listener and writes the prompt; stdin is a stream.
  child.stdin = new EventEmitter();
  child.stdin.write = () => true;
  child.stdin.end = () => {};
  child.pid = 4242;
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
  };

  setTimeout(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.exitCode = code;
    child.emit("close", code);
  }, 5);

  return child;
}

test("a turn cap is not treated as an output-token cap", () => {
  const stderr = "Reached maximum conversation turns (1). The response may be incomplete.";

  assert.equal(agents.isTruncatedFrame({}, stderr), false);
  assert.equal(agents.isMaxTurnsFrame({}, stderr), true);
});

test("a token stop reason is an output limit", () => {
  assert.equal(agents.isTruncatedFrame({ stopReason: "max_tokens" }), true);
  assert.equal(agents.isTruncatedFrame({ stop_reason: "output_limit" }), true);
  assert.equal(agents.isMaxTurnsFrame({ stopReason: "max_tokens" }), false);
  assert.equal(agents.isMaxTurnsFrame({ stopReason: "max_turns" }), true);
});

test("the max-turns error is a distinct code with a Vietnamese message", () => {
  const error = agents.maxTurnsError(2);

  assert.equal(error.code, "MAX_TURNS");
  assert.match(error.message, /hết 2 lượt của CLI/);
});

test("commandCodeJson reports MAX_TURNS when the CLI stops on its turn cap", async () => {
  agents.__setSpawnOverrideForTests(() =>
    fakeChild({
      stdout: '{"type":"result","subtype":"success","stopReason":"max_turns","finalText":""}\n',
      stderr: "Reached maximum conversation turns (2). The response may be incomplete.",
      code: 8,
    }),
  );

  try {
    await assert.rejects(
      () => agents.generateJson([{ role: "user", content: "dựng thang cáp" }], { model: "cheap-model" }),
      (error) => {
        assert.equal(error.code, "MAX_TURNS");
        return true;
      },
    );
  } finally {
    agents.__setSpawnOverrideForTests(null);
  }
});

test("commandCodeJson still reports OUTPUT_LIMIT for a token cap", async () => {
  agents.__setSpawnOverrideForTests(() =>
    fakeChild({
      stdout:
        '{"type":"result","subtype":"success","stopReason":"max_tokens","finalText":"","usage":{"outputTokens":9000}}\n',
      code: 0,
    }),
  );

  try {
    await assert.rejects(
      () => agents.generateJson([{ role: "user", content: "dựng thang cáp" }], { model: "cheap-model" }),
      (error) => {
        assert.equal(error.code, "OUTPUT_LIMIT");
        return true;
      },
    );
  } finally {
    agents.__setSpawnOverrideForTests(null);
  }
});
