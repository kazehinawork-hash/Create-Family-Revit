import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { beforeEach } from "node:test";

import {
  __resetAgentCachesForTests,
  __setSpawnOverrideForTests,
  detectAgentBackends,
  getCmdcModels,
  listCommandModels,
} from "../src/agents.js";

/** Minimal stand-in for a spawned CLI. */
function fakeChild({ hang = false, stdout = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};

  if (!hang) {
    setTimeout(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", code);
    }, 5);
  }
  return child;
}

beforeEach(() => {
  process.env.AGENT_LIST_TIMEOUT = "80";
  process.env.AGENT_BIN_TIMEOUT = "80";
  __resetAgentCachesForTests();
});

test("a hung `--list-models` is killed and resolves to an empty list", async () => {
  __setSpawnOverrideForTests(() => fakeChild({ hang: true }));

  const started = Date.now();
  const models = await listCommandModels("cmdc");
  const elapsed = Date.now() - started;

  assert.deepEqual(models, []);
  assert.ok(elapsed < 1000, `listing must not hang (took ${elapsed}ms)`);
});

test("a hung binary check makes the backend unavailable instead of hanging", async () => {
  __setSpawnOverrideForTests(() => fakeChild({ hang: true }));

  const started = Date.now();
  const backends = await detectAgentBackends();
  const elapsed = Date.now() - started;

  assert.deepEqual(
    { commandcode: backends.commandcode, agy: backends.agy, codex: backends.codex, claude: backends.claude },
    { commandcode: false, agy: false, codex: false, claude: false },
  );
  assert.ok(elapsed < 2000, `backend detection must be bounded (took ${elapsed}ms)`);
});

test("concurrent model listings share one in-flight spawn", async () => {
  let listSpawns = 0;

  __setSpawnOverrideForTests((executable, args = []) => {
    if (args.includes("--list-models")) {
      listSpawns += 1;
      return fakeChild({ stdout: "model-a  fast reasoning\nmodel-b  strong reasoning\n" });
    }
    if (args.includes("models")) return fakeChild({ stdout: "" });
    return fakeChild({ code: 0 });
  });

  const [first, second] = await Promise.all([getCmdcModels(), getCmdcModels()]);

  assert.equal(listSpawns, 1, "two concurrent calls must spawn the CLI once");
  assert.ok(first.some((entry) => entry.id === "model-a"));
  assert.deepEqual(first.map((entry) => entry.id), second.map((entry) => entry.id));
});

test("an expired cache is served immediately while it refreshes in the background", async () => {
  let listSpawns = 0;
  process.env.AGENT_MODELS_TTL_MS = "20";

  __setSpawnOverrideForTests((executable, args = []) => {
    if (args.includes("--list-models")) {
      listSpawns += 1;
      return fakeChild({ stdout: "model-cached  desc\n" });
    }
    if (args.includes("models")) return fakeChild({ stdout: "" });
    return fakeChild({ code: 0 });
  });

  const first = await getCmdcModels();
  assert.ok(first.some((entry) => entry.id === "model-cached"));

  // Let the TTL expire, then make the refresh hang: the stale cache must still be
  // returned immediately instead of waiting for the CLI.
  await new Promise((resolve) => setTimeout(resolve, 40));

  __setSpawnOverrideForTests((executable, args = []) => {
    if (args.includes("--list-models")) {
      listSpawns += 1;
      return fakeChild({ hang: true });
    }
    if (args.includes("models")) return fakeChild({ stdout: "" });
    return fakeChild({ code: 0 });
  });

  const started = Date.now();
  const stale = await getCmdcModels();
  const elapsed = Date.now() - started;

  assert.ok(
    stale.some((entry) => entry.id === "model-cached"),
    "the stale list is returned",
  );
  assert.ok(elapsed < 100, `a stale cache must answer immediately (took ${elapsed}ms)`);

  // The background refresh did start (and is still hanging on the CLI).
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(listSpawns, 2, "one listing before, one refresh in the background");
});
