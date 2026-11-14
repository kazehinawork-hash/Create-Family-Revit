process.env.FAMILY_AGENT_NO_LISTEN = "1";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

const agents = await import("../src/agents.js");

function fakeChild({ stdout = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = () => true;
  child.stdin.end = () => {};
  child.pid = 4343;
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
  };
  setTimeout(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.exitCode = code;
    child.emit("close", code);
  }, 5);
  return child;
}

const SPEC_FRAME =
  '{"type":"result","subtype":"success","stopReason":"end_turn","finalText":"{\\"schemaVersion\\":\\"1.0\\",\\"name\\":\\"Hop\\",\\"parts\\":[]}"}\n';

async function captureArgs(options = {}) {
  let seen = null;
  agents.__setSpawnOverrideForTests((executable, args) => {
    seen = { executable, args };
    return fakeChild({ stdout: SPEC_FRAME });
  });

  try {
    await agents.generateJson([{ role: "user", content: "dựng hộp điện" }], {
      model: "deepseek/deepseek-v4.1-flash",
      ...options,
    });
  } finally {
    agents.__setSpawnOverrideForTests(null);
  }

  return seen;
}

function effortOf(args) {
  const index = args.indexOf("--effort");
  return index === -1 ? null : args[index + 1];
}

test("the CLI gets --no-skills and the low build effort by default", async () => {
  const { args } = await captureArgs();

  assert.ok(args.includes("--no-skills"), `--no-skills missing from ${args.join(" ")}`);
  assert.equal(effortOf(args), "low");
  assert.equal(args.includes("--safe-mode"), false, "safe mode stays opt-in");
});

test("low and medium effort are passed through to the CLI", async () => {
  assert.equal(effortOf((await captureArgs({ effort: "low" })).args), "low");
  assert.equal(effortOf((await captureArgs({ effort: "medium" })).args), "medium");
});

test("a higher effort request is respected", async () => {
  assert.equal(effortOf((await captureArgs({ effort: "high" })).args), "high");
  assert.equal(effortOf((await captureArgs({ effort: "max" })).args), "max");
});

test("COMMAND_CODE_EFFORT wins over the build default", () => {
  assert.equal(agents.resolveCliEffort({ effort: "high", buildEffort: "low" }), "high");
  assert.equal(agents.resolveCliEffort({ effort: "", buildEffort: "low" }), "low");
  assert.equal(agents.resolveCliEffort({ effort: "medium" }), "medium");
});

test("an unknown effort is never written into the CLI args", () => {
  const args = agents.commandCodeArgs({ maxTurns: 2, model: "x", effort: "turbo" });
  assert.equal(args.includes("--effort"), false);
});
