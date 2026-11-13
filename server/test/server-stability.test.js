process.env.FAMILY_AGENT_NO_LISTEN = "1";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const { applyServerTimeouts } = await import("../src/index.js");
const { createDesignJob, designJobSeenSince, getDesignJob, touchDesignJob, JOBS_DIR } =
  await import("../src/jobs.js");

test("the API keeps long design streams open instead of timing out at 5 minutes", () => {
  const server = {};

  applyServerTimeouts(server);

  assert.equal(server.requestTimeout, 0, "Node's 300 s default cut every long brief");
  assert.equal(server.timeout, 0);
  assert.equal(server.headersTimeout, 60000);
  assert.ok(
    server.keepAliveTimeout > 60000,
    "must outlive proxy idle timeouts so keep-alive sockets are not closed under us",
  );
});

test("polling a design job marks it as seen without rewriting the file", () => {
  const job = createDesignJob({ prompt: "thang cáp 400x100", model: "cheap-model", lod: 300 });
  const file = path.join(JOBS_DIR, `${job.job_id}.json`);
  const before = fs.statSync(file).mtimeMs;

  assert.equal(designJobSeenSince(job.job_id, Date.now()), false, "nothing has polled it yet");

  const touchedAt = Date.now();
  touchDesignJob(job.job_id, touchedAt);

  assert.equal(designJobSeenSince(job.job_id, touchedAt - 1), true);
  assert.equal(designJobSeenSince(job.job_id, touchedAt + 1), false);
  assert.equal(getDesignJob(job.job_id).last_seen_at, new Date(touchedAt).toISOString());
  assert.equal(
    fs.statSync(file).mtimeMs,
    before,
    "a 3 s poll must not write the job file on every tick",
  );
});

test("a socket that drops right after a poll is not treated as an abort", () => {
  const job = createDesignJob({ prompt: "van DN150", model: "cheap-model", lod: 300 });
  const socketClosedAt = Date.now();

  touchDesignJob(job.job_id, socketClosedAt + 3000);

  assert.equal(
    designJobSeenSince(job.job_id, socketClosedAt),
    true,
    "the studio reconnected during the grace period — keep the run alive",
  );
});

test("an unknown job id is not marked as seen", () => {
  assert.equal(touchDesignJob("djs_missing"), null);
  assert.equal(designJobSeenSince("djs_missing", 0), false);
});
