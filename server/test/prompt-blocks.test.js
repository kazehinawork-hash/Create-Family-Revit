import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_BUDGET, REQUIRED_BLOCKS, buildSystemPrompt, selectBlocks } from "../src/prompt-blocks.js";
import { systemPrompt } from "../src/designer/prompts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const designerPrompt = fs.readFileSync(path.join(ROOT, "prompts", "designer.md"), "utf8");

test("selectBlocks includes trayRun sheet-metal macros only for cable-tray/sheet-metal briefs", () => {
  const trayBlocks = selectBlocks({ text: "Tạo cút máng cáp 400x100 thép tấm" });
  assert.equal(trayBlocks.has("Sheet-metal macros (trayRun)"), true);

  const ladderBlocks = selectBlocks({ text: "Cable ladder 90 degree elbow" });
  assert.equal(ladderBlocks.has("Sheet-metal macros (trayRun)"), true);

  const pumpBlocks = selectBlocks({ text: "Bơm ly tâm trục ngang DN80" });
  assert.equal(pumpBlocks.has("Sheet-metal macros (trayRun)"), false);
});

test("buildSystemPrompt injects trayRun block cleanly within default budget", () => {
  const built = buildSystemPrompt(designerPrompt, {
    text: "Ngã rẽ thang cáp 400x100 tôn chấn",
    options: { budget: 15000 },
  });
  assert.ok(built.blocks.includes("Sheet-metal macros (trayRun)"));
  assert.ok(built.prompt.includes("trayRun"));
});

test("buildSystemPrompt and selectBlocks exclude trayRun/slotPattern when macros=false (AGENT_MACROS=0)", () => {
  const selected = selectBlocks({
    text: "Tạo cút máng cáp 400x100 thép tấm",
    options: { macros: false },
  });
  assert.equal(selected.has("Sheet-metal macros (trayRun)"), false);

  const built = buildSystemPrompt(designerPrompt, {
    text: "Tạo cút máng cáp 400x100 thép tấm",
    options: { budget: 15000, macros: false },
  });
  assert.equal(built.blocks.includes("Sheet-metal macros (trayRun)"), false);
  assert.equal(/\b(trayRun|slotPattern)\b/i.test(built.prompt), false);
});

test("production systemPrompt keeps trayRun instructions under default LOD 350/400 budget when enabled", () => {
  const on = systemPrompt(350, null, {
    text: "Tạo khuỷu máng cáp 90 độ rộng 400 mm, cao 100 mm",
    macros: true,
  });
  assert.ok(on.includes("trayRun"), "systemPrompt must retain trayRun block under default budget");
  assert.ok(on.includes("tâm góc theo đường tim"), "centerline leg-length rule must be present when macros=true");

  const off = systemPrompt(350, null, {
    text: "Tạo khuỷu máng cáp 90 độ rộng 400 mm, cao 100 mm",
    macros: false,
  });
  assert.equal(/\b(trayRun|slotPattern)\b/i.test(off), false);
  assert.ok(off.includes("tâm góc theo đường tim"), "centerline leg-length rule must remain present when macros=false");
});

test("cable tray, AHU, and duct briefs fit default budget and retain Notes, Output shape, and Geometry quality checklist", () => {
  const samples = [
    ["cable-tray", "Ngã tư máng cáp 400x100 thép tấm tôn chấn, 4 nhánh 300mm, LOD 400"],
    ["ahu", "AHU 12000 CFM có cooling coil, filter, fan, cửa thăm, LOD 350"],
    ["duct", "Ống gió tê 45 độ 300x200 và côn thu chữ nhật, LOD 350"],
  ];

  for (const [label, brief] of samples) {
    for (const options of [{}, { edit: true }, { datasheet: true }]) {
      const built = buildSystemPrompt(designerPrompt, { text: brief, options });
      assert.equal(built.dropped.length, 0, `${label} ${JSON.stringify(options)} dropped: ${built.dropped.join(", ")}`);
      assert.ok(
        built.prompt.length <= DEFAULT_BUDGET,
        `${label} prompt ${built.prompt.length} exceeded budget ${DEFAULT_BUDGET}`,
      );
      for (const required of REQUIRED_BLOCKS) {
        assert.ok(
          built.blocks.includes(required),
          `${label} ${JSON.stringify(options)} missing required block "${required}"`,
        );
      }
      assert.ok(
        built.blocks.includes("Build parity (studio ↔ .rfa)"),
        `${label} missing Build parity block`,
      );
    }

    const fullSystem = systemPrompt(400, null, { text: brief });
    assert.ok(fullSystem.includes("## Notes"), `${label} systemPrompt missing ## Notes`);
    assert.ok(fullSystem.includes("## Output shape"), `${label} systemPrompt missing ## Output shape`);
    assert.ok(
      fullSystem.includes("## Geometry quality checklist (self-check before returning)"),
      `${label} systemPrompt missing ## Geometry quality checklist`,
    );
  }
});
