import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSystemPrompt, selectBlocks } from "../src/prompt-blocks.js";

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
