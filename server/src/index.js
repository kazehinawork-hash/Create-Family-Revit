import fs from "node:fs";
import path from "node:path";
import express from "express";
import { analyzeSpec } from "@family/spec-core";
import { config, ROOT } from "./config.js";
import { design } from "./designer.js";
import { buildFamily } from "./bridge.js";
import { agentStatus, detectAgentBackends, getCmdcModels } from "./agents.js";
import { bridgeAlive, ensureBridge, findRevitExe } from "./revit.js";
import { createPortablePackage } from "./portable.js";
import { writeJsonAtomic } from "./files.js";
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
  modelSaveRequest,
  uploadRequest,
} from "./schemas.js";

const app = express();
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

app.use(express.json({ limit: "30mb" }));

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
  res.sendFile(target, { dotfiles: "deny" });
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

  const url = (baseUrl || "").toLowerCase();
  try {
    if (url.includes("googleapis.com")) {
      // Test Gemini API with a dummy model request
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.trim()}`;
      const testRes = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
      if (!testRes.ok) {
        return res.json({ ok: false, status: testRes.status, error: "API Key Google không hợp lệ hoặc không có quyền truy cập." });
      }
      return res.json({ ok: true, provider: "Google Gemini" });
    }

    if (url.includes("anthropic.com")) {
      // Test Anthropic Messages API
      const endpoint = "https://api.anthropic.com/v1/messages";
      const testRes = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey.trim(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: model || "claude-3-5-haiku-latest",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(6000),
      });

      if (testRes.status === 401 || testRes.status === 403) {
        return res.json({ ok: false, status: testRes.status, error: "API Key Anthropic không hợp lệ hoặc đã hết hạn." });
      }
      return res.json({ ok: true, provider: "Anthropic Claude" });
    }

    // Default: OpenAI compatible endpoint
    const endpoint = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const testUrl = `${endpoint}/models`;
    const testRes = await fetch(testUrl, {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      redirect: "error",
      signal: AbortSignal.timeout(6000),
    });

    if (testRes.status === 401 || testRes.status === 403) {
      return res.json({ ok: false, status: testRes.status, error: "API Key không hợp lệ hoặc sai endpoint." });
    }
    return res.json({ ok: true, provider: "OpenAI Compatible" });
  } catch (err) {
    return res.json({ ok: false, error: err.message || "Không thể kết nối tới máy chủ API" });
  }
});

app.get("/api/health", async (_req, res) => {
  const [models, backends] = await Promise.all([getCmdcModels(), detectAgentBackends()]);
  const status = agentStatus();
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
  res.json({
    ok: true,
    agent: { ...status, ready, detail },
    backends,
    models,
    bridge: config.bridge.url,
    revit: {
      connected: await bridgeAlive(),
      autoStart: config.revit.autoStart,
      exe: findRevitExe(),
    },
    outDir: config.dirs.out,
    queueDir: config.dirs.queue,
  });
});

app.post("/api/design", async (req, res) => {
  const limit = designLimiter(req.ip);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    res.status(429).json({ error: "Too many design runs. Wait a few seconds and try again." });
    return;
  }

  const parsed = designRequest.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed) });
    return;
  }

  const body = parsed.data;
  const prompt = body.prompt;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let closed = false;
  const controller = new AbortController();

  res.on("close", () => {
    closed = true;
    if (!res.writableEnded) controller.abort();
  });

  const emit = (event) => {
    if (closed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const keepAlive = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(": ping\n\n");
  }, 5000);

  try {
    const result = await design({
      prompt,
      currentSpec: body.spec ?? null,
      lod: body.lod,
      model: body.model,
      customApiConfig: body.customApiConfig,
      attachments: normalizeAttachments(body.attachments),
      signal: controller.signal,
      emit,
    });

    emit({
      type: "spec",
      spec: result.analysis.spec,
      issues: result.analysis.issues,
      errors: result.analysis.errors,
      stats: result.stats,
    });

    if (!result.analysis.ok) {
      emit({
        type: "stage",
        stage: "needs-work",
        message: `${result.analysis.errors.length} problem${result.analysis.errors.length === 1 ? "" : "s"} left in the model`,
        issues: result.analysis.errors,
      });
    }
  } catch (error) {
    console.error("design failed:", error);
    emit({ type: "error", message: error?.message || String(error) });
  } finally {
    clearInterval(keepAlive);
    if (!res.writableEnded) res.end();
  }
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
    res.json(result);
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
  const resolved = safeDownloadPath(filePath, DOWNLOAD_ROOTS);
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
    const files = fs.readdirSync(config.dirs.saved).filter((f) => f.endsWith(".json"));
    const models = files
      .map((file) => {
        try {
          const filePath = path.join(config.dirs.saved, file);
          const raw = fs.readFileSync(filePath, "utf8");
          const data = JSON.parse(raw);
          const stats = fs.statSync(filePath);
          return {
            id: file.replace(/\.json$/, ""),
            name: data.spec?.name || data.name || file,
            category: data.spec?.category || data.category || "Mechanical Equipment",
            updatedAt: stats.mtimeMs,
            partsCount: data.spec?.parts?.length || data.parts?.length || 0,
            paramsCount: data.spec?.parameters?.length || data.parameters?.length || 0,
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

    const { id, name, spec, entries } = parsed.data;
    const modelId = id
      ? path.basename(id).replace(/[^\w.\- ]+/g, "_")
      : `${Date.now()}-${(name || spec.name).toLowerCase().replace(/[^\w]+/g, "-").slice(0, 50)}`;

    const filePath = path.join(config.dirs.saved, `${modelId}.json`);
    // Overwriting an existing model keeps the previous version as a revision.
    if (id) archiveModel(modelId, filePath);

    const payload = {
      id: modelId,
      name: name || spec.name,
      spec,
      entries: Array.isArray(entries) ? entries : [],
      savedAt: Date.now(),
    };
    writeJsonAtomic(filePath, payload);
    res.json({ ok: true, id: modelId, name: payload.name });
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

app.listen(config.port, config.host, () => {
  const status = agentStatus();
  console.log(`Family Agent API on http://${config.host}:${config.port}`);
  console.log(`  agent     ${status.provider} · ${status.model}`);
  console.log(`  revit     ${config.bridge.url}`);
  console.log(`  output    ${config.dirs.out}`);
});
