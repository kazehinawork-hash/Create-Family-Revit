import fs from "node:fs";
import path from "node:path";

import { design } from "../server/src/designer.js";
import { applyFastParameterEdit, parseFastParameterEdit } from "../server/src/fast-edit.js";
import { clearCachedResults } from "../server/src/result-cache.js";

/**
 * Router benchmark on a real saved family, with a deterministic stub agent so the
 * run costs no quota. "Before" replays the old behaviour: one tier, full spec.
 */

const TEE_PATH = path.join(
  process.cwd(),
  "saved-models",
  "1794390236816-thinh-phat-cable-ladder-mitered-tee.json",
);

const saved = JSON.parse(fs.readFileSync(TEE_PATH, "utf8"));
const baseSpec = saved.spec ?? saved;

const CASES = [
  { prompt: "đổi Ladder Width 1 thành 500", check: (s) => value(s, "Ladder Width 1") === 500 },
  { prompt: "tăng Ladder Height thêm 20mm", check: (s) => value(s, "Ladder Height") === 120 },
  { prompt: "giảm Ladder Width 2 10%", check: (s) => value(s, "Ladder Width 2") === 270 },
  { prompt: "đổi tên Ladder Width 1 thành Máng rộng", check: (s) => Boolean(s.parameters.find((p) => p.name === "Máng rộng")) },
  { prompt: "đổi màu ThinhPhat_PowderCoated_RAL7035 thành đỏ", check: (s) => (s.materials ?? []).some((m) => m.color === "#ff2222") },
  { prompt: "thêm connector branch ở cạnh bên", check: (s) => (s.connectors ?? []).length > baseCount("connectors") },
  { prompt: "bớt rung 2", check: (s) => (s.parts ?? []).length < baseCount("parts") },
  { prompt: "thay connector main-in bằng loại lớn hơn", check: (s) => (s.connectors ?? []).length >= baseCount("connectors") },
  { prompt: "đổi Ladder Width 1 thành 450 chứ không phải 500", check: (s) => value(s, "Ladder Width 1") === 450 },
  { prompt: "thêm connector branch ở cạnh bên" }, // repeat: should hit the cache
];

function value(spec, name) {
  return spec.parameters?.find((param) => param.name === name)?.value;
}

function baseCount(key) {
  return (baseSpec[key] ?? []).length;
}

/** A "competent model": does what the prompt asks, never breaks the spec. */
function stubSpec(prompt) {
  const spec = JSON.parse(JSON.stringify(baseSpec));

  if (/thêm connector|add connector/i.test(prompt)) {
    spec.connectors = [
      ...(spec.connectors ?? []),
      {
        id: "branch-extra",
        name: "Branch Extra",
        systemType: "CableTray",
        shape: "rectangular",
        origin: { x: 0, y: -640, z: 50 },
        directionVector: { x: 0, y: -1, z: 0 },
        width: 300,
        height: 100,
      },
    ];
    return spec;
  }

  if (/bớt rung 2|remove rung 2/i.test(prompt)) {
    spec.parts = (spec.parts ?? []).filter((part) => !/rung 2/i.test(part.name ?? ""));
    return spec;
  }

  if (/thay connector main-in/i.test(prompt)) {
    const connector = (spec.connectors ?? []).find((item) => item.id === "main-in");
    if (connector) connector.width = 600;
    return spec;
  }

  // The stub can also do precise edits (this is what the old flow asked a model to do).
  const edit = parseFastParameterEdit(prompt, spec);
  const edited = edit ? applyFastParameterEdit(spec, edit) : null;
  return edited ?? spec;
}

async function runCase(testCase, legacy) {
  const calls = [];
  const generate = async (messages, options) => {
    calls.push({
      model: options?.model ?? "default",
      chars: messages.reduce((total, message) => total + message.content.length, 0),
    });
    return { json: stubSpec(testCase.prompt), text: "", usage: null };
  };

  const started = Date.now();
  const result = await design({
    prompt: testCase.prompt,
    currentSpec: baseSpec,
    lod: 300,
    emit: () => {},
    generate,
    legacy,
  });
  const elapsedMs = Date.now() - started;

  const ok = testCase.check ? testCase.check(result.analysis.spec) : result.analysis.ok;
  return {
    tier: result.stats.tier,
    tierLabel: result.stats.tierLabel,
    model: result.stats.model ?? "-",
    calls: calls.length,
    promptChars: calls.reduce((total, call) => total + call.chars, 0),
    elapsedMs,
    ok: Boolean(ok && result.analysis.ok),
  };
}

const rows = [];

// One cache per mode: the repeated request at the end shows the cache saving.
clearCachedResults();
for (const testCase of CASES) {
  const before = await runCase(testCase, true);
  rows.push({ prompt: testCase.prompt, before });
}

clearCachedResults();
for (let index = 0; index < CASES.length; index += 1) {
  rows[index].after = await runCase(CASES[index], false);
}

const totals = rows.reduce(
  (acc, row) => ({
    beforeCalls: acc.beforeCalls + row.before.calls,
    afterCalls: acc.afterCalls + row.after.calls,
    beforeChars: acc.beforeChars + row.before.promptChars,
    afterChars: acc.afterChars + row.after.promptChars,
    beforeOk: acc.beforeOk + (row.before.ok ? 1 : 0),
    afterOk: acc.afterOk + (row.after.ok ? 1 : 0),
  }),
  { beforeCalls: 0, afterCalls: 0, beforeChars: 0, afterChars: 0, beforeOk: 0, afterOk: 0 },
);

console.log("| # | Yêu cầu | Trước: tầng/model/lượt/prompt | Sau: tầng/model/lượt/prompt | Đúng trước → sau |");
console.log("|---|---|---|---|---|");

rows.forEach((row, index) => {
  const fmt = (side) =>
    `${side.tier} · ${side.model} · ${side.calls} lượt · ${Math.round(side.promptChars / 1000)}k`;
  console.log(
    `| ${index + 1} | ${row.prompt} | ${fmt(row.before)} | ${fmt(row.after)} | ${
      row.before.ok ? "✓" : "✗"
    } → ${row.after.ok ? "✓" : "✗"} |`,
  );
});

console.log("");
console.log("Tổng hợp:");
console.log(`- Lượt gọi model: ${totals.beforeCalls} → ${totals.afterCalls}`);
console.log(
  `- Ký tự prompt: ${Math.round(totals.beforeChars / 1000)}k → ${Math.round(totals.afterChars / 1000)}k`,
);
console.log(`- Đúng: ${totals.beforeOk}/${rows.length} → ${totals.afterOk}/${rows.length}`);
