import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

// Importing index.js must not open a listener during tests.
process.env.FAMILY_AGENT_NO_LISTEN = "1";
process.env.AGENT_LIST_TIMEOUT = "80";
process.env.AGENT_BIN_TIMEOUT = "80";

const agents = await import("../src/agents.js");
const { buildHealthPayload } = await import("../src/index.js");

function hangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test("/api/health stays 200-shaped when the model listing hangs", async () => {
  agents.__resetAgentCachesForTests();
  agents.__setSpawnOverrideForTests(() => hangingChild());

  const started = Date.now();
  const payload = await buildHealthPayload();
  const elapsed = Date.now() - started;

  assert.equal(payload.ok, true, "health must still report ok");
  // No CLI answered: only the always-available Direct API entry remains.
  assert.deepEqual(
    payload.models.map((entry) => entry.id),
    ["custom:api"],
  );
  assert.deepEqual(
    {
      commandcode: payload.backends.commandcode,
      agy: payload.backends.agy,
      codex: payload.backends.codex,
      claude: payload.backends.claude,
    },
    { commandcode: false, agy: false, codex: false, claude: false },
  );
  assert.equal(typeof payload.bridge, "string");
  assert.ok(elapsed < 3000, `health must answer quickly (took ${elapsed}ms)`);

  agents.__resetAgentCachesForTests();
});
