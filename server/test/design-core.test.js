import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";

import { checkCompleteness, extractChecklistHeuristic } from "../src/checklist.js";
import { design } from "../src/designer.js";
import { clearCachedResults } from "../src/result-cache.js";

process.env.AGENT_EXPERIMENTAL_PIPELINE = "0";
delete process.env.AGENT_TEMPLATE;

beforeEach(() => clearCachedResults());

function ladderSpec(name = "Ngã tư thang cáp") {
  return {
    schemaVersion: "1.0",
    name,
    category: "Electrical Equipment",
    units: "mm",
    parameters: [
      { name: "Ladder Width 1", type: "Length", group: "Dimensions", value: 400 },
      { name: "Ladder Height", type: "Length", group: "Dimensions", value: 100 },
      { name: "Sheet Thickness", type: "Length", group: "Dimensions", value: 1.5 },
    ],
    materials: [{ name: "Steel", color: "#8a9ba8", metalness: 0.6, roughness: 0.4 }],
    parts: [
      {
        id: "rail",
        name: "Corner Rail",
        material: "Steel",
        solid: {
          kind: "box",
          origin: { x: 0, y: 0, z: 50 },
          size: { x: "[Ladder Width 1]", y: 35, z: "[Ladder Height]" },
        },
      },
    ],
    connectors: [],
    notes: [],
  };
}

/** A cross that satisfies "4 thành góc + 6 bậc thang + 4 connector". */
function crossSpec({ withRungs = true } = {}) {
  const spec = ladderSpec("Ngã tư thang cáp");
  spec.parts = [];
  spec.connectors = [];

  const quadrants = [
    ["Đông Bắc", 1, 1],
    ["Đông Nam", 1, -1],
    ["Tây Bắc", -1, 1],
    ["Tây Nam", -1, -1],
  ];

  for (const [index, [corner, sx, sy]] of quadrants.entries()) {
    spec.parts.push({
      id: `corner-${index + 1}`,
      name: `Thành vát 45° - ${corner}`,
      material: "Steel",
      solid: {
        kind: "box",
        origin: { x: sx * 200, y: sy * 200, z: 50 },
        size: { x: "200", y: "35", z: "[Ladder Height]" },
      },
    });
    // Connector sits on the outer end face of its rail: no orphan warning.
    spec.connectors.push({
      id: `conn-${index + 1}`,
      name: `Connector ${index + 1}`,
      systemType: "CableTray",
      shape: "rectangular",
      origin: { x: sx * 300, y: sy * 200, z: 50 },
      directionVector: { x: sx, y: 0, z: 0 },
      width: 400,
      height: 100,
    });
  }

  if (withRungs) {
    for (let index = 1; index <= 6; index += 1) {
      spec.parts.push({
        id: `rung-${index}`,
        name: `Bậc thang ${index}`,
        material: "Steel",
        solid: {
          kind: "box",
          origin: { x: (index - 3) * 120, y: 0, z: 10 },
          size: { x: "35", y: "400", z: "15" },
        },
      });
    }
  }

  return spec;
}

function brokenSpec() {
  const spec = ladderSpec("Hỏng");
  // A formula pointing at a parameter that does not exist cannot be healed.
  spec.parts[0].solid.size.y = "[Missing Parameter] * 2";
  return spec;
}

test("(a) a known template family still goes to the model, unchanged", async () => {
  const calls = [];
  const result = await design({
    prompt: "ngã tư thang cáp 400x100",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async (messages, options) => {
      calls.push({ messages, options });
      return { json: crossSpec(), text: "", usage: { total_tokens: 10 } };
    },
  });

  assert.equal(calls.length, 1, "the template must not short-circuit the model");
  assert.ok(
    calls[0].messages[calls[0].messages.length - 1].content.includes("ngã tư thang cáp"),
    "the brief reaches the model",
  );

  const names = result.analysis.spec.parameters.map((parameter) => parameter.name);
  assert.deepEqual(names, ["Ladder Width 1", "Ladder Height", "Sheet Thickness"]);
  for (const forbidden of ["Width", "Height", "Depth", "CAO H"]) {
    assert.ok(!names.includes(forbidden), `${forbidden} was invented`);
  }

  assert.equal(result.stats.modelCalls, 1);
  assert.equal(result.stats.model, "cheap-model");
  assert.equal(result.stats.resolution, undefined);
  assert.equal(result.stats.productType, undefined);
  assert.equal(result.stats.complete, true);
  assert.equal(result.stats.parts, 10);
});

test("(b) two invalid answers, then a valid one: three turns, best spec wins", async () => {
  const calls = [];
  const result = await design({
    prompt: "dựng thang cáp 400x100",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async (messages, options) => {
      calls.push({ messages, options });
      const answer = calls.length <= 2 ? brokenSpec() : ladderSpec("Đúng");
      return { json: answer, text: "", usage: null };
    },
  });

  assert.equal(calls.length, 3, "three repair turns at most");
  assert.equal(result.stats.attempts, 3);
  assert.equal(result.analysis.ok, true);
  assert.equal(result.analysis.spec.name, "Đúng");
  assert.equal(result.stats.modelCalls, 3);

  // Each repair turn carries the previous answer and the error list.
  const repair = calls[1].messages.map((message) => String(message.content)).join("\n");
  assert.match(repair, /Missing Parameter/);
});

test("(c) an OUTPUT_LIMIT answer splits a sectioned brief and builds it in order", async () => {
  const brief = [
    "## Khung",
    "Khung thép 1200 x 600 mm.",
    "",
    "## Cửa thăm",
    "Cửa thăm 300 x 300 mm ở mặt trước.",
  ].join("\n");

  const calls = [];
  const result = await design({
    prompt: brief,
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async (messages, options) => {
      calls.push({ messages, options });
      if (calls.length === 1) {
        const error = new Error("Model output ended (OUTPUT_LIMIT)");
        error.code = "OUTPUT_LIMIT";
        throw error;
      }
      return { json: ladderSpec(`Phần ${calls.length - 1}`), text: "", usage: null };
    },
  });

  assert.equal(calls.length, 3, "one failed answer + one call per section");
  assert.match(String(calls[1].messages.at(-1).content), /Khung thép 1200 x 600/);

  const second = calls[2].messages.map((message) => String(message.content)).join("\n");
  assert.match(second, /Cửa thăm 300 x 300/, "the next section runs");
  assert.match(second, /current spec/, "later sections build on the previous spec");

  assert.ok(result.analysis.ok);
  assert.equal(result.stats.attempts, 2);
});

test("(d) every turn uses exactly the model the user picked", async () => {
  const models = [];
  await design({
    prompt: "tạo thang cáp 400x100",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "deepseek/deepseek-v4-pro",
    generate: async (messages, options) => {
      models.push(options.model);
      const answer = models.length <= 2 ? brokenSpec() : ladderSpec();
      return { json: answer, text: "", usage: null };
    },
  });

  assert.deepEqual(models, [
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-pro",
  ]);
});

test("cached answers do not reach the model twice", async () => {
  let calls = 0;
  const run = () =>
    design({
      prompt: "khung đỡ thiết bị 500x120",
      currentSpec: null,
      lod: 300,
      emit: () => {},
      model: "cheap-model",
      generate: async () => {
        calls += 1;
        return { json: ladderSpec(), text: "", usage: null };
      },
    });

  await run();
  const second = await run();

  assert.equal(calls, 1);
  assert.equal(second.stats.cached, true);
});

test("a precise parameter edit stays local and never calls the model", async () => {
  let calls = 0;
  const result = await design({
    prompt: "đổi Ladder Width 1 thành 500",
    currentSpec: ladderSpec(),
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async () => {
      calls += 1;
      return { json: ladderSpec(), text: "", usage: null };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.stats.attempts, 0);
  assert.equal(
    result.analysis.spec.parameters.find((parameter) => parameter.name === "Ladder Width 1").value,
    500,
  );
});

test("a valid but incomplete answer is supplemented with exactly the missing group", async () => {
  const calls = [];
  const result = await design({
    prompt: "ngã tư thang cáp 400x100, 4 thành góc, 6 bậc thang, 4 connector",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async (messages) => {
      calls.push(messages);
      // First answer: corner rails + connectors, no rungs.
      const spec = calls.length === 1 ? crossSpec({ withRungs: false }) : crossSpec();
      return { json: spec, text: "", usage: null };
    },
  });

  assert.equal(calls.length, 2, "one creation turn + one supplement turn");
  const supplement = String(calls[1].at(-1).content);
  assert.match(supplement, /Add ONLY these/);
  assert.match(supplement, /Thiếu 6 bậc thang/, "the missing rungs are named");
  assert.doesNotMatch(supplement, /Thiếu 4 thành góc/, "existing rails are not re-requested");

  assert.equal(result.stats.complete, true);
  assert.deepEqual(result.stats.missing, []);
  assert.equal(result.analysis.spec.parts.length, 10);
});

test("still incomplete after three turns: reported as incomplete, never as success", async () => {
  const calls = [];
  const result = await design({
    prompt: "ngã tư thang cáp 400x100, 4 thành góc, 6 bậc thang, 4 connector",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async () => {
      calls.push(1);
      return { json: crossSpec({ withRungs: false }), text: "", usage: null };
    },
  });

  assert.equal(calls.length, 3);
  assert.equal(result.stats.complete, false);
  assert.ok(result.stats.missing.some((item) => /bậc thang/.test(item)));
  assert.ok(result.stats.warnings.some((item) => item.startsWith("Chưa đầy đủ:")));
});

test("a part named 'Đông Bắc' is not counted as a rung", () => {
  const checklist = extractChecklistHeuristic(
    "ngã tư thang cáp 400x100, 4 thành góc, 6 bậc thang",
  );
  const spec = crossSpec({ withRungs: false });
  const result = checkCompleteness(spec, checklist, { bounds: null });

  assert.equal(result.summary.partUnits.corner, 4);
  assert.equal(result.summary.partUnits.rung, 0);
  assert.ok(result.missing.some((item) => item.role === "rung"));
});

test("an edit that times out keeps the family instead of failing the run", async () => {
  const spec = crossSpec();
  const result = await design({
    prompt: "đổi bậc thang trục Y chia làm 2 lớp",
    currentSpec: spec,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async () => {
      throw new Error("Agent run timed out after 120s");
    },
  });

  assert.equal(result.analysis.ok, true);
  assert.equal(result.analysis.spec.parts.length, spec.parts.length);
  assert.equal(result.stats.complete, undefined, "no checklist on an edit");
  assert.ok(result.stats.warnings.some((item) => /Giữ nguyên mô hình/.test(item)));
});

test("a split build keeps the sections that worked when a later one fails", async () => {
  const brief = ["## Khung", "Khung thép 1200 x 600 mm.", "", "## Cửa thăm", "Cửa thăm 300 x 300."].join("\n");

  let calls = 0;
  const result = await design({
    prompt: brief,
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("Model output ended (OUTPUT_LIMIT)");
        error.code = "OUTPUT_LIMIT";
        throw error;
      }
      if (calls === 2) return { json: ladderSpec("Phần 1"), text: "", usage: null };
      throw new Error("Agent run timed out after 240s");
    },
  });

  assert.equal(result.analysis.ok, true);
  assert.equal(result.analysis.spec.name, "Phần 1");
  assert.ok(result.stats.warnings.some((item) => /giữ phần đã dựng/.test(item)));
});

test("a supplement turn that times out reports the incomplete spec, not an error", async () => {
  let calls = 0;
  const result = await design({
    prompt: "ngã tư thang cáp 400x100, 4 thành góc, 6 bậc thang, 4 connector",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async () => {
      calls += 1;
      if (calls === 1) return { json: crossSpec({ withRungs: false }), text: "", usage: null };
      throw new Error("Agent run timed out after 240s");
    },
  });

  assert.equal(result.analysis.ok, true);
  assert.equal(result.stats.complete, false);
  assert.ok(result.stats.missing.some((item) => /bậc thang/.test(item)));
  assert.ok(result.stats.warnings.some((item) => item.startsWith("Chưa đầy đủ:")));
});

const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

function photoFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "family-photo-")), "photo.png");
  fs.writeFileSync(file, PHOTO);
  return { path: file, name: "photo.png" };
}

function lastContent(messages) {
  return messages[messages.length - 1].content;
}

test("a vision-enabled direct API gets the photo in the same turn", async () => {
  let messages;
  const result = await design({
    prompt: "dựng van theo ảnh này",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "custom:api",
    customApiConfig: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-test", model: "gpt-4o" },
    attachments: [photoFile()],
    generate: async (sent) => {
      messages = sent;
      return { json: ladderSpec("Van"), text: "", usage: null };
    },
  });

  const content = lastContent(messages);
  assert.ok(Array.isArray(content), "the last user message carries parts");
  assert.ok(content.some((part) => part.type === "image"), "the photo is an image part");
  assert.match(
    content.map((part) => part.text ?? "").join("\n"),
    /dựng van theo ảnh này/,
  );
  const allText = messages.map((message) => String(message.content)).join("\n");
  assert.ok(!allText.includes("read_file"), "no separate vision step is asked for");
  assert.ok(result.analysis.ok);
});

test("a text-only provider keeps the c709e4c read_file instruction", async () => {
  let messages;
  await design({
    prompt: "dựng van theo ảnh này",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "custom:api",
    customApiConfig: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-test", model: "deepseek-chat" },
    attachments: [photoFile()],
    generate: async (sent) => {
      messages = sent;
      return { json: ladderSpec("Van"), text: "", usage: null };
    },
  });

  assert.equal(typeof lastContent(messages), "string");
  assert.match(messages.map((message) => String(message.content)).join("\n"), /read_file/);
});
