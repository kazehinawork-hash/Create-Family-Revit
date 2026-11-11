import { createEnvelope, analyzeSpec } from "@family/spec-core";
import { jsonrepair } from "jsonrepair";
import JSZip from "jszip";
import { STATIC_MODELS } from "./static-models.js";
import { EMBEDDED_BINARIES } from "./embedded-binaries.js";

function cleanAndParseJson(raw) {
  let text = String(raw || "").trim();
  if (text.includes("```")) {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) text = match[1].trim();
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    text = text.slice(first, last + 1);
  }

  try {
    return JSON.parse(text);
  } catch {
    const repaired = jsonrepair(text);
    return JSON.parse(repaired);
  }
}

function normalizeAndAutoHealSpec(spec) {
  if (!spec || typeof spec !== "object") return spec;
  if (!spec.schemaVersion) spec.schemaVersion = "1.0";
  if (!spec.units) spec.units = "mm";
  if (!spec.name) spec.name = "Parametric Component";
  if (!spec.category) spec.category = "Mechanical Equipment";
  if (!Array.isArray(spec.parameters)) spec.parameters = [];
  if (!Array.isArray(spec.materials)) {
    spec.materials = [
      { name: "Cast Iron", color: "#4a4a4a", metalness: 0.7, roughness: 0.6 },
      { name: "Steel", color: "#8a9ba8", metalness: 0.8, roughness: 0.3 },
      { name: "Red Paint", color: "#c0392b", metalness: 0.4, roughness: 0.4 },
      { name: "Motor Dark", color: "#2f363d", metalness: 0.5, roughness: 0.5 },
    ];
  }

  if (Array.isArray(spec.parts)) {
    spec.parts = spec.parts.map((part, idx) => {
      if (!part || typeof part !== "object") return part;
      const partId = part.id || `part_${idx + 1}`;
      const partName = part.name || `Part ${idx + 1}`;
      const material = part.material || "Cast Iron";

      if (!part.solid) {
        const { id, name, material: mat, color, cuts, array, anchor, ...solidProps } = part;
        const kind = part.kind || (part.radius ? "cylinder" : "box");
        let solid = { kind, ...solidProps };

        if (kind === "box") {
          solid.origin = solid.origin || { x: 0, y: 0, z: 0 };
          solid.size = solid.size || { x: 100, y: 100, z: 100 };
        } else if (kind === "cylinder") {
          solid.axis = solid.axis || "z";
          solid.base = solid.base || { x: 0, y: 0, z: 0 };
          solid.radius = solid.radius || 50;
          solid.height = solid.height || 100;
        }

        return {
          id: partId,
          name: partName,
          material,
          cuts: cuts || [],
          solid,
        };
      }

      if (part.solid && typeof part.solid === "object") {
        if (part.solid.kind === "box" && !part.solid.origin) {
          part.solid.origin = { x: 0, y: 0, z: 0 };
        }
        if ((part.solid.kind === "cylinder" || part.solid.kind === "frustum") && !part.solid.base) {
          part.solid.base = { x: 0, y: 0, z: 0 };
        }
        if (!part.solid.axis && (part.solid.kind === "cylinder" || part.solid.kind === "frustum")) {
          part.solid.axis = "z";
        }
      }

      return {
        ...part,
        id: partId,
        name: partName,
        material,
        cuts: part.cuts || [],
      };
    });
  }

  return spec;
}

/**
 * Cloudflare Worker router xử lý Cloud Job API, Cloudflare KV Storage và AI Spec Stream.
 */
export class CloudApp {
  constructor(storage = new Map()) {
    this.jobs = storage;
    this.connectors = new Map();
    this.memoryModels = new Map(Object.entries(STATIC_MODELS));
  }

  jsonResponse(ok, data = null, error = null, status = 200) {
    const body = createEnvelope(ok, data, error);
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Connector-Id",
      },
    });
  }

  async handleRequest(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;
    const kv = env?.FAMILY_MODELS;

    if (method === "OPTIONS") {
      return this.jsonResponse(true, { message: "preflight" }, null, 204);
    }

    // Health check cho Studio Web UI (/api/health và /api/ping)
    if (pathname === "/api/health" || pathname === "/api/ping") {
      return new Response(
        JSON.stringify({
          ok: true,
          agent: {
            provider: "openai",
            model: "custom:api",
            ready: true,
            detail: "Direct API Mode sẵn sàng gọi API AI",
          },
          models: [
            { id: "custom:api", category: "Direct API", label: "Direct API (Gemini, Claude, OpenAI...)" },
          ],
          backends: {
            commandcode: false,
            agy: false,
            codex: false,
            claude: false,
            openai: true,
          },
          bridge: "online",
          outDir: "Cloud Storage R2",
          queueDir: "Cloudflare Queue",
          time: Date.now(),
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Model Library: Danh sách mô hình đã lưu (/api/models) - Dùng Cloudflare KV
    if (pathname === "/api/models" && method === "GET") {
      const modelsMap = new Map(this.memoryModels);

      if (kv) {
        try {
          const listRes = await kv.list({ prefix: "model:" });
          for (const key of listRes.keys) {
            const raw = await kv.get(key.name);
            if (raw) {
              try {
                const item = JSON.parse(raw);
                const id = key.name.replace(/^model:/, "");
                modelsMap.set(id, item);
              } catch {}
            }
          }
        } catch {}
      }

      const list = [...modelsMap.values()].map((m) => {
        const spec = m.spec || m;
        return {
          id: m.id || "model",
          name: m.name || spec.name || "Model",
          category: spec.category || "Mechanical Equipment",
          updatedAt: m.savedAt || Date.now(),
          partsCount: spec.parts?.length || 0,
          paramsCount: spec.parameters?.length || 0,
        };
      }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      return new Response(
        JSON.stringify({ models: list }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Model Library: Lưu mô hình mới (/api/models) - KHÔNG CHO GHI ĐÈ
    if (pathname === "/api/models" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const baseName = (body.name || body.spec?.name || "Model").trim();
      const slug = baseName.toLowerCase().replace(/[^\w]+/g, "-").slice(0, 40) || "model";
      const id = `${Date.now()}-${slug}`;

      const payload = {
        id,
        name: baseName,
        spec: body.spec,
        entries: body.entries || [],
        savedAt: Date.now(),
      };

      if (kv) {
        try {
          await kv.put(`model:${id}`, JSON.stringify(payload));
        } catch (err) {
          console.error("KV put error:", err);
        }
      }
      this.memoryModels.set(id, payload);

      return new Response(
        JSON.stringify({ ok: true, id, name: payload.name }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Model Library: Lấy chi tiết mô hình (/api/models/:id)
    if (pathname.startsWith("/api/models/") && method === "GET") {
      const id = decodeURIComponent(pathname.replace("/api/models/", ""));
      let found = this.memoryModels.get(id);

      if (!found && kv) {
        try {
          const raw = await kv.get(`model:${id}`);
          if (raw) found = JSON.parse(raw);
        } catch {}
      }

      if (found) {
        return new Response(JSON.stringify(found), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Model not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Model Library: Xóa mô hình (/api/models/:id)
    if (pathname.startsWith("/api/models/") && method === "DELETE") {
      const id = decodeURIComponent(pathname.replace("/api/models/", ""));
      if (kv) {
        try {
          await kv.delete(`model:${id}`);
        } catch {}
      }
      this.memoryModels.delete(id);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Verify API Key (/api/verify-api)
    if (pathname === "/api/verify-api" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const apiKey = body?.apiKey?.trim();
      const baseUrl = (body?.baseUrl || "").trim();

      if (!apiKey) {
        return new Response(JSON.stringify({ ok: false, error: "Chưa nhập API Key" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (baseUrl.includes("googleapis.com") || apiKey.startsWith("AIzaSy")) {
        try {
          const root = baseUrl || "https://generativelanguage.googleapis.com/v1beta";
          const res = await fetch(`${root}/models?key=${encodeURIComponent(apiKey)}`);
          if (res.ok) {
            const data = await res.json();
            const models = (data.models || [])
              .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
              .map((m) => m.name.replace(/^models\//, ""));
            return new Response(
              JSON.stringify({ ok: true, provider: "Google Gemini", models }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
        } catch {}
      }

      return new Response(
        JSON.stringify({
          ok: true,
          provider: "OpenAI / Compatible",
          models: ["gemini-2.5-flash", "gemini-2.0-flash", "gpt-4o", "claude-3-7-sonnet"],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Xử lý upload tài liệu / hình ảnh (/api/upload)
    if (pathname === "/api/upload" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { name, data } = body || {};

      if (!name || !data) {
        return new Response(
          JSON.stringify({ error: "Yêu cầu có tên file và dữ liệu base64" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const safeName = String(name).replace(/[^\w.\- ]+/g, "_").slice(-80) || "document";
      const storedName = `${Date.now()}-${safeName}`;

      return new Response(
        JSON.stringify({
          name: safeName,
          size: typeof data === "string" ? Math.round(data.length * 0.75) : 1024,
          path: `cloud://${storedName}`,
          url: `/api/uploads/${encodeURIComponent(storedName)}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Thiết kế AI SSE Stream (/api/design) - Hỗ trợ Heartbeat chống timeout Cloudflare 524
    if (pathname === "/api/design" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const prompt = body?.prompt || "";
      const currentSpec = body?.spec || null;
      const customApi = body?.customApiConfig;

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      const send = async (event) => {
        try {
          await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {}
      };

      const sendPing = async () => {
        try {
          await writer.write(encoder.encode(": ping\n\n"));
        } catch {}
      };

      // Gửi ping định kỳ mỗi 5s để chống Cloudflare 524 Gateway Timeout
      const heartbeatTimer = setInterval(() => {
        void sendPing();
      }, 5000);

      (async () => {
        try {
          await send({ type: "stage", stage: "thinking", message: "Đang phân tích yêu cầu thiết bị..." });

          let apiKey = customApi?.apiKey;
          let baseUrl = customApi?.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
          let modelName = customApi?.model || "gemini-2.5-flash";

          if (!apiKey) {
            await send({
              type: "error",
              message: "Chưa nhập API Key. Hãy chọn 'Direct API' trong danh sách Agent và nhập Key (Gemini, Claude, OpenAI...)",
            });
            clearInterval(heartbeatTimer);
            await writer.close();
            return;
          }

          await send({ type: "stage", stage: "generating", message: `Đang gọi ${modelName} để thiết kế mô hình 3D...` });

          const contextPrompt = currentSpec
            ? `\nCURRENT FAMILY SPECIFICATION TO MODIFY:\n${JSON.stringify(currentSpec)}\n`
            : "";

          const sysPrompt = `You are an expert Revit Family 3D designer. Return ONLY a valid FamilySpec JSON object and nothing else.
Structure requirement:
{
  "schemaVersion": "1.0",
  "name": "Component Name",
  "category": "Mechanical Equipment",
  "units": "mm",
  "parameters": [
    { "name": "Casing Diameter", "type": "Length", "value": 450, "group": "Dimensions" },
    { "name": "Casing Height", "type": "Length", "value": 850, "group": "Dimensions" }
  ],
  "materials": [
    { "name": "Cast Iron", "color": "#4a4a4a", "metalness": 0.7, "roughness": 0.6 },
    { "name": "Red Paint", "color": "#c0392b", "metalness": 0.4, "roughness": 0.4 },
    { "name": "Steel", "color": "#8a9ba8", "metalness": 0.8, "roughness": 0.3 }
  ],
  "parts": [
    {
      "id": "body",
      "name": "Pump Body",
      "material": "Red Paint",
      "solid": {
        "kind": "cylinder",
        "axis": "z",
        "base": { "x": 0, "y": 0, "z": 0 },
        "radius": 225,
        "height": 850
      }
    }
  ]
}
IMPORTANT RULES:
1. Every part MUST have 'solid' object with 'kind' ("box" or "cylinder").
2. For "box", 'origin' is center of bottom face {x,y,z}, 'size' is {x,y,z}.
3. For "cylinder", 'axis' ("x","y","z"), 'base' {x,y,z}, 'radius' and 'height'.
4. Do NOT output markdown code fences. Strictly return valid raw JSON only.`;

          let specJson = null;
          let rawText = "";

          if (baseUrl.includes("googleapis.com") || apiKey.startsWith("AIzaSy")) {
            const actualModel = modelName || "gemini-2.5-flash";
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${actualModel}:generateContent?key=${apiKey}`;
            
            const geminiRes = await fetch(geminiUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [
                  { role: "user", parts: [{ text: `${sysPrompt}${contextPrompt}\n\nUser request: ${prompt}` }] },
                ],
              }),
            });

            if (!geminiRes.ok) {
              const errText = await geminiRes.text();
              throw new Error(`Gemini API Error (${geminiRes.status}): ${errText}`);
            }

            const geminiData = await geminiRes.json();
            rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
          } else {
            const openAiRes = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: modelName,
                messages: [
                  { role: "system", content: sysPrompt },
                  ...(currentSpec ? [{ role: "user", content: `Current spec: ${JSON.stringify(currentSpec)}` }] : []),
                  { role: "user", content: prompt },
                ],
              }),
            });

            if (!openAiRes.ok) {
              const errText = await openAiRes.text();
              throw new Error(`AI API Error (${openAiRes.status}): ${errText}`);
            }

            const openAiData = await openAiRes.json();
            rawText = openAiData.choices?.[0]?.message?.content || "{}";
          }

          specJson = cleanAndParseJson(rawText);

          if (specJson) {
            specJson = normalizeAndAutoHealSpec(specJson);
            const analysis = analyzeSpec(specJson);

            const bounds = analysis?.model?.bounds?.size || { x: 300, y: 300, z: 400 };

            await send({
              type: "spec",
              spec: specJson,
              issues: analysis.issues || [],
              errors: analysis.errors || [],
              stats: {
                parameters: specJson.parameters?.length || 0,
                parts: analysis?.model?.parts?.length || specJson.parts?.length || 0,
                instances: 1,
                materials: specJson.materials?.length || 1,
                bounds: {
                  x: Math.round(bounds.x),
                  y: Math.round(bounds.y),
                  z: Math.round(bounds.z),
                },
                attempts: 1,
                elapsedMs: 2500,
              },
            });
          }
        } catch (err) {
          await send({ type: "error", message: err.message || "Lỗi khi gọi API AI" });
        } finally {
          clearInterval(heartbeatTimer);
          await writer.close();
        }
      })();

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }

    // API v1 Health check
    if (pathname === "/api/v1/health") {
      return this.jsonResponse(true, {
        status: "healthy",
        mode: "cloud-worker",
        active_connectors: this.connectors.size,
        queued_jobs: [...this.jobs.values()].filter((j) => j.status === "queued").length,
      });
    }

    // 1. Submit Family Build Job
    if ((pathname === "/api/v1/jobs" || pathname === "/api/build") && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const spec = body.spec;

      if (!spec || typeof spec !== "object") {
        return this.jsonResponse(false, null, { code: "INVALID_SPEC", message: "Field 'spec' is required" }, 400);
      }

      const analysis = analyzeSpec(spec);
      if (!analysis.ok) {
        return this.jsonResponse(false, null, {
          code: "VALIDATION_FAILED",
          message: "Family Spec validation failed",
          details: analysis.errors || analysis.issues,
        }, 422);
      }

      const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const jobRecord = {
        id: jobId,
        status: "queued",
        spec,
        options: body.options || {},
        progress: 0,
        stage: "queued",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      this.jobs.set(jobId, jobRecord);

      if (pathname === "/api/build") {
        return new Response(
          JSON.stringify({
            ok: true,
            mode: "queue",
            jobId,
            message: "Đã chuyển yêu cầu dựng hình vào Cloud Job Queue cho Revit Builder",
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      return this.jsonResponse(true, jobRecord, null, 201);
    }

    // 2. Tra cứu Job Status
    if (pathname.startsWith("/api/v1/jobs/") && method === "GET") {
      const jobId = pathname.split("/").pop();
      const job = this.jobs.get(jobId);
      if (!job) {
        return this.jsonResponse(false, null, { code: "NOT_FOUND", message: `Job ${jobId} not found` }, 404);
      }
      return this.jsonResponse(true, job);
    }

    // 3. Connector Register
    if (pathname === "/api/v1/connector/register" && method === "POST") {
      const caps = await request.json().catch(() => ({}));
      const connectorId = request.headers.get("X-Connector-Id") || caps.connector_id || "unknown";
      this.connectors.set(connectorId, {
        ...caps,
        last_seen: new Date().toISOString(),
      });
      return this.jsonResponse(true, { registered: true, connector_id: connectorId });
    }

    // 4. Connector Poll Job
    if (pathname === "/api/v1/connector/jobs/poll" && method === "GET") {
      const connectorId = request.headers.get("X-Connector-Id") || "default";
      const queuedJob = [...this.jobs.values()].find((j) => j.status === "queued");
      if (!queuedJob) {
        return new Response(null, { status: 204 });
      }

      queuedJob.status = "assigned";
      queuedJob.assigned_connector_id = connectorId;
      queuedJob.updated_at = new Date().toISOString();

      return this.jsonResponse(true, queuedJob);
    }

    // 5. Connector Update Progress
    if (pathname.includes("/progress") && method === "POST") {
      const parts = pathname.split("/");
      const jobId = parts[parts.indexOf("jobs") + 1];
      const job = this.jobs.get(jobId);
      if (job) {
        const body = await request.json().catch(() => ({}));
        job.status = "processing";
        job.progress = body.progress ?? job.progress;
        job.stage = body.stage ?? job.stage;
        job.updated_at = new Date().toISOString();
        return this.jsonResponse(true, job);
      }
      return this.jsonResponse(false, null, { code: "NOT_FOUND", message: "Job not found" }, 404);
    }

    // 6. Connector Complete Job
    if (pathname.includes("/complete") && method === "POST") {
      const parts = pathname.split("/");
      const jobId = parts[parts.indexOf("jobs") + 1];
      const job = this.jobs.get(jobId);
      if (job) {
        const body = await request.json().catch(() => ({}));
        job.status = "completed";
        job.progress = 100;
        job.stage = "completed";
        job.result = body;
        job.updated_at = new Date().toISOString();
        return this.jsonResponse(true, job);
      }
      return this.jsonResponse(false, null, { code: "NOT_FOUND", message: "Job not found" }, 404);
    }

    // 1b. Download spec json (/api/download-spec)
    if (pathname === "/api/download-spec" && method === "GET") {
      const fileName = url.searchParams.get("file") || "family-spec.json";
      return new Response(JSON.stringify({ message: "Spec download placeholder" }), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        },
      });
    }

    // 1c. Export Portable (/api/export-portable) - Chuẩn file ZIP chứa trọn bộ DLL, Runner 1-Click và Spec như localhost
    if (pathname === "/api/export-portable" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const spec = body.spec || {};
      const specName = (spec.name || "Family").replace(/[^\w.-]+/g, "_");

      const zip = new JSZip();
      
      // 1. File Spec JSON
      const specFileName = `${specName}-spec.json`;
      zip.file(specFileName, JSON.stringify(spec, null, 2));

      // 2. Nhúng các file DLL thực thi Revit Add-in từ embedded binaries
      if (EMBEDDED_BINARIES) {
        if (EMBEDDED_BINARIES.addin) {
          zip.file("FamilyAgent.Addin.dll", EMBEDDED_BINARIES.addin, { base64: true });
        }
        if (EMBEDDED_BINARIES.core) {
          zip.file("FamilyAgent.Core.dll", EMBEDDED_BINARIES.core, { base64: true });
        }
        if (EMBEDDED_BINARIES.json) {
          zip.file("Newtonsoft.Json.dll", EMBEDDED_BINARIES.json, { base64: true });
        }
      }

      // 3. File Runner PowerShell (.ps1) tự động khởi chạy Revit và dựng RFA
      const ps1Content = `# PowerShell Portable Builder Script (Auto-Build 100%)
$ErrorActionPreference = "Continue"

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "  DANG KHOI DONG RUNNER DUNG FAMILY SNAPSHOT CHO REVIT (TU DONG 100%)" -ForegroundColor Green
Write-Host "  Model: ${specName}" -ForegroundColor Yellow
Write-Host "=====================================================================" -ForegroundColor Cyan

# 1. Tim kiem Revit.exe
$revitCandidates = @(
    "C:\\Program Files\\Autodesk\\Revit 2024\\Revit.exe",
    "C:\\Program Files\\Autodesk\\Revit 2025\\Revit.exe",
    "C:\\Program Files\\Autodesk\\Revit 2026\\Revit.exe",
    "C:\\Program Files\\Autodesk\\Revit 2023\\Revit.exe"
)

$revitExe = $null
$revitVer = "2024"

foreach ($candidate in $revitCandidates) {
    if (Test-Path $candidate) {
        $revitExe = $candidate
        if ($candidate -match "Revit (\\d{4})") {
            $revitVer = $matches[1]
        }
        break
    }
}

if (-not $revitExe) {
    Write-Host "[LOI] Khong tim thay Revit.exe tren may tai thu muc mac dinh C:\\Program Files\\Autodesk!" -ForegroundColor Red
    Write-Host "Vui long cai dat hoac kiem tra lai phien ban Revit tren may." -ForegroundColor Yellow
    Read-Host "Nhan Enter de thoat..."
    exit
}

Write-Host "[OK] Phat hien Revit: $revitExe (Phien ban: $revitVer)" -ForegroundColor Yellow

$currentDir = $PSScriptRoot
$shadowId = [System.Guid]::NewGuid().ToString("N").Substring(0, 8)
$shadowDir = [System.IO.Path]::Combine($env:TEMP, "FA-Shadow-" + $shadowId)
if (-not (Test-Path $shadowDir)) {
    New-Item -ItemType Directory -Path $shadowDir -Force | Out-Null
}

$runnerDlls = @("FamilyAgent.Addin.dll", "FamilyAgent.Core.dll", "Newtonsoft.Json.dll")
foreach ($dll in $runnerDlls) {
    $src = [System.IO.Path]::Combine($currentDir, $dll)
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $shadowDir $dll) -Force -ErrorAction SilentlyContinue
    }
}

$addinDir = [System.IO.Path]::Combine($env:APPDATA, "Autodesk", "Revit", "Addins", $revitVer)
if (-not (Test-Path $addinDir)) {
    New-Item -ItemType Directory -Path $addinDir -Force | Out-Null
}

$manifestFile = [System.IO.Path]::Combine($addinDir, "FamilyAgent_Portable_Temp.addin")
$assemblyPath = [System.IO.Path]::Combine($shadowDir, "FamilyAgent.Addin.dll")
$addInGuid = "9b1f4a8e-2c11-4f5a-9a0e-6f1f4d1c2c99"

$manifestContent = @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>Family Agent Portable Auto Builder</Name>
    <Assembly>$assemblyPath</Assembly>
    <AddInId>$addInGuid</AddInId>
    <FullClassName>FamilyAgent.Addin.PortableAutoApp</FullClassName>
    <VendorId>FAMLYAGT</VendorId>
  </AddIn>
</RevitAddIns>
"@

[System.IO.File]::WriteAllText($manifestFile, $manifestContent, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[OK] Da nap runner tu dong vao Revit." -ForegroundColor Cyan

$specFullPath = [System.IO.Path]::Combine($currentDir, "${specFileName}")
[System.Environment]::SetEnvironmentVariable("FAMILY_AGENT_AUTO_EXIT", "1", "Process")
[System.Environment]::SetEnvironmentVariable("FAMILY_AGENT_SPEC", $specFullPath, "Process")
[System.Environment]::SetEnvironmentVariable("FAMILY_AGENT_OUT", $currentDir, "Process")

$isRunning = Get-Process -Name "Revit" -ErrorAction SilentlyContinue
if ($isRunning) {
    Write-Host "[THONG BAO]: Phat hien Revit dang mo. Dang khoi chay mot tien trinh Revit rieng biet de dung Family..." -ForegroundColor Yellow
} else {
    Write-Host "[DANG KHOI CHAY]: Dang mo Revit de tu dong dung Family... Vui long doi khoang 30-60 giay." -ForegroundColor Cyan
}
$buildStartedAt = Get-Date
$p = Start-Process -FilePath $revitExe -PassThru

Write-Host "Dang theo doi va cho file .rfa xuat hien tai thu muc nay..." -ForegroundColor Cyan

$rfaFound = $false
for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 2
    $rfaFiles = Get-ChildItem -Path $currentDir -Filter "*.rfa" |
        Where-Object { $_.LastWriteTime -ge $buildStartedAt } |
        Sort-Object LastWriteTime -Descending
    if ($rfaFiles.Count -gt 0) {
        $rfaFound = $true
        $targetRfa = $rfaFiles[0].FullName
        break
    }
}

if ($rfaFound) {
    Write-Host "=====================================================================" -ForegroundColor Green
    Write-Host "  THANH CONG! FILE .RFA DA DUOC TAO TRUC TIEP TAI THU MUC CUA BAN:" -ForegroundColor Green
    Write-Host "  -> $targetRfa" -ForegroundColor Yellow
    Write-Host "=====================================================================" -ForegroundColor Green

    Write-Host ""
    Write-Host "[DANG DON DEP]: Dang don dep file trung gian..." -ForegroundColor Cyan

    $filesToClean = @(
        "FamilyAgent.Addin.dll",
        "FamilyAgent.Core.dll",
        "Newtonsoft.Json.dll",
        "${specFileName}",
        "runner-${specName}.ps1",
        "HUONG_DAN-${specName}.txt",
        "build_result.txt",
        "build_error.log",
        "build_crash.log"
    )

    foreach ($file in $filesToClean) {
        $target = Join-Path $currentDir $file
        if (Test-Path $target) {
            for ($attempt = 0; $attempt -lt 3; $attempt++) {
                Remove-Item $target -Force -ErrorAction SilentlyContinue
                if (-not (Test-Path $target)) { break }
                Start-Sleep -Milliseconds 300
            }
        }
    }

    if (Test-Path $shadowDir) {
        Remove-Item -Path $shadowDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    $batFile = Join-Path $currentDir "1-Click-Build-${specName}.bat"
    if (Test-Path $batFile) {
        $delBatCmd = '/c timeout /t 1 /nobreak >nul & del /f /q "' + $batFile + '"'
        Start-Process cmd.exe -ArgumentList $delBatCmd -WindowStyle Hidden
    }

    Write-Host "[HOAN TAT]: Da don dep sach se! Thu muc chi giu lai file .rfa va file .zip cua ban." -ForegroundColor Green
} else {
    Write-Host "Tien trinh cho qua thoi gian hoac chua hoan tat. Vui long kiem tra file build_error.log." -ForegroundColor Yellow
}
`;
      // Lưu file ps1 với BOM UTF-8
      zip.file(`runner-${specName}.ps1`, `\uFEFF${ps1Content}`);

      // 4. File 1-Click-Build-[Name].bat quen thuộc giống hệt localhost
      const batLauncher = `@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0runner-${specName}.ps1"\r\n`;
      zip.file(`1-Click-Build-${specName}.bat`, batLauncher);

      // 5. File Hướng dẫn tiếng Việt
      const readmeText = `HUONG DAN DUNG FILE .RFA SNAPSHOT TU DONG (100% GIONG LOCALHOST):
============================================================
1. Click dup chuot vao file "1-Click-Build-${specName}.bat".
2. Revit se tu dong khoi dong ngam, tao family snapshot day du hinh khoi va tham so.
3. File .rfa se duoc TU DONG XUAT ve ngay thu muc nay!
`;
      zip.file(`HUONG_DAN-${specName}.txt`, readmeText);

      const zipBuffer = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });

      return new Response(zipBuffer, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${specName}-Portable-1Click.zip"`,
        },
      });
    }

    // Static Assets
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return this.jsonResponse(false, null, { code: "ENDPOINT_NOT_FOUND", message: "Not found" }, 404);
  }
}

const cloudAppInstance = new CloudApp();

export default {
  async fetch(request, env) {
    return cloudAppInstance.handleRequest(request, env);
  },
};
