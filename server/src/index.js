import fs from "node:fs";
import path from "node:path";
import express from "express";
import { analyzeSpec } from "@family/spec-core";
import { config } from "./config.js";
import { design } from "./designer.js";
import { buildFamily } from "./bridge.js";
import { agentStatus, getCmdcModels } from "./agents.js";
import { bridgeAlive, ensureBridge, findRevitExe } from "./revit.js";

const app = express();
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
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const data = typeof req.body?.data === "string" ? req.body.data : "";
    if (!name || !data) {
      res.status(400).json({ error: "name and data (base64) are required" });
      return;
    }

    const buffer = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
    if (!buffer.length) {
      res.status(400).json({ error: "The file is empty" });
      return;
    }
    if (buffer.length > 20 * 1024 * 1024) {
      res.status(413).json({ error: "Files up to 20 MB are supported" });
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
  const uploadsRoot = path.resolve(config.dirs.uploads);
  const name = path.basename(String(req.params.name || ""));
  const target = path.join(uploadsRoot, name);
  if (!name || !target.startsWith(uploadsRoot + path.sep) || !fs.existsSync(target)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.sendFile(target, { dotfiles: "allow" });
});

// Cheap liveness probe: the studio polls this while waiting, /api/health is too heavy
// (it enumerates the CLI models and pings the Revit bridge).
app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, agent: agentStatus(), time: Date.now() });
});

app.get("/api/health", async (_req, res) => {
  const models = await getCmdcModels();
  res.json({
    ok: true,
    agent: agentStatus(),
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
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) {
    res.status(400).json({ error: "A prompt is required" });
    return;
  }
  if (prompt.length > 50000) {
    res.status(400).json({ error: "The prompt is too long (50000 characters max)" });
    return;
  }

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
  }, 15000);

  try {
    const result = await design({
      prompt,
      currentSpec: req.body?.spec ?? null,
      lod: req.body?.lod,
      model: typeof req.body?.model === "string" && req.body.model.trim() ? req.body.model.trim() : undefined,
      attachments: normalizeAttachments(req.body?.attachments),
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
  const analysis = analyzeSpec(req.body?.spec);

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

app.get("/api/download-rfa", (req, res) => {
  const filePath = req.query?.path;
  if (!filePath || typeof filePath !== "string") {
    res.status(400).send("Path is required");
    return;
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    res.status(404).send("File not found");
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
  const resolved = path.resolve(specPath);
  if (!fs.existsSync(resolved)) {
    res.status(404).send("Spec file not found");
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
    const safeId = path.basename(req.params.id).replace(/[^\w.\- ]+/g, "_");
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

app.post("/api/models", (req, res) => {
  try {
    ensureSavedDir();
    const { id, name, spec, entries } = req.body || {};
    if (!spec || !spec.name) {
      res.status(400).json({ error: "spec is required" });
      return;
    }
    const modelId = id
      ? path.basename(id).replace(/[^\w.\- ]+/g, "_")
      : `${Date.now()}-${(name || spec.name).toLowerCase().replace(/[^\w]+/g, "-").slice(0, 50)}`;

    const filePath = path.join(config.dirs.saved, `${modelId}.json`);
    const payload = {
      id: modelId,
      name: name || spec.name,
      spec,
      entries: Array.isArray(entries) ? entries : [],
      savedAt: Date.now(),
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
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

app.listen(config.port, () => {
  const status = agentStatus();
  console.log(`Family Agent API on http://localhost:${config.port}`);
  console.log(`  agent     ${status.provider} · ${status.model}`);
  console.log(`  revit     ${config.bridge.url}`);
  console.log(`  output    ${config.dirs.out}`);
});
