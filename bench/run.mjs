#!/usr/bin/env node
/**
 * Design benchmark runner through the real `design()` pipeline.
 *
 * Usage:
 *   node bench/run.mjs --stub --mode both --runs 1
 *   node bench/run.mjs --stub --mode after --ci
 *   node bench/run.mjs --model deepseek/deepseek-v4.1-flash --runs 1 --limit 5
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { design } from "../server/src/designer.js";
import { clearCachedResults } from "../server/src/result-cache.js";
import { renderPreviewPng } from "./preview.mjs";
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

async function runOneMode(cases, mode, opts, renderPreviews) {
  const results = [];
  for (const testCase of cases) {
    const runScores = [];
    let bestAnalysis = null;
    let bestScore = null;

    for (let r = 0; r < opts.runs; r += 1) {
      clearCachedResults();
      const started = Date.now();
      const generate = opts.stub ? createStubGenerator(testCase, mode) : undefined;
      const result = await design({
        prompt: testCase.prompt,
        currentSpec: null,
        lod: testCase.lod ?? 350,
        emit: () => {},
        model: opts.model || undefined,
        generate,
      });
      const elapsedMs = result?.stats?.elapsedMs ?? Date.now() - started;
      const scored = scoreBenchmarkCase(testCase, result.analysis, {
        elapsedMs,
        promptChars: result?.stats?.promptChars ?? 0,
        modelCalls: result?.stats?.modelCalls ?? 0,
      });
      runScores.push(scored);
      if (!bestScore || scored.totalScore >= bestScore.totalScore) {
        bestScore = scored;
        bestAnalysis = result.analysis;
      }
    }

    const avgScore = Math.round(
      (runScores.reduce((acc, s) => acc + s.totalScore, 0) / runScores.length) * 10,
    ) / 10;
    const passCount = runScores.filter((s) => s.ok).length;

    const entry = {
      ...bestScore,
      mode,
      runs: opts.runs,
      avgScore,
      passRate: `${passCount}/${opts.runs}`,
    };
    results.push(entry);

    if (renderPreviews && bestAnalysis) {
      const previewFile = path.join(opts.out, "previews", `${testCase.id}.${mode}.png`);
      renderPreviewPng(previewFile, bestAnalysis, {
        label: `${testCase.id} [${mode}]`,
        score: entry.totalScore,
      });
    }
  }
  return results;
}

function summarize(entries) {
  const n = Math.max(1, entries.length);
  const macroEntries = entries.filter((e) => e.supportsMacro);
  const macroN = Math.max(1, macroEntries.length);
  return {
    cases: entries.length,
    passed: entries.filter((e) => e.ok).length,
    avgScore: Math.round((entries.reduce((s, e) => s + e.avgScore, 0) / n) * 10) / 10,
    macroCases: macroEntries.length,
    macroPassed: macroEntries.filter((e) => e.ok).length,
    macroAvgScore:
      Math.round((macroEntries.reduce((s, e) => s + e.avgScore, 0) / macroN) * 10) / 10,
    usedMacroCount: entries.filter((e) => e.usedMacro).length,
  };
}

function buildComparisonMarkdown(beforeResults, afterResults, opts) {
  const byIdBefore = new Map((beforeResults ?? []).map((r) => [r.id, r]));
  const rows = afterResults ?? beforeResults ?? [];
  const lines = [
    "# Family Agent Design Benchmark",
    "",
    `- Mode: \`${opts.stub ? "stub" : "live"}\` | Model: \`${opts.model ?? "default"}\` | Runs/case: \`${opts.runs}\``,
    "",
  ];

  if (beforeResults && afterResults) {
    const bSum = summarize(beforeResults);
    const aSum = summarize(afterResults);
    lines.push(
      "## Summary (Before vs After Sheet-Metal Macro)",
      "",
      "| Scope | Metric | Before | After | Delta |",
      "|---|---|---:|---:|---:|",
      `| All (${aSum.cases}) | Pass Rate | ${bSum.passed}/${bSum.cases} | ${aSum.passed}/${aSum.cases} | +${aSum.passed - bSum.passed} |`,
      `| All (${aSum.cases}) | Avg Score | ${bSum.avgScore} | ${aSum.avgScore} | +${(aSum.avgScore - bSum.avgScore).toFixed(1)} |`,
      `| Tray Macro (${aSum.macroCases}) | Pass Rate | ${bSum.macroPassed}/${bSum.macroCases} | ${aSum.macroPassed}/${aSum.macroCases} | +${aSum.macroPassed - bSum.macroPassed} |`,
      `| Tray Macro (${aSum.macroCases}) | Avg Score | ${bSum.macroAvgScore} | ${aSum.macroAvgScore} | +${(aSum.macroAvgScore - bSum.macroAvgScore).toFixed(1)} |`,
      "",
    );
  }

  lines.push(
    "## Per-case Results",
    "",
    beforeResults && afterResults
      ? "| # | Case | Group | Before | After | Delta | Bounds (mm) | Macro |"
      : "| # | Case | Group | Score | Ok | Parts | Bounds (mm) | Macro |",
    beforeResults && afterResults
      ? "|---|---|---|---:|---:|---:|---|---|"
      : "|---|---|---|---:|:---:|---:|---|---|",
  );

  rows.forEach((row, index) => {
    const bStr = row.bounds ? row.bounds.join("×") : "-";
    if (beforeResults && afterResults) {
      const b = byIdBefore.get(row.id);
      const delta = b ? (row.avgScore - b.avgScore).toFixed(1) : "0.0";
      const sign = Number(delta) >= 0 ? `+${delta}` : delta;
      lines.push(
        `| ${index + 1} | \`${row.id}\` | ${row.group} | ${b?.avgScore ?? "-"} (${b?.ok ? "OK" : "FAIL"}) | ${row.avgScore} (${row.ok ? "OK" : "FAIL"}) | ${sign} | ${bStr} | ${row.usedMacro ? "yes" : "no"} |`,
      );
    } else {
      lines.push(
        `| ${index + 1} | \`${row.id}\` | ${row.group} | ${row.avgScore} | ${row.ok ? "OK" : "FAIL"} | ${row.counts.resolvedParts} | ${bStr} | ${row.usedMacro ? "yes" : "no"} |`,
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

  const beforeResults =
    opts.mode === "before" || opts.mode === "both"
      ? await runOneMode(cases, "before", opts, opts.mode === "before")
      : null;
  const afterResults =
    opts.mode === "after" || opts.mode === "both"
      ? await runOneMode(cases, "after", opts, true)
      : null;

  fs.mkdirSync(opts.out, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    options: { model: opts.model ?? "default", runs: opts.runs, mode: opts.mode, stub: opts.stub },
    summary: {
      before: beforeResults ? summarize(beforeResults) : null,
      after: afterResults ? summarize(afterResults) : null,
    },
    before: beforeResults,
    after: afterResults,
  };

  fs.writeFileSync(path.join(opts.out, "report.json"), JSON.stringify(report, null, 2));
  const md = buildComparisonMarkdown(beforeResults, afterResults, opts);
  fs.writeFileSync(path.join(opts.out, "comparison.md"), md);
  return report;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv);
  const report = await runBenchmark(opts);
  const after = report.summary.after ?? report.summary.before;
  console.log(
    `[bench] ${after.passed}/${after.cases} passed, avgScore=${after.avgScore}/100, macro=${after.macroPassed}/${after.macroCases} (${after.macroAvgScore}/100)`,
  );
  if (report.summary.before && report.summary.after) {
    console.log(
      `[bench] before=${report.summary.before.avgScore} -> after=${report.summary.after.avgScore} (macro ${report.summary.before.macroAvgScore} -> ${report.summary.after.macroAvgScore})`,
    );
  }
  if (opts.ci && after.passed < after.cases) {
    process.exitCode = 1;
  }
}
