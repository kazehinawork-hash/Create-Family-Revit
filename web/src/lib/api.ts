import type { FamilySpec, Issue } from "@family/spec-core";

export interface DesignStats {
  parameters: number;
  parts: number;
  instances: number;
  materials: number;
  lod?: number;
  bounds: { x: number; y: number; z: number } | null;
  attempts: number;
  elapsedMs: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  cached?: boolean;
  tier?: number;
  tierLabel?: string;
  /** false when the spec does not satisfy the extracted requirement checklist. */
  complete?: boolean;
  missing?: string[];
  checklist?: unknown;
  model?: string | null;
  modelCalls?: number;
  promptChars?: number;
  savedCalls?: number;
  calls?: Array<{ tier: number; model: string; promptChars: number; modelCalls: number }>;
  step?: { index: number; total: number; label: string; partial?: boolean };
  steps?: Array<{ label: string; ms: number; ok: boolean; error?: string }>;
  warnings?: string[];
  /** Product type, rule pack origin and the values the agent actually used. */
  productType?: string | null;
  ruleSource?: "builtin" | "learned" | "learned-new" | null;
  resolution?: Array<{
    name: string;
    value: unknown;
    level?: number;
    source?: string;
  }>;
  fastEdit?: {
    name: string;
    type: string;
    value: number;
    affectedParameters?: string[];
    affectedParts?: string[];
    affectedConnectors?: string[];
  };
}

export interface StageEvent {
  type: "stage";
  stage: string;
  message: string;
  issues?: Issue[];
  details?: string;
}

export interface SpecEvent {
  type: "spec";
  spec: FamilySpec;
  issues: Issue[];
  errors: Issue[];
  stats: DesignStats;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  /** Raw provider text, shown inside the collapsible "details" block. */
  details?: string;
  retryable?: boolean;
}

/** First frame of every design stream: the id used to recover a result later. */
export interface JobEvent {
  type: "job";
  jobId: string;
}

/** A saved family close enough to be used as the starting point. */
export interface SuggestionEvent {
  type: "suggestion";
  sample: { id: string; name: string; score: number };
}

export type DesignEvent = JobEvent | SuggestionEvent | StageEvent | SpecEvent | ErrorEvent;

export interface DesignJob {
  job_id: string;
  status: "running" | "done" | "error";
  spec: FamilySpec | null;
  issues: Issue[];
  errors: Issue[];
  warnings: string[];
  stats: DesignStats | null;
  error: string | null;
}

export async function fetchDesignJob(jobId: string): Promise<DesignJob | null> {
  const response = await fetch(`/api/design/jobs/${encodeURIComponent(jobId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Job request failed (${response.status})`);

  const payload = (await response.json()) as { job?: DesignJob };
  return payload.job ?? null;
}

export interface AgentStatus {
  provider: string;
  model: string;
  ready: boolean;
  detail: string;
}

export interface CmdcModel {
  id: string;
  category: string;
  label: string;
}

export interface AgentBackends {
  commandcode: boolean;
  agy: boolean;
  codex: boolean;
  claude: boolean;
  openai: boolean;
}

export interface Health {
  ok: boolean;
  agent: AgentStatus;
  models?: CmdcModel[];
  backends?: AgentBackends;
  bridge: string;
  outDir: string;
  queueDir: string;
}

export async function fetchHealth(): Promise<Health | null> {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return null;
    return (await response.json()) as Health;
  } catch {
    return null;
  }
}

export interface ServerPing {
  ok: boolean;
  agent: AgentStatus;
  time: number;
}

/** Lightweight liveness probe; safe to poll while a design run is in flight. */
export async function pingServer(): Promise<ServerPing | null> {
  try {
    const response = await fetch("/api/ping");
    if (!response.ok) return null;
    return (await response.json()) as ServerPing;
  } catch {
    return null;
  }
}

export interface UploadedDocument {
  name: string;
  size: number;
  path: string;
  url?: string;
}

export function isImageDocument(doc: UploadedDocument): boolean {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(doc.name);
}

export async function uploadDocument(file: File): Promise<UploadedDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }

  const response = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, data: btoa(binary) }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Upload failed (${response.status})`);
  }
  return payload as UploadedDocument;
}

export interface CustomApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type Lod = 200 | 300 | 350 | 400;

export async function streamDesign(
  payload: {
    prompt: string;
    spec: FamilySpec | null;
    lod?: Lod;
    model?: string;
    /** Never switch to a fallback model, even if the selected one is overloaded. */
    lockModel?: boolean;
    customApiConfig?: CustomApiConfig;
    attachments?: { path: string; name: string }[];
  },
  onEvent: (event: DesignEvent) => void,
  signal?: AbortSignal,
  onHeartbeat?: () => void,
): Promise<void> {
  const request = () =>
    fetch("/api/design", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });

  let response: Response;
  try {
    response = await request();
  } catch (error) {
    if (signal?.aborted) throw error;
    // A recycled keep-alive socket or a dev-server restart looks like a network
    // failure here. One retry costs a second; after that the caller polls the job.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    response = await request();
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    let message = `Request failed (${response.status})`;
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.error) message = parsed.error;
    } catch {
      if (detail) message = detail.slice(0, 400);
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    // Any byte from the server — including the ": ping" keep-alive — proves it is alive.
    onHeartbeat?.();

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          onEvent(JSON.parse(data) as DesignEvent);
        } catch {
          /* ignore malformed frame */
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export interface BuildStats {
  parts?: number;
  instances?: number;
  forms?: number;
  lofts?: number;
  sweptBlends?: number;
  freeforms?: number;
  voids?: number;
  refPlanes?: number;
  refDimensions?: number;
  locks?: number;
  mode?: "constraints" | "planes" | "rebuild";
  joins?: number;
  totalForms?: number;
  missingForms?: number;
  failedParts?: string[];
  lod?: number | null;
  driving?: string[];
  unlabelled?: string[];
  inert?: string[];
  flex?: string;
  faceDimensions?: number;
  radialDimensions?: number;
  connectors?: number;
  parameters?: number;
  volumeMm3?: number;
  bounds?: { x: number; y: number; z: number };
  elapsedMs?: number;
}

export interface BuildQaCheck {
  id: string;
  ok: boolean;
  message: string;
}

export interface BuildQa {
  ok: boolean;
  warnings: string[];
  checks: BuildQaCheck[];
  rebuildRequired: boolean;
  parityRisks: number;
}

export interface BuildResult {
  ok: boolean;
  mode?: "revit" | "queue";
  path?: string;
  file?: string;
  error?: string;
  message?: string;
  warnings?: string[];
  revitVersion?: string;
  elapsedMs?: number;
  busy?: boolean;
  issues?: Issue[];
  stats?: BuildStats;
  qa?: BuildQa;
}

export async function buildFamily(spec: FamilySpec): Promise<BuildResult> {
  const response = await fetch("/api/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec }),
  });

  const payload = (await response.json().catch(() => ({}))) as BuildResult;

  if (!response.ok && !payload.mode) {
    return {
      ok: false,
      error: payload.error || `Build request failed (${response.status})`,
      issues: payload.issues,
    };
  }

  return payload;
}

export async function exportMultiType(
  spec: FamilySpec,
): Promise<{ ok: boolean; path?: string; types?: number }> {
  const response = await fetch("/api/export-multi-type", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    path?: string;
    types?: number;
    error?: string;
  };

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Export failed (${response.status})`);
  }

  if (payload.path) {
    const link = document.createElement("a");
    link.href = `/api/download-rfa?path=${encodeURIComponent(payload.path)}`;
    link.download = `${spec.name || "Family"}-types.rfa`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  return { ok: true, path: payload.path, types: payload.types };
}

export async function downloadPortablePackage(spec: FamilySpec): Promise<void> {
  const response = await fetch("/api/export-portable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(errorText || "Không thể tạo gói Portable (HTTP " + response.status + ")");
  }

  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = (spec.name || "Family") + "-Portable-1Click.zip";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(blobUrl);
}

// -------------------------------------------------------------
// Model Library API (Lưu, Quản lý, Tiếp tục sửa, Xoá)
// -------------------------------------------------------------
export interface SavedModelMeta {
  id: string;
  name: string;
  category: string;
  updatedAt: number;
  partsCount: number;
  paramsCount: number;
}

export interface SavedModelDetail {
  id: string;
  name: string;
  spec: FamilySpec;
  entries: any[];
  savedAt: number;
}

export async function fetchSavedModels(): Promise<SavedModelMeta[]> {
  try {
    const res = await fetch("/api/models");
    if (!res.ok) return [];
    const data = await res.json();
    return data.models || [];
  } catch {
    return [];
  }
}

export async function fetchSavedModelDetail(id: string): Promise<SavedModelDetail | null> {
  try {
    const res = await fetch(`/api/models/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface SavedModelRevision {
  stamp: string;
  savedAt: number;
  name: string;
  parts: number;
  parameters: number;
}

export async function fetchModelHistory(id: string): Promise<SavedModelRevision[]> {
  try {
    const res = await fetch(`/api/models/${encodeURIComponent(id)}/history`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.revisions || [];
  } catch {
    return [];
  }
}

export async function fetchModelRevision(id: string, stamp: string): Promise<SavedModelDetail | null> {
  try {
    const res = await fetch(
      `/api/models/${encodeURIComponent(id)}/history/${encodeURIComponent(stamp)}`,
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function saveModel(payload: { id?: string; name?: string; spec: FamilySpec; entries?: any[] }): Promise<{ ok: boolean; id?: string }> {
  const res = await fetch("/api/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

export async function renameModel(
  id: string,
  name: string,
): Promise<{ ok: boolean; id: string; name: string; savedAt?: number }> {
  const res = await fetch(`/api/models/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Rename failed (${res.status})`);
  }

  return data;
}

export async function deleteSavedModel(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/models/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return await res.json();
}

export interface ExternalSpecPayload {
  preview_id: string | null;
  spec_hash: string;
  spec: FamilySpec;
  updated_at: string;
  geometry_summary?: {
    bounds?: { x: number; y: number; z: number } | null;
    parts_count?: number;
    parameters_count?: number;
    connectors_count?: number;
  };
  warnings?: string[];
}

export async function fetchLatestExternalSpec(): Promise<ExternalSpecPayload | null> {
  try {
    const res = await fetch("/api/v1/spec/external/latest");
    if (!res.ok) return null;
    const body = await res.json();
    return body.data || null;
  } catch {
    return null;
  }
}

export function subscribeExternalSpecStream(
  onSpec: (data: ExternalSpecPayload) => void,
): () => void {
  let eventSource: EventSource | null = null;
  let active = true;

  try {
    eventSource = new EventSource("/api/v1/spec/external/stream");
    eventSource.onmessage = (event) => {
      if (!active) return;
      try {
        const data = JSON.parse(event.data);
        if (data && data.spec && data.spec_hash) {
          onSpec(data);
        }
      } catch {}
    };
    eventSource.onerror = () => {
      // EventSource automatically retries connection
    };
  } catch {}

  return () => {
    active = false;
    if (eventSource) {
      eventSource.close();
    }
  };
}
