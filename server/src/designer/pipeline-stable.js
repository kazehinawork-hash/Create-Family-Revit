import fs from "node:fs";
import path from "node:path";
import {
  analyzeSpec,
  buildParameterGraph,
  collectConnectorDependencies,
  collectPartDependencies,
  formatIssues,
  parameterDependencySummary,
} from "@family/spec-core";
import { generateJson } from "../agents.js";
import {
  buildSupplementPrompt,
  checkCompleteness,
  extractChecklistHeuristic,
} from "../checklist.js";
import { config } from "../config.js";
import { applyFastParameterEdit, parseFastParameterEdit } from "../fast-edit.js";
import { applySpecPatch, describeSpecPatch, isFullSpec } from "../patch.js";
import { cacheKey, readCachedResultEntry, writeCachedResult } from "../result-cache.js";
import { isOutputLimitError } from "../retry.js";
import {
  DEFAULT_LOD,
  IMAGE_EXTENSIONS,
  JSON_OUTPUT_CONTRACT,
  LOD_LEVELS,
  PROSE_REPAIR,
  SPEC_PATCH_CONTRACT,
  TIMEOUT_RETRY,
  documentMessages,
  imagePartsFor,
  isTimeoutError,
  promptWithDesignTargets,
  repairInstructions,
  replyLanguageInstruction,
  splitNewBrief,
  summarise,
  systemPrompt,
  turnTimeoutMs,
} from "./prompts.js";
import { autoHealSpec, boundsOf, geometryDrift } from "./repair.js";
import { fillMissingFromTemplate } from "./templates.js";

/**
 * Stable design pipeline: one model, one conversation, up to three repair turns.
 */
export async function designStable(options) {
  const startedAt = Date.now();
  const {
    prompt: rawPrompt,
    currentSpec,
    lod,
    emit,
    model,
    customApiConfig,
    commandCodeApiKey,
    attachments,
    targets = [],
    signal,
    fresh,
    language,
  } = options;
  const prompt = promptWithDesignTargets(rawPrompt, targets, currentSpec);
  const send = typeof emit === "function" ? emit : () => {};
  const generate = options.generate ?? generateJson;
  const level = LOD_LEVELS.includes(Number(lod)) ? Number(lod) : DEFAULT_LOD;
  const deadline = startedAt + config.agent.totalTimeoutMs;
  const canCache = Boolean(currentSpec) && !attachments?.length && !customApiConfig;
  const resultKey = canCache
    ? cacheKey({ prompt, currentSpec, lod: level, model: model || "" })
    : null;

  if (resultKey && !fresh) {
    const cached = readCachedResultEntry(resultKey);
    if (cached) {
      send({ type: "stage", stage: "checking", message: "Using cached result" });
      return {
        analysis: cached.value.analysis,
        stats: { ...cached.value.stats, cached: true, cachedAt: cached.at, elapsedMs: 0 },
      };
    }
  }

  // Tier 0: deterministic parameter edit without calling the model.
  if (currentSpec && !attachments?.length && targets.length === 0) {
    const edit = parseFastParameterEdit(prompt, currentSpec);
    const nextSpec = edit ? applyFastParameterEdit(currentSpec, edit) : null;
    if (nextSpec) {
      send({ type: "stage", stage: "checking", message: "Applying parameter change" });
      const analysis = analyzeSpec(nextSpec);
      if (analysis.ok) {
        analysis.spec.lod = level;
        const graph = buildParameterGraph(nextSpec.parameters);
        const editedNames = Array.isArray(edit.changes)
          ? edit.changes.map((change) => change.name).filter(Boolean)
          : edit.name && !edit.kind
            ? [edit.name]
            : [];
        const affectedParameters = editedNames.length > 0 ? graph.impactOf(editedNames) : [];
        const affectedKeys = new Set(
          [...editedNames, ...affectedParameters].map((name) => name.toLowerCase()),
        );
        const affectedParts = collectPartDependencies(nextSpec)
          .filter((part) => part.parameters.some((name) => affectedKeys.has(name.toLowerCase())))
          .map((part) => part.name);
        const affectedConnectors = collectConnectorDependencies(nextSpec)
          .filter((connector) =>
            connector.parameters.some((name) => affectedKeys.has(name.toLowerCase())),
          )
          .map((connector) => connector.name);

        const stats = {
          ...summarise(analysis.spec, analysis.model),
          lod: level,
          attempts: 0,
          elapsedMs: Date.now() - startedAt,
          usage: null,
          model: model || null,
          modelCalls: 0,
          fastEdit: { ...edit, affectedParameters, affectedParts, affectedConnectors },
        };
        if (resultKey) writeCachedResult(resultKey, { analysis, stats });
        return { analysis, stats };
      }
    }
  }

  const imageParts = imagePartsFor(attachments, customApiConfig);
  for (const file of attachments ?? []) {
    if (!file?.path || !fs.existsSync(file.path)) {
      throw new Error(
        `Không tìm thấy tệp đính kèm "${file?.name || file?.path || "?"}" trên ổ đĩa.`,
      );
    }
  }

  const modelAttachments = (attachments ?? []).filter(
    (file) =>
      !(imageParts.length > 0 && IMAGE_EXTENSIONS[path.extname(file.path ?? "").toLowerCase()]),
  );
  const documents = await documentMessages(modelAttachments, send);

  let modelCalls = 0;
  let usage = null;
  const callStats = [];

  const checklist = (() => {
    if (process.env.AGENT_COMPLETENESS === "0") return null;
    try {
      return extractChecklistHeuristic(prompt);
    } catch {
      return null;
    }
  })();
  const hasRequirements = Boolean(
    checklist && ((checklist.groups?.length ?? 0) > 0 || Number(checklist.connectors) > 0),
  );
  const gapsFor = (analysis) =>
    checkCompleteness(analysis.spec, checklist, {
      bounds: analysis.model?.bounds?.size ?? null,
    });
  const describeGaps = (gaps) =>
    gaps.missing
      .slice(0, 5)
      .map((item) => item.label ?? item.message)
      .join(", ");

  const warnings = [];

  const freshMessages = (
    instruction,
    baseSpec,
    { dependencyMap = true, focus = "", patch = false } = {},
  ) => {
    const out = [
      {
        role: "system",
        content: systemPrompt(level, null, {
          text: focus || instruction,
          patch,
          edit: Boolean(baseSpec),
          datasheet: documents.length > 0,
        }),
      },
      ...documents,
    ];

    if (baseSpec) {
      const map = dependencyMap ? parameterDependencySummary(baseSpec, 6000, focus) : "";
      const dependencyBlock = map
        ? `${map}\n\nUse this map before changing anything: update the base parameter and every dependent parameter/part it reaches. Do not hard-code a value that the map says is derived.\n\n`
        : "";
      out.push({
        role: "user",
        content: `Here is the current spec. Apply my next request to it.\n${dependencyBlock}${JSON.stringify(baseSpec)}`,
      });
    }

    const request = `${instruction}\n\n${replyLanguageInstruction(language)}\n\n---\n${JSON_OUTPUT_CONTRACT}${patch ? `\n\n${SPEC_PATCH_CONTRACT}` : ""}`;
    out.push({
      role: "user",
      content: imageParts.length > 0 ? [{ type: "text", text: request }, ...imageParts] : request,
    });
    return out;
  };

  const scoreOf = (candidate) => {
    const gaps = hasRequirements && candidate?.spec ? gapsFor(candidate) : null;
    return [
      candidate?.ok ? 0 : 1,
      gaps ? gaps.missing.length : 0,
      candidate?.errors?.length ?? 999,
      candidate?.issues?.length ?? 999,
      -(candidate?.spec?.parts?.length ?? 0),
    ];
  };

  const isBetter = (next, best) => {
    if (!best) return true;
    const a = scoreOf(next);
    const b = scoreOf(best);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] < b[index];
    }
    return true;
  };

  const runTurn = async (text, spec, { enforceCompleteness = true, section = false } = {}) => {
    const budget = {
      repair: config.agent.repairMax,
      supplement: config.agent.supplementMax,
      layout: config.agent.layoutMax,
      prose: config.agent.proseMax,
      timeout: config.agent.timeoutRetryMax,
      maxTurns: 1,
    };
    const callsMax = Math.max(1, config.agent.turnCallsMax);
    const editBefore = spec && !section ? boundsOf(spec) : null;

    let messages = freshMessages(text, spec, { focus: text, patch: Boolean(spec) && section });
    let patchBase = spec && section ? spec : null;
    let analysis = null;
    let bestAnalysis = null;
    let attempts = 0;
    let timeoutCap = Number.POSITIVE_INFINITY;
    let latestGaps = null;
    let nextReason = null;
    let turnExtraTurns = 0;
    let callLog = null;
    let repairsUsed = 0;

    while (attempts < callsMax) {
      const remaining = deadline - Date.now();
      if (attempts > 0 && remaining <= 5000) break;
      attempts += 1;

      const timeoutMs = Math.max(
        5000,
        Math.min(
          turnTimeoutMs({ hasCurrentSpec: Boolean(spec) && !section, remainingMs: remaining }),
          timeoutCap,
        ),
      );

      if (attempts === 1) {
        send({ type: "stage", stage: "generating", message: "Đang dựng…" });
      } else if (nextReason) {
        send({ type: "stage", stage: "repairing", message: nextReason });
        nextReason = null;
      }

      let result;
      const turnStartedAt = Date.now();
      const ticker = setInterval(() => {
        const seconds = Math.round((Date.now() - turnStartedAt) / 1000);
        send({ type: "stage", stage: "working", message: `Đang dựng… ${seconds}s` });
      }, 15000);
      ticker.unref?.();

      try {
        modelCalls += 1;
        const promptBytes = JSON.stringify(messages).length;
        const turnStart = Date.now();
        callLog = () =>
          `[design] call #${modelCalls} model=${model || "default"} prompt=${promptBytes}B ` +
          `elapsed=${Math.round((Date.now() - turnStart) / 1000)}s`;

        result = await generate(messages, {
          ...(model ? { model } : {}),
          ...(customApiConfig ? { customApiConfig } : {}),
          ...(commandCodeApiKey ? { commandCodeApiKey } : {}),
          ...(modelAttachments.length > 0 ? { attachments: modelAttachments } : {}),
          ...(signal ? { signal } : {}),
          timeoutMs,
          commandCodeMaxTurns: turnExtraTurns,
          effort: config.agent.buildEffort,
          onProgress: (message) => send({ type: "stage", stage: "working", message }),
        });
        console.log(`${callLog()} reason=ok`);
        callLog = null;

        const metrics = result.metrics ?? {};
        const totalMs = metrics.totalMs ?? Date.now() - turnStart;
        const firstTokenMs = metrics.firstTokenMs ?? null;
        const via = metrics.via ?? (customApiConfig ? "api" : "cli");
        callStats.push({
          model: result.model || model || "default",
          inChars: promptBytes,
          outChars: metrics.outChars ?? result.text?.length ?? 0,
          firstTokenMs,
          totalMs,
          effort: config.agent.buildEffort || null,
          via,
        });
        console.log(
          `[model] ${result.model || model || "default"} in=${promptBytes} ` +
            `out=${callStats[callStats.length - 1].outChars} ` +
            `first-token=${firstTokenMs === null ? "-" : Math.round(firstTokenMs / 1000)}s ` +
            `total=${Math.round(totalMs / 1000)}s effort=${config.agent.buildEffort || "default"} via=${via}`,
        );
      } catch (error) {
        if (callLog) {
          const reason = isOutputLimitError(error)
            ? "output_limit"
            : error?.code === "MAX_TURNS"
              ? "max_turns"
              : isTimeoutError(error)
                ? "timeout"
                : signal?.aborted
                  ? "cancelled"
                  : "error";
          console.log(
            `${callLog()} reason=${reason} detail=${String(error?.message ?? error).slice(0, 160)}`,
          );
          callLog = null;
        }
        if (signal?.aborted || error?.name === "AbortError") throw error;
        if (isOutputLimitError(error)) throw error;

        if (
          isTimeoutError(error) &&
          budget.timeout > 0 &&
          attempts < callsMax &&
          deadline - Date.now() > 60000
        ) {
          if (!spec) {
            const sections = splitNewBrief(text, 0);
            if (sections && sections.length > 1) throw error;
          }
          budget.timeout -= 1;
          timeoutCap = Math.max(60000, Math.round(timeoutMs / 2));
          send({
            type: "stage",
            stage: "retrying",
            message: `Hết thời gian lượt ${attempts} — thử lại với yêu cầu gọn hơn`,
          });
          messages = freshMessages(`${text}\n\n${TIMEOUT_RETRY}`, spec, { focus: text });
          continue;
        }

        if (bestAnalysis?.spec) {
          console.warn(
            `[design] attempt ${attempts} failed, keeping the best spec so far:`,
            error?.message,
          );
          warnings.push(
            `Lượt ${attempts} lỗi (${error?.message ?? error}) — giữ bản tốt nhất đã dựng.`,
          );
          analysis = bestAnalysis;
          break;
        }

        if (error?.code === "MAX_TURNS" && budget.maxTurns > 0 && attempts < callsMax) {
          budget.maxTurns -= 1;
          send({
            type: "stage",
            stage: "retrying",
            message: "Model hết lượt của CLI — thử lại với thêm 1 lượt",
          });
          messages = freshMessages(`${text}\n\n${TIMEOUT_RETRY}`, spec, { focus: text });
          turnExtraTurns += 1;
          continue;
        }

        if (error?.name !== "LlmError") throw error;

        const proseText = typeof error.text === "string" ? error.text.trim() : "";
        if (!proseText || budget.prose <= 0 || attempts >= callsMax) throw error;

        budget.prose -= 1;
        send({
          type: "stage",
          stage: "repairing",
          message: "The answer was prose — asking for the JSON spec again",
        });
        messages = freshMessages(`${PROSE_REPAIR}\n\nOriginal request:\n${text}`, spec, {
          focus: text,
        });
        continue;
      } finally {
        clearInterval(ticker);
      }

      usage = result.usage ?? usage;
      console.log(
        `[design] attempt ${attempts} answered in ${Math.round((Date.now() - startedAt) / 1000)}s` +
          `${result.usage?.total_tokens ? `, ${result.usage.total_tokens} tokens` : ""}`,
      );
      send({ type: "stage", stage: "checking", message: "Đang tự kiểm tra…" });

      if (result?.json && typeof result.json === "object") {
        if (patchBase && !isFullSpec(result.json)) {
          const delta = result.json;
          result.json = applySpecPatch(patchBase, delta);
          console.log(
            `[design] patch merged (${describeSpecPatch(delta)}) parts=${(result.json.parts ?? []).length}`,
          );
        }
        result.json = autoHealSpec(result.json);
      }
      analysis = analyzeSpec(result.json);

      const drifted =
        editBefore && analysis.ok && bestAnalysis?.ok
          ? geometryDrift(editBefore, analysis.model?.bounds, spec, analysis.spec)
          : null;
      if (!drifted && isBetter(analysis, bestAnalysis)) {
        bestAnalysis = analysis;
      } else if (drifted) {
        console.warn(`[design] attempt ${attempts} drifted, keeping the earlier spec: ${drifted}`);
      }

      if (attempts >= callsMax) break;

      if (analysis.ok) {
        if (enforceCompleteness && hasRequirements) {
          const gaps = gapsFor(analysis);
          latestGaps = gaps;
          if (!gaps.ok && budget.supplement > 0 && repairsUsed === 0) {
            budget.supplement -= 1;
            send({
              type: "stage",
              stage: "completing",
              message: `Thiếu ${describeGaps(gaps)} — bổ sung`,
            });
            patchBase = result.json;
            messages = freshMessages(buildSupplementPrompt(gaps.missing, text), patchBase, {
              focus: text,
              patch: true,
            });
            continue;
          }
        }

        const layoutIssues = analysis.issues.filter((issue) => issue.path.startsWith("logic."));
        const unusedParameterIssues = analysis.issues.filter(
          (issue) =>
            issue.path.startsWith("parameters.") && /không điều khiển hình/.test(issue.message),
        );
        const fixableIssues = [...layoutIssues, ...unusedParameterIssues];
        const severeLayout = layoutIssues.some((issue) => issue.path.startsWith("logic.drain-pan"));
        if (
          process.env.LAYOUT_PASS !== "0" &&
          (severeLayout || layoutIssues.length >= 2 || unusedParameterIssues.length > 0) &&
          budget.layout > 0
        ) {
          budget.layout -= 1;
          nextReason =
            unusedParameterIssues.length > 0 && layoutIssues.length === 0
              ? `Nối hoặc bỏ ${unusedParameterIssues.length} tham số không dùng`
              : `Sửa ${fixableIssues.length} lỗi mô hình`;
          send({
            type: "stage",
            stage: "repairing",
            message: nextReason,
            issues: fixableIssues.slice(0, 12),
          });
          patchBase = result.json;
          messages = freshMessages(
            `Original request:\n${text}\n\n${repairInstructions(result.json, fixableIssues, text)}`,
            patchBase,
            { dependencyMap: false, patch: true },
          );
          continue;
        }
        break;
      }

      if (budget.repair <= 0) break;
      budget.repair -= 1;
      repairsUsed += 1;
      send({
        type: "stage",
        stage: "repairing",
        message: `Còn ${analysis.errors.length} lỗi`,
        issues: analysis.errors.slice(0, 12),
      });
      patchBase = result.json;
      messages = freshMessages(
        `Original request:\n${text}\n\n${repairInstructions(result.json, analysis.errors, text)}`,
        patchBase,
        { dependencyMap: false, patch: true },
      );
    }

    if (bestAnalysis && (!analysis || isBetter(bestAnalysis, analysis))) {
      analysis = bestAnalysis;
    }
    if (hasRequirements && enforceCompleteness && analysis?.spec) latestGaps = gapsFor(analysis);

    return { analysis, attempts, gaps: latestGaps };
  };

  let outcome;

  const buildBySections = async (steps) => {
    console.log(`[design] rebuilding in ${steps.length} sections`);
    send({
      type: "stage",
      stage: "retrying",
      message: `Chia yêu cầu thành ${steps.length} bước nhỏ`,
    });

    let spec = null;
    let stepsDone = 0;
    let totalAttempts = 0;
    let finalGaps = null;
    const queue = [...steps];

    for (const [index, step] of queue.entries()) {
      try {
        const stepOutcome = await runTurn(step.prompt, spec, {
          enforceCompleteness: index === queue.length - 1,
          section: true,
        });
        totalAttempts += stepOutcome.attempts;
        if (stepOutcome.gaps) finalGaps = stepOutcome.gaps;

        if (stepOutcome.analysis?.ok) {
          spec = stepOutcome.analysis.spec;
          stepsDone += 1;
        } else {
          warnings.push(
            `Bước "${step.label}" chưa hợp lệ: ${formatIssues(stepOutcome.analysis?.errors ?? [])} — bỏ qua, giữ bản trước.`,
          );
        }
      } catch (stepError) {
        if (signal?.aborted || stepError?.name === "AbortError") throw stepError;
        const reason = stepError?.message ?? String(stepError);

        if (isOutputLimitError(stepError) && stepsDone === 0 && index === 0) {
          const finer = splitNewBrief(
            step.prompt,
            Math.max(600, Math.floor(step.prompt.length / 3)),
          );
          if (finer && finer.length > 1) {
            console.warn(
              `[design] skeleton hit OUTPUT_LIMIT — splitting into ${finer.length} smaller parts`,
            );
            queue.push(
              ...finer.map((part, offset) => ({ ...part, label: `${step.label}.${offset + 1}` })),
            );
            warnings.push(
              `Mục "${step.label}" quá dài — chia nhỏ thành ${finer.length} phần rồi dựng tiếp.`,
            );
            continue;
          }
        }

        if (isOutputLimitError(stepError)) {
          warnings.push(`Bước "${step.label}" vượt giới hạn độ dài (${reason}) — dừng chia nhỏ.`);
          break;
        }

        if (isTimeoutError(stepError)) {
          warnings.push(`Bước "${step.label}" hết thời gian — bỏ qua, dựng tiếp các bước sau.`);
          continue;
        }
        warnings.push(`Bước "${step.label}" lỗi (${reason}) — giữ phần đã dựng.`);
        break;
      }
    }

    if (stepsDone === 0) return null;
    return { analysis: analyzeSpec(spec), attempts: totalAttempts, gaps: finalGaps };
  };

  const plannedSections =
    !currentSpec &&
    process.env.AGENT_SECTION_SPLIT !== "0" &&
    String(prompt ?? "").length >= config.agent.sectionSplitMinChars
      ? splitNewBrief(prompt, 0)
      : null;

  if (plannedSections && plannedSections.length > 1) {
    const built = await buildBySections(plannedSections);
    if (!built) {
      const reasons = warnings.length > 0 ? warnings.join(" · ") : "không rõ nguyên nhân";
      throw new Error(`Không dựng được mục nào trong brief đã chia — ${reasons}`);
    }
    outcome = built;
  } else {
    try {
      outcome = await runTurn(prompt, currentSpec);
    } catch (error) {
      const sections =
        !currentSpec && (isOutputLimitError(error) || isTimeoutError(error))
          ? splitNewBrief(prompt, 0)
          : null;

      if (sections && sections.length > 1) {
        const built = await buildBySections(sections);
        if (!built) {
          const reasons =
            warnings.length > 0 ? warnings.join(" · ") : (error?.message ?? "không rõ nguyên nhân");
          const failure = new Error(`Không dựng được mục nào trong brief đã chia — ${reasons}`);
          failure.code = error?.code;
          failure.detail = error?.detail ?? error?.message ?? undefined;
          throw failure;
        }
        outcome = built;
      } else if (currentSpec) {
        const kept = analyzeSpec(currentSpec);
        if (!kept.ok) throw error;

        kept.spec.lod = level;
        warnings.push(
          `Chưa áp dụng được thay đổi: ${error?.message ?? error}. ` +
            "Giữ nguyên mô hình hiện tại — gửi lại, hoặc chọn model nhanh hơn.",
        );
        console.log(`[design] edit failed, keeping the current spec: ${error?.message ?? error}`);
        outcome = { analysis: kept, attempts: 0, gaps: null, unchanged: true };
      } else {
        throw error;
      }
    }
  }

  let analysis = outcome.analysis;
  if (analysis?.spec) analysis.spec.lod = level;

  let completeness = null;
  if (hasRequirements && analysis?.spec) {
    completeness = gapsFor(analysis);

    if (!completeness.ok) {
      const filled = fillMissingFromTemplate({
        prompt,
        spec: analysis.spec,
        gaps: completeness,
        checklist,
      });
      if (filled) {
        analysis = filled.analysis;
        analysis.spec.lod = level;
        completeness = filled.gaps;
        warnings.push(filled.note);
        console.log(`[design] ${filled.note}`);
      }
    }

    if (!completeness.ok) warnings.push(`Chưa đầy đủ: ${describeGaps(completeness)}`);
  }

  const promptChars =
    systemPrompt(level).length + String(prompt ?? "").length + JSON_OUTPUT_CONTRACT.length;

  const stats = {
    ...summarise(analysis.spec, analysis.model),
    lod: level,
    attempts: outcome.attempts,
    elapsedMs: Date.now() - startedAt,
    usage,
    model: model || null,
    modelCalls,
    calls: callStats,
    promptChars,
    ...(completeness
      ? {
          complete: completeness.ok,
          missing: completeness.missing.map((item) => item.label ?? item.message),
        }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(outcome.unchanged ? { unchanged: true } : {}),
  };

  const cacheable = analysis.ok && (!completeness || completeness.ok) && warnings.length === 0;
  if (resultKey && cacheable) writeCachedResult(resultKey, { analysis, stats });

  return { analysis, stats };
}
