#!/usr/bin/env node
/**
 * Design benchmark runner through the real `design()` pipeline.
 *
 * Usage:
 *   node bench/run.mjs --stub --mode both --runs 1
 *   node bench/run.mjs --mode both --runs 1 --limit 5
 *   node bench/run.mjs --model agy:gemini-4-neon-high --mode both --runs 3
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectAgentBackends, getCmdcModels } from "../server/src/agents.js";
import { config } from "../server/src/config.js";
import { design } from "../server/src/designer.js";
import { clearCachedResults } from "../server/src/result-cache.js";
import { renderPreviewPng, renderSideBySidePng } from "./preview.mjs";
import { scoreBenchmarkCase } from "./score.mjs";
import { createStubGenerator } from "./stub-generator.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASES_PATH = path.join(ROOT, "bench", "cases.json");

function parseArgs(argv) {
  const opts = {
    model: null,
    runs: 1,
    mode: "both",
    stub: false,
    ci: false,
    limit: Infinity,
    out: path.join(ROOT, "bench", "results", "latest"),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model") opts.model = argv[++i];
    else if (arg === "--runs") opts.runs = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === "--mode") opts.mode = argv[++i] || "both";
    else if (arg === "--stub") opts.stub = true;
    else if (arg === "--ci") opts.ci = true;
    else if (arg === "--limit") opts.limit = Math.max(1, Number(argv[++i]) || Infinity);
    else if (arg === "--out") opts.out = path.resolve(argv[++i]);
  }
  return opts;
}

async function resolveDefaultLiveModel(requested) {
  if (requested) return requested;
  if (config.agent.model) return config.agent.model;
  if (config.agent.provider === "openai") return config.llm.model;
  const backends = await detectAgentBackends();
  if (backends.commandcode) return undefined;
  const models = await getCmdcModels();
  return models[0]?.id ?? undefined;
}

function stdDev(values) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance) * 10) / 10;
}

function sumCallChars(stats) {
  const calls = Array.isArray(stats?.calls) ? stats.calls : [];
  const inChars =
    calls.length > 0
      ? calls.reduce((sum, c) => sum + (c.inChars ?? 0), 0)
      : stats?.promptChars ?? 0;
  const outChars = calls.reduce((sum, c) => sum + (c.outChars ?? 0), 0);
  return { inChars, outChars };
}

async function runOneMode(cases, mode, opts, liveModel, renderPreviews) {
  const prevMacros = process.env.AGENT_MACROS;
  process.env.AGENT_MACROS = mode === "before" ? "0" : "1";

  const results = [];
  const analysesById = new Map();

  try {
    for (const testCase of cases) {
      const runDetails = [];
      let bestAnalysis = null;
      let bestScore = null;

      for (let r = 0; r < opts.runs; r += 1) {
        clearCachedResults();
        const started = Date.now();
        const generate = opts.stub ? createStubGenerator(testCase, mode) : undefined;
        let result = null;
        let errorMessage = null;

        try {
          result = await design({
            prompt: testCase.prompt,
            currentSpec: null,
            lod: testCase.lod ?? 350,
            emit: () => {},
            model: liveModel || undefined,
            fresh: true,
            generate,
          });
        } catch (error) {
          errorMessage = error?.message ?? String(error);
        }

        const elapsedMs = result?.stats?.elapsedMs ?? Date.now() - started;
        const { inChars, outChars } = sumCallChars(result?.stats);
        const modelCalls = result?.stats?.modelCalls ?? 0;
        const attempts = result?.stats?.attempts ?? (modelCalls || 1);
        const repairs = Math.max(0, (modelCalls || attempts) - 1);

        const scored = result?.analysis
          ? scoreBenchmarkCase(testCase, result.analysis, {
              elapsedMs,
              inChars,
              outChars,
              modelCalls,
              repairs,
              model: result?.stats?.model ?? liveModel ?? "default",
            })
          : {
              id: testCase.id,
              group: testCase.group,
              supportsMacro: Boolean(testCase.supportsMacro),
              usedMacro: false,
              ok: false,
              totalScore: 0,
              breakdown: { valid: 0, bounds: 0, params: 0, geometry: 0, features: 0 },
              geometryQuality: { severeOverlaps: 0, components: 0, geomWarnings: 0, score: 0 },
              counts: { parts: 0, resolvedParts: 0, parameters: 0, connectors: 0, errors: 1, warnings: 0 },
              bounds: null,
              axisResults: {},
              maxDeltaMm: Infinity,
              featureChecks: [],
              elapsedMs,
              inChars,
              outChars,
              modelCalls,
              repairs,
              model: liveModel ?? "default",
              error: errorMessage,
            };

        runDetails.push({
          run: r + 1,
          score: scored.totalScore,
          ok: scored.ok,
          usedMacro: scored.usedMacro,
          repairs: scored.repairs,
          modelCalls: scored.modelCalls,
          elapsedMs: scored.elapsedMs,
          inChars: scored.inChars,
          outChars: scored.outChars,
          model: scored.model,
          ...(errorMessage ? { error: errorMessage } : {}),
        });

        if (!bestScore || scored.totalScore >= bestScore.totalScore) {
          bestScore = scored;
          bestAnalysis = result?.analysis ?? null;
        }
      }

      const nRuns = runDetails.length;
      const scores = runDetails.map((d) => d.score);
      const avgScore = Math.round((scores.reduce((acc, v) => acc + v, 0) / nRuns) * 10) / 10;
      const scoreStdDev = stdDev(scores);
      const passCount = runDetails.filter((d) => d.ok).length;
      const usedMacroCount = runDetails.filter((d) => d.usedMacro).length;
      const avgRepairs =
        Math.round((runDetails.reduce((s, d) => s + d.repairs, 0) / nRuns) * 10) / 10;
      const avgElapsedMs = Math.round(
        runDetails.reduce((s, d) => s + d.elapsedMs, 0) / nRuns,
      );
      const totalInChars = runDetails.reduce((s, d) => s + d.inChars, 0);
      const totalOutChars = runDetails.reduce((s, d) => s + d.outChars, 0);

      const entry = {
        ...bestScore,
        mode,
        runs: nRuns,
        avgScore,
        stdDev: scoreStdDev,
        minScore: Math.min(...scores),
        maxScore: Math.max(...scores),
        passCount,
        passRate: `${passCount}/${nRuns}`,
        usedMacroCount,
        usedMacroRate: `${usedMacroCount}/${nRuns}`,
        avgRepairs,
        avgElapsedMs,
        totalInChars,
        totalOutChars,
        runDetails,
      };
      results.push(entry);
      analysesById.set(testCase.id, { analysis: bestAnalysis, entry });

      if (renderPreviews && bestAnalysis) {
        const previewFile = path.join(opts.out, "previews", `${testCase.id}.${mode}.png`);
        renderPreviewPng(previewFile, bestAnalysis, {
          label: `${testCase.id} [${mode.toUpperCase()}]`,
          score: entry.avgScore,
          ok: entry.passCount > 0,
        });
      }
    }
  } finally {
    if (prevMacros === undefined) delete process.env.AGENT_MACROS;
    else process.env.AGENT_MACROS = prevMacros;
  }

  return { results, analysesById };
}

function summarize(entries) {
  const n = Math.max(1, entries.length);
  const macroEntries = entries.filter((e) => e.supportsMacro);
  const macroN = Math.max(1, macroEntries.length);
  const totalRuns = entries.reduce((s, e) => s + e.runs, 0);
  const totalPassRuns = entries.reduce((s, e) => s + e.passCount, 0);
  const macroTotalRuns = macroEntries.reduce((s, e) => s + e.runs, 0);
  const macroPassRuns = macroEntries.reduce((s, e) => s + e.passCount, 0);
  const totalInChars = entries.reduce((s, e) => s + e.totalInChars, 0);
  const totalOutChars = entries.reduce((s, e) => s + e.totalOutChars, 0);
  const totalElapsedMs = entries.reduce((s, e) => s + e.avgElapsedMs * e.runs, 0);

  return {
    cases: entries.length,
    passedCases: entries.filter((e) => e.passCount === e.runs).length,
    totalRuns,
    totalPassRuns,
    avgScore: Math.round((entries.reduce((s, e) => s + e.avgScore, 0) / n) * 10) / 10,
    avgStdDev: Math.round((entries.reduce((s, e) => s + e.stdDev, 0) / n) * 10) / 10,
    macroCases: macroEntries.length,
    macroPassedCases: macroEntries.filter((e) => e.passCount === e.runs).length,
    macroTotalRuns,
    macroPassRuns,
    macroAvgScore:
      Math.round((macroEntries.reduce((s, e) => s + e.avgScore, 0) / macroN) * 10) / 10,
    usedMacroCount: entries.filter((e) => e.usedMacroCount > 0).length,
    usedMacroRuns: entries.reduce((s, e) => s + e.usedMacroCount, 0),
    avgRepairs: Math.round((entries.reduce((s, e) => s + e.avgRepairs, 0) / n) * 100) / 100,
    totalElapsedMs,
    totalInChars,
    totalOutChars,
  };
}

function formatDuration(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

function buildComparisonMarkdown(beforeResults, afterResults, opts, resolvedModel) {
  const byIdBefore = new Map((beforeResults ?? []).map((r) => [r.id, r]));
  const rows = afterResults ?? beforeResults ?? [];
  const isStub = Boolean(opts.stub);

  const lines = [
    isStub
      ? "# [STUB — chỉ kiểm tra script, KHÔNG phải số đo model thật]"
      : "# Benchmark Thiết Kế Thực Tế (Live LLM): Before vs After Macro `trayRun`",
    "",
  ];

  if (isStub) {
    lines.push(
      "> **CẢNH BÁO:** Dữ liệu dưới đây chạy với `bench/stub-generator.mjs` (spec viết tay mô phỏng), CHỈ dùng kiểm tra luồng script và scorer trong CI — không phản ánh năng lực thực tế của model LLM.",
      "",
    );
  }

  lines.push(
    `- Kind: \`${isStub ? "stub-smoke-test" : "live-llm"}\` | Model: \`${resolvedModel ?? "default"}\` | Runs/case: \`${opts.runs}\` | Cases: \`${rows.length}\``,
    "",
  );

  if (beforeResults && afterResults) {
    const bSum = summarize(beforeResults);
    const aSum = summarize(afterResults);
    lines.push(
      "## Summary (Before `AGENT_MACROS=0` vs After `AGENT_MACROS=1`)",
      "",
      "| Scope | Metric | Before (`AGENT_MACROS=0`) | After (`AGENT_MACROS=1`) | Delta |",
      "|---|---|---:|---:|---:|",
      `| All (${aSum.cases}) | Pass / Runs | ${bSum.totalPassRuns}/${bSum.totalRuns} | ${aSum.totalPassRuns}/${aSum.totalRuns} | ${aSum.totalPassRuns - bSum.totalPassRuns >= 0 ? "+" : ""}${aSum.totalPassRuns - bSum.totalPassRuns} |`,
      `| All (${aSum.cases}) | Avg Score (±σ) | ${bSum.avgScore} (±${bSum.avgStdDev}) | ${aSum.avgScore} (±${aSum.avgStdDev}) | ${(aSum.avgScore - bSum.avgScore >= 0 ? "+" : "")}${(aSum.avgScore - bSum.avgScore).toFixed(1)} |`,
      `| Tray Macro (${aSum.macroCases}) | Pass / Runs | ${bSum.macroPassRuns}/${bSum.macroTotalRuns} | ${aSum.macroPassRuns}/${aSum.macroTotalRuns} | ${aSum.macroPassRuns - bSum.macroPassRuns >= 0 ? "+" : ""}${aSum.macroPassRuns - bSum.macroPassRuns} |`,
      `| Tray Macro (${aSum.macroCases}) | Avg Score | ${bSum.macroAvgScore} | ${aSum.macroAvgScore} | ${(aSum.macroAvgScore - bSum.macroAvgScore >= 0 ? "+" : "")}${(aSum.macroAvgScore - bSum.macroAvgScore).toFixed(1)} |`,
      `| All (${aSum.cases}) | Used trayRun (runs) | ${bSum.usedMacroRuns}/${bSum.totalRuns} | ${aSum.usedMacroRuns}/${aSum.totalRuns} | +${aSum.usedMacroRuns - bSum.usedMacroRuns} |`,
      `| All (${aSum.cases}) | Avg Repairs | ${bSum.avgRepairs} | ${aSum.avgRepairs} | ${(aSum.avgRepairs - bSum.avgRepairs).toFixed(2)} |`,
      `| All (${aSum.cases}) | Total Time | ${formatDuration(bSum.totalElapsedMs)} | ${formatDuration(aSum.totalElapsedMs)} | — |`,
      `| All (${aSum.cases}) | In / Out Chars | ${bSum.totalInChars.toLocaleString("en-US")} / ${bSum.totalOutChars.toLocaleString("en-US")} | ${aSum.totalInChars.toLocaleString("en-US")} / ${aSum.totalOutChars.toLocaleString("en-US")} | — |`,
      "",
    );
  }

  lines.push(
    "## Per-case Results",
    "",
    beforeResults && afterResults
      ? "| # | Case | Before Score (±σ) | Before Pass | After Score (±σ) | After Pass | Delta | trayRun | Repairs (B/A) | Time (B/A) | In/Out Chars (B → A) | Preview |"
      : "| # | Case | Score (±σ) | Pass | trayRun | Repairs | Time | In/Out Chars | Bounds (mm) |",
    beforeResults && afterResults
      ? "|---|---|---:|---:|---:|---:|---:|:---:|---:|---:|---|---|"
      : "|---|---|---:|---:|:---:|---:|---:|---|---|",
  );

  rows.forEach((row, index) => {
    if (beforeResults && afterResults) {
      const b = byIdBefore.get(row.id);
      const delta = b ? (row.avgScore - b.avgScore).toFixed(1) : "0.0";
      const sign = Number(delta) >= 0 ? `+${delta}` : delta;
      lines.push(
        `| ${index + 1} | \`${row.id}\` | ${b?.avgScore ?? "-"} (±${b?.stdDev ?? 0}) | ${b?.passRate ?? "-"} | ${row.avgScore} (±${row.stdDev}) | ${row.passRate} | ${sign} | ${row.usedMacroRate} | ${b?.avgRepairs ?? 0}/${row.avgRepairs} | ${formatDuration(b?.avgElapsedMs ?? 0)}/${formatDuration(row.avgElapsedMs)} | ${b?.totalInChars ?? 0}/${b?.totalOutChars ?? 0} → ${row.totalInChars}/${row.totalOutChars} | [before/after](previews/${row.id}.compare.png) |`,
      );
    } else {
      const bStr = row.bounds ? row.bounds.join("×") : "-";
      lines.push(
        `| ${index + 1} | \`${row.id}\` | ${row.avgScore} (±${row.stdDev}) | ${row.passRate} | ${row.usedMacroRate} | ${row.avgRepairs} | ${formatDuration(row.avgElapsedMs)} | ${row.totalInChars}/${row.totalOutChars} | ${bStr} |`,
      );
    }
  });

  lines.push("");
  return lines.join("\n");
}

export async function runBenchmark(customOpts = {}) {
  const opts = { ...parseArgs(process.argv), ...customOpts };
  const allCases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
  const cases = Number.isFinite(opts.limit) ? allCases.slice(0, opts.limit) : allCases;
  const liveModel = opts.stub ? "stub" : await resolveDefaultLiveModel(opts.model);

  const beforeRun =
    opts.mode === "before" || opts.mode === "both"
      ? await runOneMode(cases, "before", opts, liveModel, true)
      : null;
  const afterRun =
    opts.mode === "after" || opts.mode === "both"
      ? await runOneMode(cases, "after", opts, liveModel, true)
      : null;

  if (beforeRun && afterRun) {
    for (const testCase of cases) {
      const b = beforeRun.analysesById.get(testCase.id);
      const a = afterRun.analysesById.get(testCase.id);
      renderSideBySidePng(
        path.join(opts.out, "previews", `${testCase.id}.compare.png`),
        b?.analysis,
        a?.analysis,
        {
          label: `${testCase.id} [BEFORE: AGENT_MACROS=0]`,
          score: b?.entry.avgScore,
          ok: (b?.entry.passCount ?? 0) > 0,
        },
        {
          label: `${testCase.id} [AFTER: AGENT_MACROS=1]`,
          score: a?.entry.avgScore,
          ok: (a?.entry.passCount ?? 0) > 0,
        },
      );
    }
  }

  const beforeResults = beforeRun?.results ?? null;
  const afterResults = afterRun?.results ?? null;

  fs.mkdirSync(opts.out, { recursive: true });
  const report = {
    kind: opts.stub ? "stub-smoke-test" : "live-llm",
    generatedAt: new Date().toISOString(),
    options: {
      model: opts.model ?? "default",
      resolvedModel: liveModel ?? "default",
      runs: opts.runs,
      mode: opts.mode,
      stub: opts.stub,
      cases: cases.length,
    },
    summary: {
      before: beforeResults ? summarize(beforeResults) : null,
      after: afterResults ? summarize(afterResults) : null,
    },
    before: beforeResults,
    after: afterResults,
  };

  fs.writeFileSync(path.join(opts.out, "report.json"), JSON.stringify(report, null, 2));
  const md = buildComparisonMarkdown(beforeResults, afterResults, opts, liveModel);
  fs.writeFileSync(path.join(opts.out, "comparison.md"), md);
  return report;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv);
  const report = await runBenchmark(opts);
  const tag = opts.stub ? "[bench STUB — script check only]" : `[bench LIVE ${report.options.resolvedModel}]`;
  const after = report.summary.after ?? report.summary.before;
  console.log(
    `${tag} ${after.totalPassRuns}/${after.totalRuns} runs passed (${after.passedCases}/${after.cases} cases), avgScore=${after.avgScore}/100 (±${after.avgStdDev}), macro=${after.macroPassRuns}/${after.macroTotalRuns} (${after.macroAvgScore}/100)`,
  );
  if (report.summary.before && report.summary.after) {
    console.log(
      `${tag} before=${report.summary.before.avgScore} -> after=${report.summary.after.avgScore} (macro ${report.summary.before.macroAvgScore} -> ${report.summary.after.macroAvgScore}) | in/out before=${report.summary.before.totalInChars}/${report.summary.before.totalOutChars}, after=${report.summary.after.totalInChars}/${report.summary.after.totalOutChars}`,
    );
  }
  if (opts.ci && after.totalPassRuns < after.totalRuns) {
    process.exitCode = 1;
  }
}
