import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSystemPrompt, selectBlocks, splitPromptBlocks } from "../server/src/prompt-blocks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "..", "server", "prompts", "designer.md");
const md = fs.readFileSync(file, "utf8");

const { blocks } = splitPromptBlocks(md);
console.log("total chars", md.length);
for (const block of blocks) console.log(String(block.body.length).padStart(6), block.title);

const briefs = {
  "cable-ladder": "Thang cáp 400x100, 6 bậc thang, hai đầu connector, LOD 400",
  "ahu": "AHU 12000 CFM, coil, filter, fan, casing, LOD 300",
  "duct-tee": "Duct tee 45 độ, nhánh 300x200, LOD 350",
};

for (const [name, brief] of Object.entries(briefs)) {
  for (const options of [{}, { edit: true }, { patch: true }, { datasheet: true }]) {
    const { prompt, blocks: used, dropped } = buildSystemPrompt(md, { text: brief, options });
    console.log(
      `${name} ${JSON.stringify(options)} -> ${prompt.length} chars | ${used.length} blocks | dropped: ${dropped.join(", ")}`,
    );
  }
}

const wanted = selectBlocks({ text: briefs["cable-ladder"] });
console.log("cable-ladder selected:", [...wanted].join(" | "));
