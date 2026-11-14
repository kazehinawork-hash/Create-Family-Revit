// These tests cover the opt-in pipeline (templates, evidence, tiers, split steps).
process.env.AGENT_EXPERIMENTAL_PIPELINE = "1";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { condensePrompt, design, splitNewBrief } from "../src/designer.js";
import { createDesignJob, finishDesignJob, getDesignJob, JOBS_DIR } from "../src/jobs.js";
import { isTruncatedFrame, outputLimitError } from "../src/agents.js";
import { LlmError } from "../src/llm.js";
import { isOutputLimitError, isTransientError } from "../src/retry.js";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function boxSpec(name, extra = {}) {
  return {
    schemaVersion: "1.0",
    name,
    category: "Generic Model",
    units: "mm",
    parameters: [
      { name: "Length", type: "Length", group: "Dimensions", value: 1000 },
    ],
    materials: [{ name: "Steel", color: "#8a9ba8", metalness: 0.8, roughness: 0.3 }],
    parts: [
      {
        id: "body",
        name: "Body",
        material: "Steel",
        solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[Length]", y: 400, z: 400 } },
      },
    ],
    connectors: [],
    ...extra,
  };
}

const LONG_BRIEF = [
  "Dựng family cửa gió chữ nhật cho hệ thống cấp gió, kích thước 1200 x 600 x 400 mm.",
  "Khung chính dày 2 mm, có gân gia cường, các cạnh vát đều.",
  "Chi tiết: cửa thăm 300 x 300 mm ở mặt trước, bản lề và tay nắm đơn giản.",
  "Bảng thông số: Wind Width = 1200 mm, Wind Height = 600 mm, Casing Depth = 400 mm.",
  "",
  "Connector: hai cổng cấp gió kích thước 1200 x 600 mm ở hai đầu, thêm một cổng nhánh 400 x 300 mm ở hông. MEP connector phải nằm đúng tâm mặt bích, hướng ra ngoài.",
  "",
  "Vật liệu và bảng màu: vỏ ngoài sơn tĩnh điện RAL 7035 màu xám nhạt, metalness 0.2 roughness 0.6; khung trong thép mạ kẽm màu #b8c0c8; gioăng cao su đen metalness 0.05 roughness 0.9; cánh cửa thăm nhôm màu #dcdcdc.",
  "",
  "Ghi chú thêm: " + "yêu cầu rất chi tiết ".repeat(160),
].join("\n");

test("splitNewBrief keeps a short, plain brief in one pass", () => {
  assert.equal(splitNewBrief("Tạo một hộp 500 x 300 x 200 mm, không cần connector.", 3000), null);
  assert.equal(splitNewBrief("", 3000), null);
});

test("splitNewBrief splits a long brief into skeleton, connectors and materials", () => {
  const steps = splitNewBrief(LONG_BRIEF, 3000);
  assert.ok(steps, "a long brief must be split");
  assert.deepEqual(
    steps.map((step) => step.kind),
    ["skeleton", "connectors", "materials"],
  );
  assert.deepEqual(
    steps.map((step) => step.label),
    ["khung hình học", "connector", "vật liệu"],
  );
  assert.ok(!steps[1].prompt.includes("RAL 7035"), "the connector step must not repeat the palette");
  assert.ok(!steps[2].prompt.includes("cổng nhánh"), "the material step must not repeat connectors");
});

test("condensePrompt drops prose and keeps the numbers", () => {
  const condensed = condensePrompt(
    "Hãy làm thật đẹp và chuyên nghiệp.\nChiều dài 1200 mm, rộng [Wind Width] mm.\nVật liệu phải sang trọng.",
  );
  assert.ok(condensed.includes("1200 mm"));
  assert.ok(condensed.includes("[Wind Width]"));
  assert.ok(!condensed.includes("Hãy làm thật đẹp"));
});

test("a split create keeps the early spec when a later step fails", async () => {
  const events = [];
  let call = 0;
  const generate = async () => {
    call += 1;
    if (call === 1) return { json: boxSpec("Skeleton only"), text: "", usage: null };
    throw new Error("connector step exploded");
  };

  const result = await design({
    prompt: LONG_BRIEF,
    currentSpec: null,
    lod: 300,
    emit: (event) => events.push(event),
    model: "test-model",
    generate,
  });

  // Skeleton succeeded, connectors and materials each failed on their own.
  assert.equal(call, 3);
  assert.equal(result.analysis.spec.name, "Skeleton only");
  assert.equal(result.analysis.ok, true);
  assert.equal((result.analysis.spec.connectors ?? []).length, 0);
  // Two failed steps; a checklist "Chưa đầy đủ" note may follow since connectors are missing.
  assert.equal(result.stats.warnings.filter((warning) => warning.includes("chưa áp dụng")).length, 2);
  assert.ok(result.stats.warnings.some((warning) => warning.includes("connector")));
  assert.ok(result.stats.warnings.some((warning) => warning.includes("vật liệu")));
  assert.ok(result.stats.steps.some((step) => step.ok === false));

  const partial = events.filter((event) => event.type === "spec" && event.stats?.step?.partial);
  assert.equal(partial.length, 1, "the skeleton is streamed before the next step");
});

test("each step builds on the previous spec", async () => {
  const prompts = [];
  let call = 0;
  const generate = async (messages) => {
    prompts.push(messages.map((message) => message.content).join("\n"));
    call += 1;
    if (call === 1) return { json: boxSpec("Step A"), text: "", usage: null };
    if (call === 2) {
      return {
        json: boxSpec("Step B", {
          connectors: [{ id: "supply", name: "Supply", systemType: "SupplyAir", shape: "rectangular", width: 600, height: 400, origin: { x: 0, y: 0, z: 0 } }],
        }),
        text: "",
        usage: null,
      };
    }
    return {
      json: boxSpec("Step C", {
        connectors: [{ id: "supply", name: "Supply", systemType: "SupplyAir", shape: "rectangular", width: 600, height: 400, origin: { x: 0, y: 0, z: 0 } }],
        materials: [{ name: "RAL 7035", color: "#d7d7d7", metalness: 0.2, roughness: 0.6 }],
      }),
      text: "",
      usage: null,
    };
  };

  const result = await design({
    prompt: LONG_BRIEF,
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "test-model",
    generate,
  });

  assert.equal(call, 3);
  assert.ok(prompts[1].includes("Step A"), "the connector step receives the skeleton spec");
  assert.ok(prompts[2].includes("Step B"), "the material step receives the connector spec");
  assert.equal(result.analysis.spec.name, "Step C");
  assert.equal(result.analysis.spec.connectors.length, 1);
  assert.equal(result.stats.steps.length, 3);
});

test("a timed-out turn is retried once with a condensed prompt", async () => {
  const prompts = [];
  let call = 0;
  const generate = async (messages) => {
    prompts.push(messages[messages.length - 1].content);
    call += 1;
    if (call === 1) throw new LlmError("Agent run timed out after 3s");
    return { json: boxSpec("Recovered"), text: "", usage: null };
  };

  const result = await design({
    prompt:
      "Tạo hộp 500 x 300 x 200 mm.\n" +
      "Hãy làm thật đẹp, thật chuyên nghiệp và tỉ mỉ với nhiều chi tiết trang trí. ".repeat(12),
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "test-model",
    generate,
  });

  assert.equal(call, 2);
  assert.equal(result.analysis.spec.name, "Recovered");
  assert.ok(prompts[1].length < prompts[0].length, "the retry prompt is shorter");
  assert.ok(prompts[1].includes("Keep every number"));
});

test("design jobs survive a restart because they are written to disk", async (t) => {
  const job = createDesignJob({ prompt: "brief", model: "deepseek/deepseek-v4", lod: 300 });
  const filePath = path.join(JOBS_DIR, `${job.job_id}.json`);

  t.after(() => {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // already gone
    }
  });

  finishDesignJob(job.job_id, {
    status: "done",
    spec: boxSpec("Persisted"),
    stats: { parts: 1, parameters: 1 },
  });

  assert.ok(fs.existsSync(filePath), "the job file is written to disk");
  const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(stored.status, "done");
  assert.equal(stored.spec.name, "Persisted");

  // Reading it back through the store is what a restarted process does.
  assert.equal(getDesignJob(job.job_id).status, "done");
  assert.equal(getDesignJob("djs_missing"), null);
});

test("an edit that times out keeps the current spec instead of failing", async () => {
  const currentSpec = boxSpec("Current model");
  const generate = async () => {
    throw new LlmError("Agent run timed out after 1s");
  };

  const result = await design({
    prompt: "Làm phần khung gọn hơn, thêm gân và bo góc mềm mại.",
    currentSpec,
    lod: 300,
    emit: () => {},
    model: "test-model",
    generate,
  });

  assert.equal(result.analysis.spec.name, "Current model");
  assert.equal(result.analysis.ok, true);
  assert.ok(result.stats.warnings[0].includes("Giữ nguyên mô hình hiện tại"));
});

const SECTIONED_BRIEF = [
  "Tạo family Cable Tray Fitting ngã tư thang cáp LOD 400.",
  "",
  "---",
  "",
  "## 1. THAM SỐ:",
  "- `Ladder_Width_1` = 400 mm, `Ladder_Height` = 100 mm. Cổ thẳng tại 4 đầu kết nối = 120 mm.",
  "",
  "## 2. THÀNH GÓC VÁT:",
  "- 4 cụm thành chữ C, đột lỗ bắt bát nối tại cả 4 đầu kết nối. " + "chi tiết thành ".repeat(120),
  "",
  "## 3. BẬC THANG:",
  "- 6 bậc thang 35 x 15 mm, đục lỗ oval 9 x 25 mm bước 35 mm. " + "chi tiết bậc ".repeat(120),
  "",
  "## 4. CONNECTOR MEP:",
  "- 4 Cable Tray Connector tại 4 cửa, Width = Ladder_Width_1.",
  "",
  "## 5. BẢNG PHỐI MÀU VẬT LIỆU:",
  "- RAL 7035 -> RGB(215, 218, 222).",
].join("\n");

test("splitNewBrief splits a markdown brief on its headings, not on body words", () => {
  const steps = splitNewBrief(SECTIONED_BRIEF, 2500);
  assert.ok(steps);
  assert.deepEqual(
    steps.map((step) => step.kind),
    ["skeleton", "geometry", "connectors", "materials"],
  );
  // "4 đầu kết nối" in sections 1-2 must not move them into the connector step.
  assert.ok(steps[0].prompt.includes("THÀNH GÓC VÁT"));
  assert.ok(steps[0].prompt.includes("Tạo family Cable Tray Fitting"), "the preamble stays with the skeleton");
  assert.ok(!steps[2].prompt.includes("THÀNH GÓC VÁT"));
  assert.ok(steps[1].prompt.includes("BẬC THANG"));
  assert.ok(steps[1].prompt.includes("`array`"), "geometry steps carry the repeat rule");
  assert.ok(steps[3].prompt.includes("RAL 7035"));
  assert.ok(!steps.some((step) => /^\s*---\s*$/m.test(step.prompt)), "horizontal rules are dropped");
});

test("a short sectioned brief with only geometry stays in one pass", () => {
  const brief = "## 1. KHỐI:\n- Hộp 500 x 300 mm.\n\n## 2. GÂN:\n- 4 gân dày 2 mm.";
  assert.equal(splitNewBrief(brief, 3000), null);
});

test("an answer cut off by the output limit is not retried as-is but split into sections", async () => {
  const brief = "## 1. KHỐI:\n- Hộp 500 x 300 x 200 mm.\n\n## 2. GÂN:\n- 4 gân dày 2 mm cách đều 100 mm.";
  const prompts = [];
  const events = [];
  let call = 0;
  const generate = async (messages) => {
    prompts.push(messages[messages.length - 1].content);
    call += 1;
    if (call === 1) throw outputLimitError(64000);
    return { json: boxSpec(`Section ${call - 1}`), text: "", usage: null };
  };

  const result = await design({
    prompt: brief,
    currentSpec: null,
    lod: 400,
    emit: (event) => events.push(event),
    model: "test-model",
    generate,
  });

  // 1 cut-off single pass, then one pass per section; no condensed retry of the full brief.
  assert.equal(call, 3);
  assert.ok(prompts[1].includes("KHỐI") && !prompts[1].includes("GÂN:"));
  assert.ok(prompts[2].includes("GÂN"));
  assert.equal(result.analysis.spec.name, "Section 2");
  assert.ok(events.some((event) => event.stage === "retrying" && /chia yêu cầu/.test(event.message)));
});

test("output-limit errors are recognised through wrapping and never treated as transient", () => {
  const error = outputLimitError(64000);
  assert.equal(isOutputLimitError(error), true);
  assert.equal(isOutputLimitError(new Error("wrapped", { cause: error })), true);
  assert.equal(isTransientError(error), false);
  assert.equal(isOutputLimitError(new LlmError("Agent run timed out after 240s")), false);
});

test("isTruncatedFrame spots a CLI answer stopped by its limits", () => {
  assert.equal(isTruncatedFrame({ type: "result", stopReason: "max_tokens", finalText: "" }), true);
  assert.equal(isTruncatedFrame({ type: "result", stopReason: "end_turn" }, "Warning: maximum output tokens reached"), true);
  assert.equal(isTruncatedFrame({ type: "result", stopReason: "end_turn", finalText: "{}" }), false);
  // A turn cap is not an output cap: it gets its own error and its own retry.
  assert.equal(isTruncatedFrame({ type: "result", stopReason: "max_turns", finalText: "" }), false);
  assert.equal(
    isTruncatedFrame({ type: "result", stopReason: "end_turn" }, "Warning: Reached maximum conversation turns (1)."),
    false,
  );
});

test("the server root exists so JOBS_DIR stays inside it", () => {
  assert.equal(JOBS_DIR, path.join(SERVER_ROOT, "..", ".jobs"));
});

test("a model picked in the Agent panel is used for every tier, repair included", async () => {
  const { turnModel } = await import("../src/designer.js");
  const { TIER } = await import("../src/router.js");
  const tierModels = {
    1: "deepseek/deepseek-v4-flash",
    2: "deepseek/deepseek-v4.1-flash",
    3: "deepseek/deepseek-v4-pro",
    cmdcIds: ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro"],
  };
  const picked = "deepseek/deepseek-v4.1-flash";

  for (const tier of [TIER.PATCH, TIER.STRUCTURE, TIER.REPAIR]) {
    assert.equal(turnModel(tier, { userModel: picked, locked: true, tierModels }), picked);
  }

  // Unlocked (server default routing) may still escalate the repair turn.
  assert.equal(
    turnModel(TIER.REPAIR, { userModel: picked, locked: false, tierModels }),
    "deepseek/deepseek-v4-pro",
  );
});
