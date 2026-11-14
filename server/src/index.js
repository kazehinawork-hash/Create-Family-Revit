import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { analyzeSpec } from "@family/spec-core";
import { config, ROOT } from "./config.js";
import { design } from "./designer.js";
import { buildFamily, buildMultiType, getBuildOutputRoots } from "./bridge.js";
import { auditBuild } from "./build-qa.js";
import { agentStatus, detectAgentBackends, getCmdcModels } from "./agents.js";
import { bridgeAlive, ensureBridge, findRevitExe } from "./revit.js";
import { createPortablePackage } from "./portable.js";
import { extractModelCatalog, extractModelIds, normalizeModelBaseUrl } from "./model-list.js";
import {
  createDesignJob,
  designJobSeenSince,
  finishDesignJob,
  getDesignJob,
  touchDesignJob,
  updateJob,
} from "./jobs.js";
import { checkModel } from "./model-check.js";
import { writeJsonAtomic } from "./files.js";
import {
  deleteGroup,
  ensureGroup,
  isModelFile,
  librarySnapshot,
  normalizeGroupName,
  readModelFile,
  renameGroup,
  setModelGroup,
} from "./library.js";
import { retryWholeRequest, classifyDesignError } from "./retry.js";
import {
  checkOutboundUrl,
  createRateLimiter,
  INLINE_EXTENSIONS,
  isAllowedHost,
  isAllowedOrigin,
  isSafeUpload,
  safeDownloadPath,
} from "./security.js";
import {
  buildRequest,
  designRequest,
  firstIssue,
  groupCreateRequest,
  groupRenameRequest,
  modelGroupRequest,
  modelSaveRequest,
  uploadRequest,
} from "./schemas.js";
import { v1Router } from "./routes/api-v1.js";

/** The express app, exported so tests can mount it without opening the real port. */
export const app = express();
app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:",
  );
  next();
});

// DNS-rebinding pages can reach a loopback server; only answer localhost names.
app.use((req, res, next) => {
  if (isAllowedHost(req.headers.host, config.allowedHosts)) {
    next();
    return;
  }
  res.status(403).json({ error: "Host not allowed" });
});

// State-changing calls from a browser must come from the studio origin.
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  if (isAllowedOrigin(req.headers.origin, req.headers.host, config.allowedHosts)) {
    next();
    return;
  }
  res.status(403).json({ error: "Origin not allowed" });
});

const designLimiter = createRateLimiter({ windowMs: 60_000, max: 6 });
const buildLimiter = createRateLimiter({ windowMs: 60_000, max: 12 });

/** Vietnamese wording for a rejected design request (zod issues are English). */
function designValidationMessage(parsed) {
  const issue = parsed?.error?.issues?.[0];
  const path = String(issue?.path?.join(".") ?? "");
  const message = String(issue?.message ?? "");

  if (path === "prompt") {
    return /too long|50000|50,000/i.test(message)
      ? "Nội dung mô tả quá dài (tối đa 50.000 ký tự)."
      : "Hãy mô tả thiết bị bạn cần dựng.";
  }
  return path ? `Yêu cầu không hợp lệ ở "${path}".` : "Yêu cầu không hợp lệ.";
}

app.use(express.json({ limit: "30mb" }));

// Standardized V1 API for external integrations (DG App / MCP Adapter)
app.use("/api/v1", v1Router);

function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const uploadsRoot = path.resolve(config.dirs.uploads);

  return raw
    .filter((entry) => entry && typeof entry.path === "string")
    .map((entry) => ({
      path: path.resolve(entry.path),
      name: path.basename(entry.path).replace(/^\d+-/, ""),
    }))
    .filter(
      (entry) =>
        entry.path.startsWith(uploadsRoot + path.sep) && fs.existsSync(entry.path),
    )
    .slice(0, 4);
}

app.post("/api/upload", (req, res) => {
  try {
    const parsed = uploadRequest.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed) });
      return;
    }

    const { name, data } = parsed.data;
    const buffer = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
    if (!buffer.length) {
      res.status(400).json({ error: "The file is empty" });
      return;
    }
    if (buffer.length > 20 * 1024 * 1024) {
      res.status(413).json({ error: "Files up to 20 MB are supported" });
      return;
    }
    if (!isSafeUpload(name)) {
      res.status(415).json({ error: "Unsupported file type" });
      return;
    }

    fs.mkdirSync(config.dirs.uploads, { recursive: true });
    const safe = path.basename(name).replace(/[^\w.\- ]+/g, "_").slice(-80) || "document";
    const storedName = `${Date.now()}-${safe}`;
    const stored = path.join(config.dirs.uploads, storedName);
    fs.writeFileSync(stored, buffer);

    res.json({
      name: safe,
      size: buffer.length,
      path: stored,
      url: `/api/uploads/${encodeURIComponent(storedName)}`,
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get("/api/uploads/:name", (req, res) => {
  const target = safeDownloadPath(
    path.join(config.dirs.uploads, path.basename(String(req.params.name || ""))),
    [config.dirs.uploads],
  );
  if (!target) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const extension = path.extname(target).toLowerCase();
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Images and PDFs may render inline; everything else is a download so the browser
  // never executes an uploaded file inside the studio origin.
  if (!INLINE_EXTENSIONS.has(extension)) {
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(path.basename(target))}"`);
  }
  res.type(extension);
  const stream = fs.createReadStream(target);
  stream.on("error", () => {
    if (!res.headersSent) res.status(500).json({ error: "Could not read upload" });
    else res.end();
  });
  stream.pipe(res);
});

// Cheap liveness probe: the studio polls this while waiting, /api/health is too heavy
// (it enumerates the CLI models and pings the Revit bridge).
app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, agent: agentStatus(), time: Date.now() });
});


app.post("/api/verify-api", async (req, res) => {
  const { baseUrl, apiKey, model } = req.body || {};
  if (!apiKey || !apiKey.trim()) {
    return res.json({ ok: false, error: "Chưa nhập API Key" });
  }

  const guard = checkOutboundUrl(baseUrl || "https://api.openai.com/v1");
  if (!guard.ok) {
    return res.json({ ok: false, error: guard.error });
  }

  const modelBase = normalizeModelBaseUrl(baseUrl) || "https://api.openai.com/v1";
  const url = modelBase.toLowerCase();
  const trimmedKey = apiKey.trim();
  try {
    if (url.includes("googleapis.com")) {
      // The Models endpoint both validates the key and returns the live catalog.
      const root = modelBase.replace(/\/+$/, "");
      const endpoint = `${root}/models?key=${encodeURIComponent(trimmedKey)}`;
      const testRes = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
      if (!testRes.ok) {
        return res.json({
          ok: false,
          status: testRes.status,
          error: "API Key Google không hợp lệ hoặc không có quyền truy cập.",
        });
      }
      const payload = await testRes.json().catch(() => null);
      return res.json({
        ok: true,
        provider: "Google Gemini",
        models: extractModelIds("gemini", payload),
      });
    }

    if (url.includes("anthropic.com")) {
      const root = modelBase;
      const endpoint = root.endsWith("/models") ? root : `${root}/models`;
      const testRes = await fetch(endpoint, {
        headers: {
          "x-api-key": trimmedKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(8000),
      });

      if (testRes.status === 401 || testRes.status === 403) {
        return res.json({
          ok: false,
          status: testRes.status,
          error: "API Key Anthropic không hợp lệ hoặc đã hết hạn.",
        });
      }
      if (!testRes.ok) {
        // Older Anthropic deployments may not expose /models; still verify the key.
        const fallback = await fetch(`${root}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": trimmedKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: model || "claude-3-5-haiku-latest",
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: AbortSignal.timeout(6000),
        });
        if (fallback.status === 401 || fallback.status === 403) {
          return res.json({
            ok: false,
            status: fallback.status,
            error: "API Key Anthropic không hợp lệ hoặc đã hết hạn.",
          });
        }
        return res.json({ ok: true, provider: "Anthropic Claude", models: [] });
      }
      const payload = await testRes.json().catch(() => null);
      return res.json({
        ok: true,
        provider: "Anthropic Claude",
        models: extractModelIds("anthropic", payload),
      });
    }

    // Default: OpenAI compatible endpoint (OpenAI, DeepSeek, OpenRouter, Ollama...).
    const endpoint = modelBase;
    const providerLabel = url.includes("commandcode.ai") ? "Command Code" : "OpenAI Compatible";
    const testUrl = `${endpoint}/models`;
    const testRes = await fetch(testUrl, {
      headers: { Authorization: `Bearer ${trimmedKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });

    if (testRes.status === 401 || testRes.status === 403) {
      return res.json({ ok: false, status: testRes.status, error: "API Key không hợp lệ hoặc sai endpoint." });
    }
    if (!testRes.ok) {
      // Some proxies expose chat/completions but no model catalog. Keep the key
      // usable and let the user type a model rather than pretending it is invalid.
      if (testRes.status === 404 || testRes.status === 405) {
        return res.json({
          ok: true,
          provider: providerLabel,
          models: [],
          warning: "Endpoint không cung cấp /models; hãy nhập model thủ công.",
        });
      }
      return res.json({
        ok: false,
        status: testRes.status,
        error: `Endpoint trả về lỗi ${testRes.status}. Kiểm tra base URL.`,
      });
    }
    const payload = await testRes.json().catch(() => null);
    const catalog = extractModelCatalog("openai", payload);

    if (url.includes("commandcode.ai")) {
      // The Command Code catalogue is public, so /models proves nothing about the key.
      // Prove it with one real chat call over the same wire the app uses. A claude-*
      // model only speaks /messages and is filtered out of the catalog above.
      const preferred =
        model && !/\s/.test(String(model).trim()) && catalog.models.includes(String(model).trim())
          ? String(model).trim()
          : catalog.models[0] || "deepseek/deepseek-v4-flash";

      try {
        const probe = await fetch(`${endpoint}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${trimmedKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: preferred,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });

        if (probe.status === 401 || probe.status === 403) {
          return res.json({
            ok: false,
            status: probe.status,
            error: "API Key Command Code không hợp lệ",
          });
        }
        if (!probe.ok) {
          // Overloaded or rate-limited: the key may still be fine.
          return res.json({
            ok: true,
            provider: "Command Code",
            models: catalog.models,
            modelNames: catalog.names,
            warning: `Chưa kiểm tra được key (HTTP ${probe.status}); danh sách model vẫn dùng được.`,
          });
        }
      } catch (probeError) {
        return res.json({
          ok: true,
          provider: "Command Code",
          models: catalog.models,
          modelNames: catalog.names,
          warning: `Chưa kiểm tra được key: ${probeError.message || probeError}`,
        });
      }

      return res.json({
        ok: true,
        provider: "Command Code",
        models: catalog.models,
        modelNames: catalog.names,
      });
    }

    return res.json({
      ok: true,
      provider: providerLabel,
      models: catalog.models,
      modelNames: catalog.names,
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message || "Không thể kết nối tới máy chủ API" });
  }
});

// Lightweight availability probe for the model chosen from the scanned catalog.
app.post("/api/check-model", async (req, res) => {
  const { baseUrl, apiKey, model } = req.body || {};
  if (!apiKey || !apiKey.trim()) {
    return res.json({ ok: false, error: "Chưa nhập API Key" });
  }
  if (!model || !String(model).trim()) {
    return res.json({ ok: false, error: "Chưa chọn model" });
  }

  const guard = checkOutboundUrl(baseUrl || "https://api.openai.com/v1");
  if (!guard.ok) {
    return res.json({ ok: false, error: guard.error });
  }

  return res.json(
    await checkModel({
      baseUrl,
      apiKey: apiKey.trim(),
      model: String(model).trim(),
    }),
  );
});

/**
 * One source failing (slow CLI, bridge down, missing binary) must never take the
 * whole health endpoint down: every source is isolated and falls back to a safe value.
 */
export async function buildHealthPayload() {
  const [modelsResult, backendsResult, bridgeResult] = await Promise.allSettled([
    getCmdcModels(),
    detectAgentBackends(),
    bridgeAlive(),
  ]);

  const models = modelsResult.status === "fulfilled" && Array.isArray(modelsResult.value)
    ? modelsResult.value
    : [];
  const backends =
    backendsResult.status === "fulfilled" && backendsResult.value
      ? backendsResult.value
      : { commandcode: false, agy: false, codex: false, claude: false, openai: Boolean(config.llm.apiKey) };
  const connected = bridgeResult.status === "fulfilled" ? Boolean(bridgeResult.value) : false;

  let status;
  try {
    status = agentStatus();
  } catch (error) {
    status = {
      provider: config.agent.provider,
      model: config.agent.model || "",
      ready: false,
      detail: `agent status unavailable: ${error?.message ?? error}`,
    };
  }

  const anyCli = backends.commandcode || backends.agy || backends.codex || backends.claude;
  const ready = status.provider === "openai" ? backends.openai : anyCli;
  const detail =
    status.provider === "openai"
      ? status.detail
      : ready
        ? backends.commandcode
          ? status.detail
          : `"${config.agent.command}" không có trên máy — chọn model từ CLI đang cài hoặc Direct API`
        : `Không tìm thấy CLI nào trên máy — cài CLI hoặc dùng Direct API`;

  return {
    ok: true,
    agent: { ...status, ready, detail },
    backends,
    models,
    bridge: config.bridge.url,
    revit: {
      connected,
      autoStart: config.revit.autoStart,
      exe: findRevitExe(),
    },
    outDir: config.dirs.out,
    queueDir: config.dirs.queue,
  };
}

app.get("/api/health", async (_req, res) => {
  try {
    res.json(await buildHealthPayload());
  } catch (error) {
    console.error("health failed:", error);
    // Still 200: the studio must be able to render a degraded state instead of
    // treating a partial failure as "the API is gone".
    res.status(200).json({
      ok: true,
      degraded: true,
      error: error?.message || String(error),
      agent: {
        provider: config.agent.provider,
        model: config.agent.model || "",
        ready: false,
        detail: "Agent tạm thời không phản hồi",
      },
      backends: {
        commandcode: false,
        agy: false,
        codex: false,
        claude: false,
        openai: Boolean(config.llm.apiKey),
      },
      models: [],
      bridge: config.bridge.url,
      revit: { connected: false, autoStart: config.revit.autoStart, exe: null },
      outDir: config.dirs.out,
      queueDir: config.dirs.queue,
    });
  }
});

/** "unchanged" (old spec kept), "has-errors", "incomplete", or "ok". */
export function designOutcome(analysis, stats) {
  if (stats?.unchanged) return "unchanged";
  if (!analysis?.ok) return "has-errors";
  if (stats?.complete === false) return "incomplete";
  return "ok";
}

app.post("/api/design", async (req, res) => {  const limit = designLimiter(req.ip);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    res.status(429).json({
      error: `Bạn gửi hơi nhanh — đợi ${limit.retryAfter} giây rồi thử lại.`,
      kind: "overloaded",
    });
    return;
  }

  const parsed = designRequest.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: designValidationMessage(parsed), kind: "invalid-request" });
    return;
  }

  const body = parsed.data;
  const prompt = body.prompt;

  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
  } catch (error) {
    // The client can disappear between the body parse and writeHead.
    console.error("design stream open failed:", error);
    try { res.destroy(); } catch { /* already gone */ }
    return;
  }

  let closed = false;
  const controller = new AbortController();
  let jobId = null;
  let reconnectTimer = null;

  // The browser reloads, the Vite proxy restarts, the laptop sleeps: the socket can
  // drop mid-run. Keep the design alive for a grace period and only abort when the
  // studio has not polled the job — it polls every few seconds while it is open.
  const onStreamClosed = (reason) => {
    if (closed && reconnectTimer) return;
    closed = true;
    const closedAt = Date.now();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (jobId && designJobSeenSince(jobId, closedAt)) {
        console.log("[design] studio reconnected — the run keeps going");
        return;
      }
      controller.abort(reason);
    }, config.agent.reconnectGraceMs);
    reconnectTimer.unref?.();
  };

  res.on("close", () => {
    if (!res.writableEnded) onStreamClosed("client closed");
  });

  // A browser reload or a Vite proxy restart resets the socket. Without these
  // listeners Node emits an unhandled 'error' and the whole API process exits.
  const onStreamError = (error) => {
    if (error?.code !== "ECONNRESET" && error?.code !== "EPIPE") {
      console.error("design stream error:", error);
    }
    onStreamClosed("stream error");
  };
  res.on("error", onStreamError);
  req.on("error", onStreamError);

  const send = (chunk) => {
    if (closed || res.writableEnded || res.destroyed) return;
    try {
      res.write(chunk);
    } catch (error) {
      onStreamError(error);
    }
  };

  const emitRaw = (event) => {
    send(`data: ${JSON.stringify(event)}\n\n`);
  };

  // A design run is a job: the browser can reconnect and pick the result up even
  // when the socket dies (Vite proxy restart, laptop sleep, reload).
  const job = createDesignJob({ prompt, model: body.model, lod: body.lod });
  jobId = job.job_id;
  emitRaw({ type: "job", jobId: job.job_id });

  const emit = (event) => {
    if (event?.type === "spec" && event.spec) {
      const partial = Boolean(event.stats?.step?.partial);
      updateJob(job.job_id, {
        status: partial ? "running" : "done",
        spec: event.spec,
        issues: event.issues ?? [],
        errors: event.errors ?? [],
        stats: event.stats ?? null,
      });
    }

    emitRaw(event);
  };

  const keepAlive = setInterval(() => {
    send(": ping\n\n");
  }, config.agent.heartbeatMs);

  try {
    // One model call retries quickly; a provider that is down for minutes needs a
    // longer wait. The job stays "running" and the studio shows the countdown.
    const result = await retryWholeRequest(
      () =>
        design({
          prompt,
          currentSpec: body.spec ?? null,
          lod: body.lod,
          model: body.model,
          lockModel: body.lockModel,
          customApiConfig: body.customApiConfig,
          commandCodeApiKey: body.commandCodeApiKey,
          attachments: normalizeAttachments(body.attachments),
          // Unknown product types get one cheap model call to learn a reusable pack.
          learnRules: true,
          signal: controller.signal,
          emit,
        }),
      {
        delays: config.agent.requestRetryDelays,
        signal: controller.signal,
        onWait: ({ attempt, total, delayMs, error }) => {
          console.warn(
            `[design] provider overloaded (${error?.message ?? error}); retry ${attempt}/${total} in ${delayMs} ms`,
          );
          emit({
            type: "stage",
            stage: "retrying",
            message:
              `Nhà cung cấp model đang quá tải — tự thử lại sau ${Math.round(delayMs / 1000)}s` +
              ` (lần ${attempt}/${total})`,
          });
        },
      },
    );

    // The studio words the answer from this: a kept old spec must never read as an
    // update, and a spec with errors must not read as a clean build.
    const outcome = designOutcome(result.analysis, result.stats);

    emit({
      type: "spec",
      spec: result.analysis.spec,
      issues: result.analysis.issues,
      errors: result.analysis.errors,
      stats: result.stats,
      outcome,
    });

    finishDesignJob(job.job_id, {
      status: "done",
      spec: result.analysis.spec,
      issues: result.analysis.issues ?? [],
      errors: result.analysis.errors ?? [],
      warnings: result.warnings ?? result.stats?.warnings ?? [],
      stats: result.stats,
    });

    if (!result.analysis.ok) {
      emit({
        type: "stage",
        stage: "needs-work",
        message: `Còn ${result.analysis.errors.length} lỗi trong mô hình`,
        issues: result.analysis.errors,
      });
    }
  } catch (error) {
    console.error("design failed:", error);
    const message = error?.message || String(error);
    const kind = classifyDesignError(error);
    const retryable = !(kind === "auth" || kind === "invalid-request");
    finishDesignJob(job.job_id, { status: "error", error: message });
    emit({
      type: "error",
      message,
      details: error?.detail ?? undefined,
      kind,
      retryable,
    });
  } finally {
    clearInterval(keepAlive);
    clearTimeout(reconnectTimer);
    try {
      if (!res.writableEnded) res.end();
    } catch {
      // Socket already gone.
    }
  }
});

app.get("/api/design/jobs/:id", (req, res) => {
  const job = getDesignJob(String(req.params.id || ""));
  if (!job) {
    res.status(404).json({
      ok: false,
      error: "Không tìm thấy job thiết kế (server có thể đã restart trước khi xong).",
    });
    return;
  }

  // Polling the job is also the "I am still here" signal for a run whose SSE
  // socket dropped: the stream keeps going instead of being cancelled.
  touchDesignJob(job.job_id);
  res.json({ ok: true, job });
});

app.post("/api/build", async (req, res) => {
  const limit = buildLimiter(req.ip);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    res.status(429).json({ ok: false, error: "Too many build requests. Wait a few seconds." });
    return;
  }

  const parsed = buildRequest.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: firstIssue(parsed) });
    return;
  }

  const analysis = analyzeSpec(parsed.data.spec);

  if (!analysis.ok) {
    res.status(400).json({
      ok: false,
      error: "The spec still has errors, fix them before building",
      issues: analysis.errors,
    });
    return;
  }

  try {
    const bridge = await ensureBridge();
    if (!bridge.ok) {
      res.status(503).json({ ok: false, mode: "unavailable", error: bridge.error });
      return;
    }

    const result = await buildFamily(analysis.spec);
    if (result.ok) {
      const qa = auditBuild(analysis, result);
      result.qa = qa;
      if (qa.warnings.length > 0) {
        result.warnings = [...(result.warnings ?? []), ...qa.warnings];
      }
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post("/api/export-multi-type", async (req, res) => {
  const analysis = analyzeSpec(req.body?.spec);
  if (!analysis.ok) {
    res.status(400).json({ ok: false, error: "Spec contains errors", issues: analysis.errors });
    return;
  }

  // The validator may drop unknown keys, so read the type list from the raw body too.
  const types = req.body?.spec?.types ?? analysis.spec.types ?? [];
  if (types.length === 0) {
    res.status(400).json({ ok: false, error: "No types to export" });
    return;
  }

  try {
    const bridge = await ensureBridge();
    if (!bridge.ok) {
      res.status(503).json({ ok: false, error: bridge.error });
      return;
    }

    const result = await buildMultiType({ ...analysis.spec, types });
    if (!result.ok) {
      res.status(502).json({ ok: false, error: result.error, warnings: result.warnings });
      return;
    }

    res.json({
      ok: true,
      path: result.path,
      types: result.types ?? types.length,
      warnings: result.warnings ?? [],
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post("/api/export-portable", async (req, res) => {
  const analysis = analyzeSpec(req.body?.spec);
  if (!analysis.ok) {
    res.status(400).json({ ok: false, error: "Spec contains errors", issues: analysis.errors });
    return;
  }

  try {
    const pkg = await createPortablePackage(analysis.spec);
    res.download(pkg.zipPath, pkg.fileName, () => {
      pkg.cleanup();
    });
  } catch (err) {
    console.error("Portable package creation error:", err);
    res.status(500).json({ ok: false, error: err.message || "Failed to generate portable package" });
  }
});

// Downloads are limited to the folders the studio writes: a query string must never
// be able to read an arbitrary file from the machine.
const DOWNLOAD_ROOTS = [
  config.dirs.out,
  config.dirs.saved,
  config.dirs.uploads,
  path.join(ROOT, "spec"),
];

app.get("/api/download-rfa", (req, res) => {
  const filePath = req.query?.path;
  if (!filePath || typeof filePath !== "string") {
    res.status(400).send("Path is required");
    return;
  }
  const resolved = safeDownloadPath(filePath, [
    ...DOWNLOAD_ROOTS,
    ...getBuildOutputRoots(),
  ]);
  if (!resolved) {
    res.status(403).send("File is outside the allowed folders");
    return;
  }
  res.download(resolved);
});

app.get("/api/download-spec", (req, res) => {
  const specPath = req.query?.file;
  if (!specPath || typeof specPath !== "string") {
    res.status(400).send("File path is required");
    return;
  }
  const resolved = safeDownloadPath(specPath, DOWNLOAD_ROOTS);
  if (!resolved) {
    res.status(403).send("Spec is outside the allowed folders");
    return;
  }
  res.download(resolved);
});

// -------------------------------------------------------------
// Model Library & Persistence (Lưu, Quản lý, Tiếp tục sửa, Xoá)
// -------------------------------------------------------------
function ensureSavedDir() {
  if (!fs.existsSync(config.dirs.saved)) {
    fs.mkdirSync(config.dirs.saved, { recursive: true });
  }
}

function safeModelId(id) {
  return path.basename(String(id || "")).replace(/[^\w.\- ]+/g, "_");
}

function historyDir(modelId) {
  return path.join(config.dirs.saved, ".history", safeModelId(modelId));
}

/** Thumbnails live next to the model file, never inside the JSON. */
function thumbPath(modelId) {
  return path.join(config.dirs.saved, `${safeModelId(modelId)}.thumb.jpg`);
}

function saveThumbnail(modelId, dataUrl) {
  const match = /^data:image\/(?:jpeg|jpg|webp|png);base64,(.+)$/i.exec(String(dataUrl ?? ""));
  if (!match) return false;
  try {
    fs.writeFileSync(thumbPath(modelId), Buffer.from(match[1], "base64"));
    return true;
  } catch (error) {
    console.warn(`[library] could not write thumbnail for ${modelId}: ${error?.message}`);
    return false;
  }
}

/** Every Save keeps the previous file as a revision, so an edit can always be rolled back. */
function archiveModel(modelId, filePath) {
  if (!modelId || !fs.existsSync(filePath)) return;
  const dir = historyDir(modelId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(filePath, path.join(dir, `${stamp}.json`));
}

app.get("/api/models", (_req, res) => {
  try {
    ensureSavedDir();
    // `_library.json` (and any other underscore file) is metadata, not a model.
    const files = fs.readdirSync(config.dirs.saved).filter(isModelFile);
    const models = files
      .map((file) => {
        try {
          const filePath = path.join(config.dirs.saved, file);
          const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
          const stats = fs.statSync(filePath);
          const id = file.replace(/\.json$/, "");
          return {
            id,
            name: data.spec?.name || data.name || file,
            typeName: data.spec?.typeName || data.typeName || "",
            category: data.spec?.category || data.category || "Mechanical Equipment",
            lod: Number(data.spec?.lod) || null,
            group: typeof data.group === "string" ? data.group : "",
            updatedAt: stats.mtimeMs,
            partsCount: data.spec?.parts?.length || data.parts?.length || 0,
            paramsCount: data.spec?.parameters?.length || data.parameters?.length || 0,
            thumbUrl: fs.existsSync(thumbPath(id)) ? `/api/models/${encodeURIComponent(id)}/thumb` : null,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    res.json({ models });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get("/api/library/groups", (_req, res) => {
  try {
    ensureSavedDir();
    res.json(librarySnapshot(config.dirs.saved));
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.post("/api/library/groups", (req, res) => {
  try {
    ensureSavedDir();
    const parsed = groupCreateRequest.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed) });
      return;
    }

    const normalized = normalizeGroupName(parsed.data.name);
    if (normalized.error || !normalized.name) {
      res.status(400).json({ error: normalized.error || "Tên nhóm không được để trống." });
      return;
    }

    const snapshot = librarySnapshot(config.dirs.saved);
    if (snapshot.groups.some((group) => group.name.toLowerCase() === normalized.name.toLowerCase())) {
      res.status(400).json({ error: "Nhóm đã tồn tại." });
      return;
    }

    const created = ensureGroup(config.dirs.saved, normalized.name);
    if (created.error) {
      res.status(400).json({ error: created.error });
      return;
    }
    res.json({ ok: true, name: created.name, ...librarySnapshot(config.dirs.saved) });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.patch("/api/library/groups/:name", (req, res) => {
  try {
    ensureSavedDir();
    const parsed = groupRenameRequest.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed) });
      return;
    }

    const result = renameGroup(config.dirs.saved, req.params.name, parsed.data.name);
    if (result.error) {
      res.status(result.status ?? 400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, ...result, ...librarySnapshot(config.dirs.saved) });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.delete("/api/library/groups/:name", (req, res) => {
  try {
    ensureSavedDir();
    const result = deleteGroup(config.dirs.saved, req.params.name);
    if (result.error) {
      res.status(result.status ?? 400).json({ error: result.error });
      return;
    }
    // The models stay in the library; only their group is cleared.
    res.json({ ok: true, ...result, ...librarySnapshot(config.dirs.saved) });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.patch("/api/models/:id/group", (req, res) => {
  try {
    ensureSavedDir();
    const parsed = modelGroupRequest.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed) });
      return;
    }

    const result = setModelGroup(config.dirs.saved, safeModelId(req.params.id), parsed.data.group);
    if (result.error) {
      res.status(result.status ?? 400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, id: result.id, group: result.group });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get("/api/models/:id", (req, res) => {
  try {
    ensureSavedDir();
    const safeId = safeModelId(req.params.id);
    const filePath = path.join(config.dirs.saved, `${safeId}.json`);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Model not found" });
      return;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    res.json(JSON.parse(raw));
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get("/api/models/:id/thumb", (req, res) => {
  try {
    const file = thumbPath(req.params.id);
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "Thumbnail not found" });
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.type("image/jpeg");
    res.sendFile(file);
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get("/api/models/:id/history", (req, res) => {
  try {
    const id = safeModelId(req.params.id);
    const dir = historyDir(id);
    if (!fs.existsSync(dir)) {
      res.json({ revisions: [] });
      return;
    }

    const revisions = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try {
          const filePath = path.join(dir, file);
          const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
          return {
            stamp: file.replace(/\.json$/, ""),
            savedAt: data.savedAt || fs.statSync(filePath).mtimeMs,
            name: data.spec?.name || data.name || id,
            parts: data.spec?.parts?.length || 0,
            parameters: data.spec?.parameters?.length || 0,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.savedAt - a.savedAt);

    res.json({ revisions });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get("/api/models/:id/history/:stamp", (req, res) => {
  try {
    const id = safeModelId(req.params.id);
    const stamp = path.basename(String(req.params.stamp || "")).replace(/[^\w.-]+/g, "");
    const filePath = path.join(historyDir(id), `${stamp}.json`);
    if (!stamp || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.post("/api/models", (req, res) => {
  try {
    ensureSavedDir();

    const parsed = modelSaveRequest.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed) });
      return;
    }

    const { id, name, spec, entries, group, thumbnail } = parsed.data;
    const modelId = id
      ? path.basename(id).replace(/[^\w.\- ]+/g, "_")
      : `${Date.now()}-${(name || spec.name).toLowerCase().replace(/[^\w]+/g, "-").slice(0, 50)}`;

    const filePath = path.join(config.dirs.saved, `${modelId}.json`);
    let previousGroup = "";
    // Overwriting an existing model keeps the previous version as a revision.
    if (id && fs.existsSync(filePath)) {
      archiveModel(modelId, filePath);
      // The group lives on the model file, not in the spec: a plain Save must never
      // drop it. Moving between groups goes through PATCH /api/models/:id/group.
      const existing = readModelFile(filePath);
      previousGroup = typeof existing?.group === "string" ? existing.group : "";
    }

    const payload = {
      id: modelId,
      name: name || spec.name,
      // New models may start in the group selected in the library; overwrites keep theirs.
      group: previousGroup || normalizeGroupName(group ?? "").name || "",
      spec,
      entries: Array.isArray(entries) ? entries : [],
      savedAt: Date.now(),
    };
    writeJsonAtomic(filePath, payload);
    if (payload.group) ensureGroup(config.dirs.saved, payload.group);
    if (thumbnail) saveThumbnail(modelId, thumbnail);
    res.json({ ok: true, id: modelId, name: payload.name, group: payload.group });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

/** Characters Revit refuses in a family name, which also break file paths. */
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/;
const MAX_MODEL_NAME = 120;

function normalizeModelName(value) {
  if (typeof value !== "string") return { error: "Tên mô hình phải là chuỗi." };
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) return { error: "Tên mô hình không được để trống." };
  if (name.length > MAX_MODEL_NAME) {
    return { error: `Tên mô hình tối đa ${MAX_MODEL_NAME} ký tự.` };
  }
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    return { error: 'Tên mô hình không được chứa các ký tự \\ / : * ? " < > |.' };
  }
  return { name };
}

app.patch("/api/models/:id", (req, res) => {
  try {
    ensureSavedDir();
    const safeId = safeModelId(req.params.id);
    const filePath = path.join(config.dirs.saved, `${safeId}.json`);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Model not found" });
      return;
    }

    const parsed = normalizeModelName(req.body?.name);
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const spec = data.spec && typeof data.spec === "object" ? data.spec : {};
    const previous = String(spec.name ?? data.name ?? "").trim();

    // A rename is a save: keep the previous file as a revision.
    archiveModel(safeId, filePath);

    spec.name = parsed.name;
    // Keep typeName in step only when it mirrored the family name.
    if (typeof spec.typeName === "string" && spec.typeName.trim() === previous) {
      spec.typeName = parsed.name;
    }
    data.spec = spec;
    data.name = parsed.name;
    data.savedAt = Date.now();

    writeJsonAtomic(filePath, data);
    res.json({ ok: true, id: safeId, name: parsed.name, savedAt: data.savedAt });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.delete("/api/models/:id", (req, res) => {
  try {
    ensureSavedDir();
    const safeId = path.basename(req.params.id).replace(/[^\w.\- ]+/g, "_");
    const filePath = path.join(config.dirs.saved, `${safeId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    // The preview belongs to the model: remove it with the model.
    try {
      if (fs.existsSync(thumbPath(safeId))) fs.unlinkSync(thumbPath(safeId));
    } catch {
      /* a locked thumbnail must not fail the delete */
    }
    res.json({ ok: true, id: safeId });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.use(express.static(config.dirs.webDist));

app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
  const indexFile = path.join(config.dirs.webDist, "index.html");
  if (fs.existsSync(indexFile)) res.sendFile(indexFile);
  else res.status(404).send("The studio has not been built yet. Run: npm run build");
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((error, req, res, next) => {
  void next;
  console.error("request failed:", error);
  if (res.headersSent) {
    try { res.destroy(); } catch { /* already closed */ }
    return;
  }
  res.status(500).json({ error: error?.message || String(error) });
});

const crashLogPath = path.join(os.tmpdir(), "family-agent-api.log");

function logCrash(label, error) {
  try {
    fs.appendFileSync(
      crashLogPath,
      `${new Date().toISOString()} ${label}\n${error?.stack || error}\n\n`,
    );
  } catch {
    // Never let logging failure take the API down.
  }
}

process.on("uncaughtException", (error) => {
  console.error("uncaught exception:", error);
  logCrash("uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
  logCrash("unhandledRejection", reason);
});

let listenAttempts = 0;

/**
 * Node cuts a request after five minutes by default. A design run legitimately
 * streams for up to AGENT_TOTAL_TIMEOUT, so that default silently killed every
 * long brief with a 408 and the studio reported "mất kết nối".
 */
export function applyServerTimeouts(server) {
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 60000;
  // Must stay above common proxy idle timeouts (Vite closes at 60 s).
  server.keepAliveTimeout = 65000;
  return server;
}

function startListening() {
  const server = app.listen(config.port, config.host, () => {
    listenAttempts = 0;
    const status = agentStatus();
    console.log(`Family Agent API on http://${config.host}:${config.port}`);
    console.log(`  agent     ${status.provider} · ${status.model}`);
    console.log(`  revit     ${config.bridge.url}`);
    console.log(`  output    ${config.dirs.out}`);

    // Warm the caches in the background so the first studio health call does not
    // pay for spawning the CLI model listings.
    void getCmdcModels().catch(() => {});
    void detectAgentBackends().catch(() => {});
  });

  applyServerTimeouts(server);

  server.on("clientError", (error, socket) => {
    if (error?.code === "ECONNRESET" || !socket.writable) {
      try { socket.destroy(); } catch { /* already gone */ }
      return;
    }
    try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch { /* already gone */ }
  });

  server.on("error", (error) => {
    console.error("HTTP server error:", error);
    logCrash("server error", error);

    // node --watch can start the new process before the old listener releases
    // the port. Retry instead of staying alive with no listener.
    if (error?.code === "EADDRINUSE") {
      if (listenAttempts < 30) {
        listenAttempts += 1;
        setTimeout(startListening, 1000);
        return;
      }

      console.error(
        `Cổng ${config.port} đang bị tiến trình khác giữ (EADDRINUSE sau ${listenAttempts} lần thử). ` +
          "Dừng server để dev.mjs dừng cả cụm — kiểm tra tiến trình đang chiếm cổng rồi chạy lại.",
      );
      process.exit(1);
    }
  });
}

// Tests import this module for buildHealthPayload(); they must not open a listener.
if (process.env.FAMILY_AGENT_NO_LISTEN !== "1") {
  startListening();
}