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
}

export interface StageEvent {
  type: "stage";
  stage: string;
  message: string;
  issues?: Issue[];
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
}

export type DesignEvent = StageEvent | SpecEvent | ErrorEvent;

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

export interface Health {
  ok: boolean;
  agent: AgentStatus;
  models?: CmdcModel[];
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
    customApiConfig?: CustomApiConfig;
    attachments?: { path: string; name: string }[];
  },
  onEvent: (event: DesignEvent) => void,
  signal?: AbortSignal,
  onHeartbeat?: () => void,
): Promise<void> {
  const response = await fetch("/api/design", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

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
  voids?: number;
  refPlanes?: number;
  refDimensions?: number;
  locks?: number;
  lod?: number | null;
  driving?: string[];
  unlabelled?: string[];
  inert?: string[];
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

export async function saveModel(payload: { id?: string; name?: string; spec: FamilySpec; entries?: any[] }): Promise<{ ok: boolean; id?: string }> {
  const res = await fetch("/api/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

export async function deleteSavedModel(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/models/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return await res.json();
}
