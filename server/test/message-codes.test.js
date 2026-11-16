import assert from "node:assert/strict";
import test from "node:test";

import { enrichEvent, enrichIssue } from "../src/message-codes.js";

test("stage messages carry a code and params", () => {
  const building = enrichEvent({ type: "stage", stage: "working", message: "Đang dựng… 12s" });
  assert.equal(building.code, "stage.buildingElapsed");
  assert.deepEqual(building.params, { seconds: 12 });

  const repair = enrichEvent({
    type: "stage",
    stage: "repairing",
    message: "Nối hoặc bỏ 2 tham số không dùng",
  });
  assert.equal(repair.code, "stage.repairParameters");
  assert.deepEqual(repair.params, { count: 2 });
});

test("unknown stage messages keep their original text and no code", () => {
  const event = enrichEvent({ type: "stage", stage: "custom", message: "Thông báo riêng" });
  assert.equal(event.code, undefined);
  assert.equal(event.message, "Thông báo riêng");
});

test("error events are coded by kind", () => {
  const event = enrichEvent({ type: "error", kind: "overloaded", message: "503" });
  assert.equal(event.code, "error.overloaded");
});

test("known issues are coded, unknown issues pass through", () => {
  const offset = enrichIssue({
    severity: "warning",
    path: "connectors.conn-1",
    message: 'Connector "conn-1" host is offset 12.5 mm from the spec origin',
  });
  assert.equal(offset.code, "issue.connectorOffset");
  assert.deepEqual(offset.params, { name: "conn-1", mm: 12.5 });

  const unused = enrichIssue({
    severity: "warning",
    path: "parameters.Overall Height",
    message: "Kích thước \"Overall Height\" không điều khiển hình nào — nối vào hình hoặc bỏ đi.",
  });
  assert.equal(unused.code, "issue.unusedParameter");
  assert.deepEqual(unused.params, { name: "Overall Height" });

  const other = { severity: "error", path: "parts.1", message: "Something else" };
  assert.equal(enrichIssue(other), other);
});

test("spec events enrich both issue lists", () => {
  const event = enrichEvent({
    type: "spec",
    issues: [{ severity: "warning", path: "parameters.X", message: "declared but never used by a formula" }],
    errors: [],
  });
  assert.equal(event.issues[0].code, "issue.unusedParameter");
});
