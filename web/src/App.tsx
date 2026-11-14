import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  analyzeSpec,
  paramKey,
  validateSpec,
  type FamilyParameter,
  type FamilySpec,
  type FamilyTypeEntry,
  type Issue,
  type ParameterType,
} from "@family/spec-core";
import fcuExampleRaw from "../../spec/examples/fcu-080.json";
import pumpExampleRaw from "../../spec/examples/pump-dn80.json";
import ystrainerExampleRaw from "../../spec/examples/ystrainer-dn80.json";
import ystrainerTubeExampleRaw from "../../spec/examples/ystrainer-tube.json";
import { ChatPanel, type ChatEntry } from "./components/ChatPanel";
import { LibraryPanel } from "./components/LibraryPanel";
import { ParameterPanel } from "./components/ParameterPanel";
import { TopBar } from "./components/TopBar";
import { Viewer } from "./components/Viewer";
import {
  buildFamily,
  downloadPortablePackage,
  exportMultiType,
  fetchDesignJob,
  fetchHealth,
  pingServer,
  streamDesign,
  uploadDocument,
  fetchSavedModels,
  fetchSavedModelDetail,
  fetchModelHistory,
  fetchModelRevision,
  saveModel,
  renameModel,
  deleteSavedModel,
  fetchLibraryGroups,
  createLibraryGroup,
  renameLibraryGroup,
  deleteLibraryGroup,
  moveModelToGroup,
  fetchLatestExternalSpec,
  subscribeExternalSpecStream,
  type ExternalSpecPayload,
  type Health,
  type Lod,
  type UploadedDocument,
  type SavedModelMeta,
  type SavedModelRevision,
  type LibraryGroupSummary,
  type DesignJob,
  type DesignStats,
} from "./lib/api";
import { ALL_GROUPS, UNGROUPED, readLibraryState } from "./lib/library";
import { formatDuration, type Units } from "./lib/format";
import { isModelId } from "./lib/api-key";
import { describeOutcome, errorAdvice, splitErrorMessage } from "./lib/outcome";
import { t } from "./lib/strings";
import {
  applyTheme,
  readTheme,
  resolveTheme,
  systemPrefersDark,
  writeTheme,
  type ThemeMode,
} from "./lib/theme";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * The server keeps a design run as a job, so a dropped stream is recoverable.
 * Polls every 3 s for up to 10 minutes; null-ish answers tell the caller why it failed.
 */
async function waitForDesignJob(
  jobId: string,
  signal: AbortSignal,
): Promise<DesignJob | "missing" | "timeout"> {
  const deadline = Date.now() + 10 * 60 * 1000;

  while (Date.now() < deadline) {
    if (signal.aborted) return "timeout";

    let job: DesignJob | null | undefined;
    try {
      job = await fetchDesignJob(jobId);
    } catch {
      job = undefined; // transient network error: keep polling
    }

    if (job === null) return "missing";
    if (job && job.status !== "running") return job;

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  return "timeout";
}

interface StageState {
  stage: string;
  message: string;
  issues?: Issue[];
}

interface ToastState {
  text: string;
  sub?: string;
  tone: "ok" | "warn" | "error";
}

const DEFAULT_LEFT_WIDTH = 322;
const DEFAULT_RIGHT_WIDTH = 342;
const MIN_LEFT_WIDTH = 240;
const MAX_LEFT_WIDTH = 560;
const MIN_RIGHT_WIDTH = 270;
const MAX_RIGHT_WIDTH = 620;
const MIN_VIEWER_WIDTH = 420;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredWidth(key: string, fallback: number): number {
  try {
    const stored = Number(window.localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  } catch {
    return fallback;
  }
}

function storeWidth(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* private mode, ignore */
  }
}

const LOD_LEVELS: Lod[] = [200, 300, 350, 400];

function readStoredLod(): Lod {
  try {
    const stored = Number(window.localStorage.getItem("fa.lod"));
    return LOD_LEVELS.includes(stored as Lod) ? (stored as Lod) : 300;
  } catch {
    return 300;
  }
}

function readStoredModel(): string {
  try {
    return window.localStorage.getItem("fa.model") ?? "";
  } catch {
    return "";
  }
}

export function App() {
  const [spec, setSpec] = useState<FamilySpec | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([
    {
      id: "seed",
      role: "agent",
      text: "Xin chào! Hãy mô tả thiết bị bạn cần dựng hoặc kéo thả tài liệu/bản vẽ (PDF, ảnh) vào đây để tôi bắt đầu thiết kế từ đầu.",
    },
  ]);
  const [stage, setStage] = useState<StageState | null>(null);
  const [running, setRunning] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [building, setBuilding] = useState(false);
  const [exportingTypes, setExportingTypes] = useState(false);
  const [previewTypeValues, setPreviewTypeValues] = useState<Record<string, number> | null>(null);
  const [exportingPortable, setExportingPortable] = useState(false);
  const [native, setNative] = useState(false);
  const [units, setUnits] = useState<Units>("mm");
  const [revitVersion, setRevitVersion] = useState("2024");
  const [lod, setLod] = useState<Lod>(readStoredLod);
  const [model, setModel] = useState<string>(readStoredModel);
  /** Model calls spent in this browser session, per model (the quota table). */
  const [sessionUsage, setSessionUsage] = useState<Record<string, number>>({});
  /** Missing requirement items of the current spec, or null when it is complete. */
  const [incomplete, setIncomplete] = useState<string[] | null>(null);
  const [attachments, setAttachments] = useState<UploadedDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showPlanes, setShowPlanes] = useState(false);
  const [showConnectors, setShowConnectors] = useState(false);
  const [showHandles, setShowHandles] = useState(false);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [highlightPartIds, setHighlightPartIds] = useState<string[]>([]);
  const [focusPartId, setFocusPartId] = useState<string | null>(null);
  const [hiddenPartIds, setHiddenPartIds] = useState<string[]>([]);
  const [transparentPartIds, setTransparentPartIds] = useState<string[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const serverOnlineRef = useRef<boolean | null>(null);
  const [lastBeatAt, setLastBeatAt] = useState<number | null>(null); void lastBeatAt;
  const [toast, setToast] = useState<ToastState | null>(null);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [savedList, setSavedList] = useState<SavedModelMeta[]>([]);
  const [libraryGroups, setLibraryGroups] = useState<LibraryGroupSummary[]>([]);
  const [libraryGroup, setLibraryGroup] = useState(() => readLibraryState().group);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [historyModelId, setHistoryModelId] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readTheme());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const [mobileTab, setMobileTab] = useState<"chat" | "viewer" | "params">("chat");
  const [paramsOpen, setParamsOpen] = useState(false);
  const viewerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const resolvedTheme = resolveTheme(themeMode, systemDark);

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    writeTheme(themeMode);
  }, [themeMode]);

  useEffect(() => {
    try {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    } catch {
      return undefined;
    }
  }, []);
  const [revisions, setRevisions] = useState<SavedModelRevision[]>([]);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** Last brief, so the chat's "Gửi lại" button can resend it. */
  const lastPromptRef = useRef("");

  // Undo/redo stack for spec edits (parameter typing, handles, agent rewrites).
  const specRef = useRef<FamilySpec | null>(null);
  specRef.current = spec;
  const pastRef = useRef<FamilySpec[]>([]);
  const futureRef = useRef<FamilySpec[]>([]);
  const lastRecordRef = useRef(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;
  void historyVersion;
  const [leftWidth, setLeftWidth] = useState(() => readStoredWidth("fa.leftWidth", DEFAULT_LEFT_WIDTH));
  const [rightWidth, setRightWidth] = useState(() =>
    readStoredWidth("fa.rightWidth", DEFAULT_RIGHT_WIDTH),
  );

  useEffect(() => {
    storeWidth("fa.leftWidth", leftWidth);
  }, [leftWidth]);

  useEffect(() => {
    storeWidth("fa.rightWidth", rightWidth);
  }, [rightWidth]);

  const beginResize = (
    side: "left" | "right",
    event: { clientX: number; button: number; preventDefault: () => void },
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startLeft = leftWidth;
    const startRight = rightWidth;

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;

      if (side === "left") {
        const available = window.innerWidth - startRight - MIN_VIEWER_WIDTH - 12;
        setLeftWidth(clamp(startLeft + delta, MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, available)));
      } else {
        const available = window.innerWidth - startLeft - MIN_VIEWER_WIDTH - 12;
        setRightWidth(
          clamp(startRight - delta, MIN_RIGHT_WIDTH, Math.min(MAX_RIGHT_WIDTH, available)),
        );
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing");
    };

    document.body.classList.add("resizing");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const nudgeWidth = (side: "left" | "right", key: "ArrowLeft" | "ArrowRight") => {
    const step = key === "ArrowRight" ? 16 : -16;
    if (side === "left") {
      setLeftWidth((width) => clamp(width + step, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH));
    } else {
      setRightWidth((width) => clamp(width - step, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH));
    }
  };

  const analysis = useMemo(() => (spec ? analyzeSpec(spec) : null), [spec]);

  // A Types row previews in the viewport without touching the saved spec.
  const previewAnalysis = useMemo(() => {
    if (!spec || !previewTypeValues) return null;

    return analyzeSpec({
      ...spec,
      parameters: spec.parameters.map((parameter) => {
        const value = previewTypeValues[parameter.name];
        return value === undefined ? parameter : { ...parameter, value, formula: undefined };
      }),
    });
  }, [spec, previewTypeValues]);

  const previewModel = useDeferredValue(previewAnalysis?.model ?? null);

  useEffect(() => {
    setHighlightPartIds([]);
  }, [spec]);

  // Parts that the layout checks flagged (paths look like logic.drain-pan.<partId>).
  const issuePartIds = useMemo(() => {
    const ids = new Set<string>();
    for (const issue of analysis?.issues ?? []) {
      if (!issue.path.startsWith("logic.")) continue;
      const partId = issue.path.split(".").pop();
      if (partId) ids.add(partId);
    }
    return [...ids];
  }, [analysis]);

  // Typing in a parameter field re-solves the geometry; defer it so the input stays smooth.
  const deferredModel = useDeferredValue(analysis?.model ?? null);
  const deferredParameters = useDeferredValue(spec?.parameters);

  const applyHealth = useCallback((result: Health) => {
    setHealth(result);
    // Keep the user's remembered choice; only auto-pick when nothing is selected
    // or the stored model no longer exists on this machine.
    const available = result.models ?? [];
    setModel((current) => {
      if (current && available.some((entry) => entry.id === current)) return current;
      if (result.agent?.model && available.some((entry) => entry.id === result.agent.model)) {
        return result.agent.model;
      }
      return available[0]?.id ?? "";
    });
  }, []);

  /** Returns the health payload, or null when the API is unreachable. */
  const refreshHealth = useCallback(async () => {
    const result = await fetchHealth();
    if (result) applyHealth(result);
    return result;
  }, [applyHealth]);

  // Health: retry with backoff while the API is down, then refresh every ~60 s.
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    let delay = 2000;

    const attempt = async () => {
      if (!alive) return;
      const result = await refreshHealth();
      if (!alive) return;

      if (result) {
        delay = 2000;
        timer = window.setTimeout(attempt, 60000);
        return;
      }

      timer = window.setTimeout(attempt, delay);
      delay = Math.min(delay * 2, 30000);
    };

    void attempt();

    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshHealth]);

  // Liveness probe. A false -> true transition means the API restarted, so the
  // cached health (model list, backends) has to be reloaded without a page refresh.
  useEffect(() => {
    let alive = true;

    const probe = async () => {
      const ping = await pingServer();
      if (!alive) return;

      const online = Boolean(ping?.ok);
      const wasOnline = serverOnlineRef.current;
      serverOnlineRef.current = online;
      setServerOnline(online);

      if (online && wasOnline === false) {
        void refreshHealth();
      }
    };

    void probe();
    const timer = window.setInterval(probe, 5000);
    const onFocus = () => void probe();
    window.addEventListener("focus", onFocus);

    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshHealth]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const elapsed = runStartedAt ? Math.max(0, Math.floor((now - runStartedAt) / 1000)) : 0;
  const elapsedLabel = running && runStartedAt ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}` : null;

  // beatAge removed
  // beatLabel removed

  // unused

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(timer);
  }, [toast]);

  const pushEntry = (entry: Omit<ChatEntry, "id">) => {
    setEntries((current) => [...current, { ...entry, id: newId() }]);
  };

  /**
   * Single entry point for spec changes so undo/redo sees every edit.
   * Rapid changes (typing in a parameter) coalesce into one history step.
   */
  const applySpec = (
    next: FamilySpec | null,
    options: { record?: boolean; reset?: boolean } = {},
  ) => {
    const { record = true, reset = false } = options;
    const current = specRef.current;

    if (reset) {
      pastRef.current = [];
      futureRef.current = [];
      lastRecordRef.current = 0;
    } else if (record && current && next && current !== next) {
      const now = Date.now();
      if (now - lastRecordRef.current > 400 || pastRef.current.length === 0) {
        pastRef.current.push(current);
        if (pastRef.current.length > 60) pastRef.current.shift();
      }
      lastRecordRef.current = now;
      futureRef.current = [];
    }

    setSpec(next);
    setHistoryVersion((version) => version + 1);
  };

  const undoSpec = () => {
    const previous = pastRef.current.pop();
    const current = specRef.current;
    if (!previous) return;
    if (current) futureRef.current.push(current);
    lastRecordRef.current = 0;
    setSpec(previous);
    setNative(false);
    setHistoryVersion((version) => version + 1);
  };

  const redoSpec = () => {
    const next = futureRef.current.pop();
    const current = specRef.current;
    if (!next) return;
    if (current) pastRef.current.push(current);
    lastRecordRef.current = 0;
    setSpec(next);
    setNative(false);
    setHistoryVersion((version) => version + 1);
  };

  // Real-time synchronization with MCP / External Agents
  const lastExternalHashRef = useRef<string>("");

  useEffect(() => {
    let alive = true;

    const handleExternalSpec = (data: ExternalSpecPayload) => {
      if (!alive || !data || !data.spec || !data.spec_hash) return;
      if (data.spec_hash === lastExternalHashRef.current) return;

      lastExternalHashRef.current = data.spec_hash;
      applySpec(data.spec);
      setNative(false);

      const partsCount = data.geometry_summary?.parts_count ?? (data.spec.parts?.length || 0);
      const paramsCount = data.geometry_summary?.parameters_count ?? (data.spec.parameters?.length || 0);
      const bounds = data.geometry_summary?.bounds;
      const dims = bounds ? ` · ${bounds.x} × ${bounds.y} × ${bounds.z} mm` : "";

      pushEntry({
        role: "agent",
        text: `Đã nhận Family Spec từ MCP: ${data.spec.name || "Family"}.\n${partsCount} chi tiết · ${paramsCount} tham số${dims}`,
        notes: data.spec.notes,
        meta: "⚡ MCP Real-time Sync",
        issues: (data.warnings || []).map((w) => ({ message: w, severity: "warning", path: "spec" })),
      });

      setToast({
        text: `Đã nạp 3D Family từ MCP: ${data.spec.name || "Family"}`,
        sub: `${partsCount} chi tiết · ${paramsCount} tham số. Hiển thị trực tiếp trên 3D Viewport.`,
        tone: "ok",
      });
    };

    // 1. Initial fetch of latest external spec
    void fetchLatestExternalSpec().then((latest) => {
      if (alive && latest && latest.spec && latest.spec_hash) {
        handleExternalSpec(latest);
      }
    });

    // 2. Real-time SSE stream
    const unsubscribe = subscribeExternalSpecStream(handleExternalSpec);

    // 3. Fallback polling every 2.5 seconds in case SSE drops
    const pollInterval = window.setInterval(async () => {
      if (!alive) return;
      const latest = await fetchLatestExternalSpec();
      if (alive && latest && latest.spec && latest.spec_hash) {
        handleExternalSpec(latest);
      }
    }, 2500);

    return () => {
      alive = false;
      unsubscribe();
      window.clearInterval(pollInterval);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (typing || !(event.ctrlKey || event.metaKey)) return;

      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undoSpec();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redoSpec();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // Handlers only touch refs and stable setters.
     
  }, []);

  const handleAttach = async (files: File[]) => {
    setUploading(true);
    try {
      const uploaded: UploadedDocument[] = [];
      for (const file of files) {
        const document = await uploadDocument(file);
        uploaded.push(document);
      }
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      pushEntry({
        role: "agent",
        text: `Could not attach file: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((current) => current.filter((_, idx) => idx !== index));
  };

  // Stable identity: the API panel keeps it in an effect, so a new function on every
  // App re-render (stage messages) would restart its verification loop.
  const handleModel = useCallback((value: string) => {
    setModel(value);
    try {
      window.localStorage.setItem("fa.model", value);
    } catch {
      /* private mode, ignore */
    }
  }, []);

  const handleLod = (value: Lod) => {
    setLod(value);
    try {
      window.localStorage.setItem("fa.lod", String(value));
    } catch {
      /* private mode, ignore */
    }

    if (spec) {
      setToast({
        text: `Đã chọn LOD ${value}`,
        sub: "Yêu cầu chỉnh sửa tiếp theo sẽ dựng lại mô hình ở mức chi tiết này.",
        tone: "ok",
      });
    }
  };

  const handleSend = async (text: string, specOverride?: FamilySpec) => {
    if (running || uploading) return;
    lastPromptRef.current = text;
    const baseSpec = specOverride ?? spec;
    const hadSpec = Boolean(baseSpec);
    const docs = attachments;
    pushEntry({ role: "user", text, attachments: docs.length > 0 ? docs : undefined });
    setRunning(true);
    setRunStartedAt(Date.now());
    setNow(Date.now());
    setStage({
      stage: "thinking",
      message: docs.length > 0 ? "Đang đọc tài liệu đính kèm…" : "Đang đọc yêu cầu…",
    });

    let failed = false;
    let stalled = false;
    let receivedSpec = false;
    let jobId: string | null = null;
    let lastBeat = Date.now();

    const controller = new AbortController();
    abortRef.current = controller;
    setLastBeatAt(Date.now());

    // A restarted server (npm run dev reloads on every file change) leaves the SSE
    // connection open with no data. Abort instead of waiting forever.
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastBeat > 900000 && !controller.signal.aborted) {
        stalled = true;
        controller.abort();
      }
    }, 5000);

    const pushSpecEntry = (
      specValue: FamilySpec,
      stats: DesignStats,
      prefix = "",
      outcome: "ok" | "incomplete" | "has-errors" | "unchanged" | null = null,
      errors: Array<{ message?: string } | string> = [],
    ) => {
      const dims = stats.bounds ? `${stats.bounds.x} × ${stats.bounds.y} × ${stats.bounds.z} mm` : "";
      const fast = stats.fastEdit;
      const fastUnit = fast?.type === "Length" ? " mm" : fast?.type === "Angle" ? "°" : "";
      const fastLine = fast
        ? `\n⚡ Local edit: ${fast.name} → ${fast.value}${fastUnit} · ${1 + (fast.affectedParameters?.length ?? 0)} parameter, ${fast.affectedParts?.length ?? 0} part · 0 token`
        : "";
      const stepLine =
        Array.isArray(stats.steps) && stats.steps.length > 1
          ? `\n${stats.steps
              .map((step: { label: string; ms: number; ok: boolean; error?: string }) =>
                `${step.ok ? "✓" : "⚠"} ${step.label}: ${formatDuration(step.ms)}${step.error ? ` (${step.error})` : ""}`,
              )
              .join(" · ")}`
          : "";

      const tierLine =
        stats.tier != null
          ? ` · tầng ${stats.tier}${stats.tierLabel ? ` (${stats.tierLabel})` : ""}` +
            ` · ${stats.model ?? "không gọi model"} · ${stats.modelCalls ?? 0} lượt` +
            ` · prompt ${((stats.promptChars ?? 0) / 1000).toFixed(1)}k`
          : "";
      const savedLine = stats.savedCalls ? ` · tiết kiệm ${stats.savedCalls} lượt` : "";
      const inChars = (stats.calls ?? []).reduce(
        (total, call) => total + (call.inChars ?? call.promptChars ?? 0),
        0,
      );
      const outChars = (stats.calls ?? []).reduce((total, call) => total + (call.outChars ?? 0), 0);
      const callLine =
        (stats.calls?.length ?? 0) > 0
          ? ` · ${stats.calls!.length} lượt` +
            (inChars ? ` · vào ${(inChars / 1000).toFixed(1)}k` : "") +
            (outChars ? ` / ra ${(outChars / 1000).toFixed(1)}k ký tự` : "")
          : "";
      const isIncomplete = stats.complete === false || outcome === "incomplete";
      setIncomplete(isIncomplete ? (stats.missing ?? ["Không rõ hạng mục thiếu"]) : null);

      const copy = describeOutcome(
        {
          stats,
          analysis: {
            ok: outcome ? outcome !== "has-errors" : undefined,
            spec: specValue,
            errors,
          },
        },
        { updated: hadSpec },
      );
      const bullets = copy.items
        .slice(0, 12)
        .map((item) => `• ${item}`)
        .join("\n");
      const summary =
        `${stats.parts} chi tiết · ${stats.parameters} tham số${stats.lod ? ` · LOD ${stats.lod}` : ""}` +
        `${dims ? ` · ${dims}` : ""}${fastLine}${stepLine}${callLine}`;

      setSessionUsage((current) => {
        const calls =
          stats.calls?.length
            ? stats.calls
            : stats.model
              ? [{ model: stats.model, modelCalls: stats.modelCalls ?? 1 }]
              : [];
        if (calls.length === 0) return current;

        const next = { ...current };
        for (const call of calls) {
          if (!call.model) continue;
          next[call.model] = (next[call.model] ?? 0) + (call.modelCalls ?? 1);
        }
        return next;
      });

      pushEntry({
        role: "agent",
        tone: copy.tone === "normal" ? "normal" : "error",
        text:
          `${copy.title}${bullets ? `\n${bullets}` : ""}\n` +
          `${prefix}${summary}`,
        warnings: (stats.warnings as string[] | undefined) ?? undefined,
        notes: specValue.notes ?? [],
        // Errors are the clickable issue list (jump to the offending part).
        issues: copy.outcome === "has-errors" ? (errors as never[]) : undefined,
        action:
          copy.outcome === "unchanged"
            ? { label: "Gửi lại" }
            : undefined,
        resolution: Array.isArray(stats.resolution)
          ? (stats.resolution as {
              name: string;
              value: unknown;
              level?: number;
              source?: string;
            }[])
          : undefined,
        meta: fast
          ? `⚡ local · ${formatDuration(stats.elapsedMs)}${savedLine}`
          : stats.cached
            ? `⚡ cached · 0 token${savedLine}`
            : `${formatDuration(stats.elapsedMs)}${tierLine}${savedLine}`,
      });
    };

    try {
      await streamDesign(
        {
          prompt: text,
          spec: baseSpec,
          lod,
          model: model || undefined,
          customApiConfig: model === 'custom:api' ? (() => {
            try {
              const raw = localStorage.getItem('custom_api_config');
              if (!raw) return undefined;
              const config = JSON.parse(raw);
              // A display name ("Gemini 3.8 Flash") is not a model id: never send it.
              if (config?.model && !isModelId(config.model)) config.model = '';
              return config;
            } catch { return undefined; }
          })() : undefined,
          commandCodeApiKey: (() => { try { return localStorage.getItem('command_code_api_key') || undefined; } catch { return undefined; } })(),
          attachments: docs.length > 0 ? docs.map((d) => ({ path: d.path, name: d.name })) : undefined,
        },
        (event) => {
          if (event.type === "job") {
            jobId = event.jobId;
            return;
          }

          if (event.type === "suggestion") {
            pushEntry({
              role: "agent",
              text:
                `Có family đã lưu gần giống: ${event.sample.name} (khớp ${Math.round(
                  event.sample.score * 100,
                )}%).\nBắt đầu từ mẫu này sẽ rẻ hơn tạo mới — chỉ cần sửa lại theo yêu cầu.`,
              action: {
                label: "Bắt đầu từ mẫu gần nhất",
                kind: "use-sample",
                sampleId: event.sample.id,
              },
            });
            return;
          }

          if (event.type === "stage") {
            setStage({ stage: event.stage, message: event.message, issues: event.issues });
            return;
          }

          if (event.type === "error") {
            failed = true;
            setStage(null);
            const advice = errorAdvice(event.kind);
            const { text, details } = splitErrorMessage(event.message);
            pushEntry({
              role: "agent",
              tone: "error",
              text: `⛔ ${text}\n${advice.hint}`,
              details: [event.details, details].filter(Boolean).join("\n\n") || undefined,
              action:
                advice.action === "retry"
                  ? { label: "Gửi lại" }
                  : advice.action === "open-api"
                    ? { label: "Mở cấu hình API", kind: "open-api" }
                    : undefined,
            });
            return;
          }

          const { stats } = event;
          applySpec(event.spec);
          setNative(false);

          // A split run sends one spec per step; only the last one is a finished answer.
          if (stats.step?.partial) {
            setStage({
              stage: "step",
              message: `${stats.step.label} xong — đang làm bước ${stats.step.index + 1}/${stats.step.total}`,
            });
            return;
          }

          receivedSpec = true;
          pushSpecEntry(event.spec, stats, "", event.outcome ?? null, event.errors ?? []);
        },
        controller.signal,
        () => {
          lastBeat = Date.now();
          setLastBeatAt(lastBeat);
        },
      );

      if (!receivedSpec && !stalled && jobId && !failed) {
        // The socket died but the server kept working: fetch the stored result.
        setStage({ stage: "recovering", message: "Mất kết nối, đang lấy lại kết quả…" });

        const recovered = await waitForDesignJob(jobId, controller.signal);
        if (recovered === "missing") {
          setStage(null);
          pushEntry({
            role: "agent",
            tone: "error",
            text:
              "⛔ Server đã restart và không còn job này, nên kết quả bị mất.\n" +
              "Gửi lại yêu cầu — nếu prompt rất dài, hãy tách phần connector và bảng màu ra, hoặc chọn model nhanh hơn.",
            action: { label: "Gửi lại" },
          });
        } else if (recovered === "timeout") {
          setStage(null);
          pushEntry({
            role: "agent",
            tone: "error",
            text:
              "⛔ Đã chờ 10 phút nhưng job vẫn chưa xong, nên tạm dừng lấy kết quả.\n" +
              "Bấm Gửi lại (job cũ vẫn có thể xong sau), hoặc tách yêu cầu thành phần khung → connector → vật liệu.",
            action: { label: "Gửi lại" },
          });
        } else if (recovered.spec) {
          receivedSpec = true;
          setStage(null);
          applySpec(recovered.spec);
          setNative(false);
          pushSpecEntry(
            recovered.spec,
            recovered.stats ?? {
              parameters: recovered.spec.parameters?.length ?? 0,
              parts: recovered.spec.parts?.length ?? 0,
              instances: recovered.spec.parts?.length ?? 0,
              materials: recovered.spec.materials?.length ?? 0,
              bounds: null,
              attempts: 0,
              elapsedMs: 0,
            },
            "Đã lấy lại kết quả sau khi mất kết nối.\n",
          );
        } else {
          setStage(null);
          const { text, details } = splitErrorMessage(recovered.error ?? "không rõ nguyên nhân");
          pushEntry({
            role: "agent",
            tone: "error",
            text: `⛔ Job kết thúc với lỗi: ${text}\n${errorAdvice("unknown").hint}`,
            details,
            action: { label: "Gửi lại" },
          });
        }
      } else if (!receivedSpec && !stalled && !failed) {
        failed = true;
        pushEntry({
          role: "agent",
          text: "⛔ Server đóng kết nối mà chưa trả về spec — có thể API vừa restart. Bấm gửi lại yêu cầu.",
          tone: "error",
          action: { label: "Gửi lại" },
        });
      }
    } catch (error) {
      if (stalled) {
        failed = true;
        pushEntry({
          role: "agent",
          text:
            "⛔ Không nhận được phản hồi từ server quá 15 phút nên đã dừng.\n" +
            "Thường là do API vừa restart (`npm run dev` reload khi có file thay đổi) — kiểm tra pill trạng thái rồi gửi lại.",
          tone: "error",
          action: { label: "Gửi lại" },
        });
      } else if (error instanceof Error && error.name === "AbortError") {
        pushEntry({ role: "agent", text: "Đã dừng." });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const { text, details } = splitErrorMessage(message);
        pushEntry({
          role: "agent",
          tone: "error",
          text: `⛔ ${text}\n${errorAdvice(null).hint}`,
          details,
          action: { label: "Gửi lại" },
        });
        // Find out right away whether the API itself is down.
        void pingServer().then((ping) => setServerOnline(Boolean(ping?.ok)));
      }
    } finally {
      window.clearInterval(watchdog);
      abortRef.current = null;
      setRunning(false);
      setRunStartedAt(null);
      setAttachments([]);
      if (!failed) setStage(null);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleToggleHidePart = (partId: string) => {
    setHiddenPartIds((current) =>
      current.includes(partId) ? current.filter((id) => id !== partId) : [...current, partId],
    );
  };

  const handleUnhideAll = () => {
    setHiddenPartIds([]);
  };

  const handleIsolatePart = (partId: string) => {
    const all = analysis?.model.parts.map((part) => part.id) ?? [];
    setHiddenPartIds(all.filter((id) => id !== partId));
    setSelectedPartId(partId);
  };

  const handleFocusPart = (partId: string) => {
    setSelectedPartId(partId);
    setFocusPartId(partId);
  };

  const handleToggleTransparentPart = (partId: string) => {
    setTransparentPartIds((current) =>
      current.includes(partId) ? current.filter((id) => id !== partId) : [...current, partId],
    );
  };

  const handleResetTransparent = () => {
    setTransparentPartIds([]);
  };

  const handleChangeTypes = (types: FamilyTypeEntry[]) => {
    const current = specRef.current;
    if (!current) return;
    applySpec({ ...current, types });
    setNative(false);
  };

  const handlePreviewType = (values: Record<string, number> | null) => {
    setPreviewTypeValues(values ? { ...values } : null);
  };

  const handleExportTypes = async () => {
    const current = specRef.current;
    if (!current || !analysis?.ok) return;
    const types = current.types ?? [];
    if (types.length === 0) return;

    setExportingTypes(true);
    setToast({
      text: `Đang xuất ${types.length} type trong một file RFA…`,
      sub: "Revit dựng family rồi tạo từng Family Type từ danh sách.",
      tone: "ok",
    });

    try {
      const result = await exportMultiType({ ...current, revitVersion });
      setToast({
        text: `Đã xuất ${types.length} type trong một file .rfa`,
        sub: result.path ? `${result.path} · ${result.types ?? types.length} type` : undefined,
        tone: "ok",
      });
    } catch (error) {
      setToast({
        text: "Xuất nhiều type thất bại",
        sub: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setExportingTypes(false);
    }
  };

  const handleUpdateParameter = (name: string, value: number | string) => {
    const current = specRef.current;
    if (!current) return;
    applySpec({
      ...current,
      parameters: current.parameters.map((param) =>
        param.name === name ? { ...param, value, formula: undefined } : param,
      ),
    });
    setNative(false);
  };

  const handleUpdateConnectorHost = (
    connectorId: string,
    host: "solid" | "reference-plane",
  ) => {
    const current = specRef.current;
    if (!current) return;
    applySpec({
      ...current,
      connectors: (current.connectors ?? []).map((connector) =>
        connector.id === connectorId ? { ...connector, host } : connector,
      ),
    });
    setNative(false);
  };

  const handleAddParameter = (draft: { name: string; type: ParameterType; value: number | string }) => {
    const current = specRef.current;
    if (!current) return;

    const taken = new Set(current.parameters.map((param) => paramKey(param.name)));
    let name = draft.name;
    let suffix = 2;
    while (taken.has(paramKey(name))) {
      name = `${draft.name} ${suffix}`;
      suffix += 1;
    }
    const parameter: FamilyParameter = {
      name,
      type: draft.type,
      group: draft.type === "Length" || draft.type === "Angle" ? "Dimensions" : "Data",
      value: draft.value,
    };
    applySpec({ ...current, parameters: [...current.parameters, parameter] });
    setNative(false);
  };

  const handleExportPortable = async () => {
    if (!spec || !analysis?.ok || exportingPortable) return;
    setExportingPortable(true);
    setToast({
      text: "Đang tạo gói 1-Click RFA Portable...",
      sub: "Đang đóng gói file spec, runner và kịch bản tự động dựng Native Family cho Revit...",
      tone: "ok",
    });

    try {
      await downloadPortablePackage({ ...spec, revitVersion });
      setToast({
        text: "Tải gói 1-Click RFA thành công!",
        sub: "Giải nén file zip và click đúp '1-Click-Build.bat' trên máy có Revit để sinh file .rfa.",
        tone: "ok",
      });
    } catch (err: any) {
      setToast({
        text: "Không thể tạo gói Portable",
        sub: err?.message || String(err),
        tone: "error",
      });
    } finally {
      setExportingPortable(false);
    }
  };

  const handleBuild = async () => {
    if (!spec || !analysis?.ok || building) return;
    setBuilding(true);
    setToast({
      text: "Đang build family trong Revit…",
      sub: "Nếu Revit chưa mở, hệ thống sẽ tự khởi động (khoảng 1 phút). File .rfa sẽ tự tải về khi xong.",
      tone: "ok",
    });
    try {
      const result = await buildFamily({ ...spec, revitVersion });
      if (result.ok && result.path) {
        setNative(true);

        const driving = result.stats?.driving ?? [];
        const unlabelled = result.stats?.unlabelled ?? [];
        const inert = result.stats?.inert ?? [];
        const failedParts = result.stats?.failedParts ?? [];
        const missingForms = result.stats?.missingForms ?? 0;
        const qa = result.qa;
        const buildMode = result.stats?.mode;
        const rebuildMode = buildMode === "planes" || buildMode === "rebuild";
        const notes = [
          ...(result.warnings ?? []),
          ...(buildMode === "planes"
            ? ["Revit giữ được dimension theo reference plane nhưng không giữ được ràng buộc mặt: hình cập nhật bằng rebuild."]
            : []),
          ...(buildMode === "rebuild"
            ? ["Family chạy chế độ rebuild: đổi tham số sẽ giải lại spec, dimension chỉ để tham chiếu."]
            : []),
          ...(missingForms > 0
            ? [`Thiếu ${missingForms} part/copy khi build — xem danh sách bên dưới.`]
            : []),
          ...failedParts.slice(0, 5).map((item) => `Part không dựng được: ${item}`),
          ...(qa?.rebuildRequired
            ? ["Build QA: có part cần Rebuild from spec khi đổi tham số (FreeFormElement hoặc ràng buộc chưa compile)."]
            : []),
          ...unlabelled.map((item) => `Chưa dẫn động: ${item}`),
          ...inert.map((name) => `Có nhãn nhưng chưa kéo được hình: ${name}`),
        ].slice(0, 14);

        pushEntry({
          role: "agent",
          text:
            `Đã xuất ${spec.name}.rfa (Revit ${result.revitVersion ?? revitVersion}).\n` +
            `${driving.length} tham số dẫn động · ${result.stats?.locks ?? 0} ràng buộc hình học` +
            `${result.stats?.refPlanes ? ` · ${result.stats.refPlanes} reference plane` : ""}` +
            `${result.stats?.joins ? ` · ${result.stats.joins} join` : ""}` +
            `${result.stats?.totalForms !== undefined ? ` · ${result.stats.totalForms} form` : ""}` +
            `${qa ? ` · QA ${qa.ok ? "pass" : `${qa.warnings.length} cảnh báo`}` : ""}`,
          notes: notes.length > 0 ? notes : undefined,
          meta: result.path,
          tone: (driving.length === 0 && !rebuildMode) || missingForms > 0 ? "error" : undefined,
        });

        setToast({
          text:
            missingForms > 0
              ? `Build xong nhưng thiếu ${missingForms} part/copy`
              : rebuildMode
                ? "Revit family built — rebuild-from-spec"
                : qa?.rebuildRequired
                  ? "Build xong — cần Rebuild from spec khi đổi tham số"
                  : "Revit family built successfully!",
          sub:
            missingForms > 0
              ? "Xem notes hoặc Documents\\FamilyAgent\\logs\\autosync.log để biết part nào lỗi."
              : rebuildMode
                ? "Đổi tham số trong Revit sẽ tự giải lại spec, ra đúng hình như localhost."
                : driving.length === 0
                  ? "Cảnh báo: chưa có tham số nào được gắn nhãn dimension — đổi thông số sẽ không đổi hình."
                  : `${driving.length} tham số dẫn động hình học · ${result.path}`,
          tone:
            missingForms > 0 || (driving.length === 0 && !rebuildMode)
              ? "error"
              : rebuildMode
                ? "ok"
                : qa?.rebuildRequired
                  ? "warn"
                  : "ok",
        });
        // Automatically trigger download of the .rfa file
        const link = document.createElement("a");
        link.href = `/api/download-rfa?path=${encodeURIComponent(result.path)}`;
        link.download = `${spec.name || "Family"}.rfa`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else if (result.mode === "queue") {
        setToast({
          text: "Chưa bật Studio Bridge trong Revit",
          sub: "Vào tab 'Family Agent' trên Revit và bấm nút 'Studio bridge' (hoặc 'Build pending')",
          tone: "warn",
        });
        // Provide direct download of JSON spec
        if (result.file) {
          const link = document.createElement("a");
          link.href = `/api/download-spec?file=${encodeURIComponent(result.file)}`;
          link.download = `${spec.name || "Family"}-spec.json`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }
      } else {
        setToast({ text: result.error ?? "The build failed", tone: "error" });
      }
    } catch (error) {
      setToast({ text: error instanceof Error ? error.message : String(error), tone: "error" });
    } finally {
      setBuilding(false);
    }
  };

  /**
   * The library card preview: a square JPEG of what the viewer is showing.
   * The browser canvas is already WebGL, so drawing it into a 320px canvas is enough.
   */
  const captureThumbnail = (): string | undefined => {
    const canvas = viewerCanvasRef.current;
    if (!canvas || !canvas.width || !canvas.height) return undefined;
    try {
      const size = 320;
      const off = document.createElement("canvas");
      off.width = size;
      off.height = size;
      const context = off.getContext("2d");
      if (!context) return undefined;

      const background =
        getComputedStyle(document.documentElement).getPropertyValue("--viewer-bg-solid").trim() ||
        "#f4f3ef";
      context.fillStyle = background;
      context.fillRect(0, 0, size, size);

      const side = Math.min(canvas.width, canvas.height);
      context.drawImage(
        canvas,
        (canvas.width - side) / 2,
        (canvas.height - side) / 2,
        side,
        side,
        0,
        0,
        size,
        size,
      );
      return off.toDataURL("image/jpeg", 0.82);
    } catch {
      // A tainted canvas or a lost context only means "no thumbnail".
      return undefined;
    }
  };

  const handleSaveModel = async () => {
    if (!spec) return;
    try {
      const res = await saveModel({
        id: currentModelId || undefined,
        name: spec.name,
        spec,
        entries,
        // A new family saved while a group is selected starts in that group. The
        // server ignores this for an overwrite, so an existing model never moves.
        ...(currentModelId ? {} : { group: activeSaveGroup() }),
        thumbnail: captureThumbnail(),
      });
      if (res.ok && res.id) {
        setCurrentModelId(res.id);
        setToast({
          text: "Đã lưu mô hình thành công!",
          sub: `ID: ${res.id}`,
          tone: "ok",
        });
        if (libraryOpen) void refreshLibrary();
      }
    } catch (error) {
      setToast({
        text: `Lưu thất bại: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    }
  };

  const handleSaveModelAs = async () => {
    if (!spec) return;
    const entered = window.prompt("Tên bản mới:", `${spec.name} copy`);
    const name = entered?.trim();
    if (!name) return;

    try {
      // No id: the server stores this as a new saved model and leaves the open one alone.
      const copySpec: FamilySpec = { ...spec, name };
      const res = await saveModel({
        name,
        spec: copySpec,
        entries,
        group: activeSaveGroup(),
        thumbnail: captureThumbnail(),
      });
      if (res.ok && res.id) {
        applySpec(copySpec);
        setCurrentModelId(res.id);
        setToast({
          text: "Đã lưu thành bản mới!",
          sub: `Tên: ${name}`,
          tone: "ok",
        });
        if (libraryOpen) void refreshLibrary();
      }
    } catch (error) {
      setToast({
        text: `Lưu thất bại: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    }
  };

  /** Group to pre-assign a brand-new family to; "Tất cả" means no group. */
  const activeSaveGroup = () =>
    libraryGroup === ALL_GROUPS ? UNGROUPED : libraryGroup;

  const refreshLibrary = async () => {
    setLibraryLoading(true);
    const [models, snapshot] = await Promise.all([fetchSavedModels(), fetchLibraryGroups()]);
    setSavedList(models);
    setLibraryGroups(snapshot.groups);
    // A group removed elsewhere must not leave the panel on an empty selection.
    setLibraryGroup((current) => {
      if (current === ALL_GROUPS || current === UNGROUPED) return current;
      return snapshot.groups.some((group) => group.name === current) ? current : ALL_GROUPS;
    });
    setLibraryLoading(false);
  };

  const handleOpenLibrary = async () => {
    setLibraryOpen(true);
    setHistoryModelId(null);
    await refreshLibrary();
  };

  const handleCreateGroup = async (name: string) => {
    try {
      const result = await createLibraryGroup(name);
      setLibraryGroups(result.groups ?? []);
      setLibraryGroup(result.name);
      setToast({ text: `Đã tạo nhóm "${result.name}"`, tone: "ok" });
    } catch (error) {
      setToast({
        text: `Không tạo được nhóm: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    }
  };

  const handleRenameGroup = async (from: string, to: string) => {
    try {
      await renameLibraryGroup(from, to);
      if (libraryGroup === from) setLibraryGroup(to);
      await refreshLibrary();
      setToast({ text: `Đã đổi tên nhóm thành "${to}"`, tone: "ok" });
    } catch (error) {
      setToast({
        text: `Không đổi được tên nhóm: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    }
  };

  const handleDeleteGroup = async (name: string) => {
    try {
      await deleteLibraryGroup(name);
      if (libraryGroup === name) setLibraryGroup(ALL_GROUPS);
      await refreshLibrary();
      setToast({
        text: `Đã xoá nhóm "${name}"`,
        sub: "Các family trong nhóm đã chuyển về Chưa nhóm.",
        tone: "ok",
      });
    } catch (error) {
      setToast({
        text: `Không xoá được nhóm: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    }
  };

  const handleMoveModel = async (id: string, group: string) => {
    try {
      await moveModelToGroup(id, group);
      setSavedList((current) =>
        current.map((item) => (item.id === id ? { ...item, group } : item)),
      );
      const snapshot = await fetchLibraryGroups();
      setLibraryGroups(snapshot.groups);
      setToast({
        text: group ? `Đã chuyển vào nhóm "${group}"` : "Đã chuyển về Chưa nhóm",
        tone: "ok",
      });
    } catch (error) {
      setToast({
        text: `Không chuyển được nhóm: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    }
  };

  const handleOpenHistory = async (id: string) => {
    setHistoryModelId(id);
    setRevisionsLoading(true);
    setRevisions(await fetchModelHistory(id));
    setRevisionsLoading(false);
  };

  const handleRestoreRevision = async (stamp: string) => {
    if (!historyModelId) return;
    const revision = await fetchModelRevision(historyModelId, stamp);
    if (!revision?.spec) {
      setToast({ text: "Không đọc được bản lưu này", tone: "error" });
      return;
    }
    applySpec(revision.spec, { reset: true });
    setCurrentModelId(historyModelId);
    setHistoryModelId(null);
    setLibraryOpen(false);
    setToast({
      text: "Đã khôi phục bản lưu",
      sub: new Date(revision.savedAt).toLocaleString(),
      tone: "ok",
    });
  };

  const handleLoadModel = async (id: string) => {
    try {
      const detail = await fetchSavedModelDetail(id);
      if (detail && detail.spec) {
        applySpec(detail.spec, { reset: true });
        setCurrentModelId(detail.id);
        if (detail.spec.lod) handleLod(detail.spec.lod);
        if (Array.isArray(detail.entries) && detail.entries.length > 0) {
          setEntries(detail.entries);
        } else {
          setEntries([
            {
              id: newId(),
              role: "agent",
              text: `Đã nạp lại mô hình đã lưu: ${detail.spec.name}.\nBạn có thể tiếp tục trò chuyện để yêu cầu chỉnh sửa hoặc thay đổi thông số.`,
            },
          ]);
        }
        setLibraryOpen(false);
        setToast({
          text: `Đã mở mô hình: ${detail.name}`,
          tone: "ok",
        });
      }
    } catch (error) {
      setToast({
        text: `Không thể mở mô hình: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    }
  };

  const handleRenameModel = async (id: string, name: string) => {
    const item = savedList.find((entry) => entry.id === id);
    if (!item || !name.trim()) return;

    try {
      const result = await renameModel(id, name.trim());
      const renamed = result.name ?? name.trim();

      setSavedList((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, name: renamed } : entry)),
      );

      if (currentModelId === id) {
        // Only the name changes: unsaved edits in the open spec are kept.
        setSpec((current) => {
          if (!current) return current;
          const next: FamilySpec = { ...current, name: renamed };
          if (current.typeName && current.typeName.trim() === item.name.trim()) {
            next.typeName = renamed;
          }
          return next;
        });
      }

      setToast({ text: "Đã đổi tên mô hình", tone: "ok" });
    } catch (error) {
      setToast({
        text: `Đổi tên thất bại: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    }
  };

  const handleDeleteModel = async (id: string) => {
    if (!window.confirm("Bạn có chắc chắn muốn xoá mô hình này khỏi thư viện?")) return;
    try {
      await deleteSavedModel(id);
      setSavedList((curr) => curr.filter((item) => item.id !== id));
      setLibraryGroups((current) =>
        current.map((group) => ({
          ...group,
          count: Math.max(0, group.count - (savedList.find((item) => item.id === id)?.group === group.name ? 1 : 0)),
        })),
      );
      if (currentModelId === id) {
        setCurrentModelId(null);
      }
      setToast({
        text: "Đã xoá mô hình",
        tone: "ok",
      });
    } catch (error) {
      setToast({
        text: `Xoá thất bại: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    }
  };

  const handleNewModel = () => {
    if (spec && !window.confirm("Bắt đầu mô hình mới? Hãy chắc chắn bạn đã bấm Save nếu muốn lưu mô hình hiện tại.")) {
      return;
    }
    applySpec(null, { reset: true });
    setCurrentModelId(null);
    setEntries([
      {
        id: "seed",
        role: "agent",
        text: "Xin chào! Hãy mô tả thiết bị bạn cần dựng hoặc kéo thả tài liệu/bản vẽ (PDF, ảnh) vào đây để tôi bắt đầu thiết kế từ đầu.",
      },
    ]);
  };

  const handleLoadDemo = (key: "fcu" | "pump" | "elbow" | "ystrainer" | "ystrainer-tube") => {
    let demoRaw: any = null;
    let userPromptText = "";
    if (key === "fcu") {
      demoRaw = fcuExampleRaw;
      userPromptText = "Dựng FCU âm trần nối ống gió Daikin FXDQ-SPV1 (Demo Preset)";
    } else if (key === "pump") {
      demoRaw = pumpExampleRaw;
      userPromptText = "Dựng bơm ly tâm trục ngang Grundfos NB 50-200 (Demo Preset)";
    } else if (key === "ystrainer") {
      demoRaw = ystrainerExampleRaw;
      userPromptText = "Dựng Y lọc DN80 PN16 bích 8 bulong, nhánh 45 độ, nắp bulong (Demo Preset)";
    } else if (key === "ystrainer-tube") {
      demoRaw = ystrainerTubeExampleRaw;
      userPromptText = "Dựng Y lọc DN80 nhánh tube 45°, bích và nắp vuông góc trục nhánh (Demo Preset)";
    } else if (key === "elbow") {
      userPromptText = "Dựng cút gió 90 độ nối ren DN50 (Demo Preset)";
      demoRaw = {
        schemaVersion: "1.0",
        name: "Threaded 90 Deg Duct Elbow DN50",
        typeName: "Elbow 90 DN50",
        category: "Duct Elbow",
        units: "mm",
        description: "90 degree threaded elbow DN50 with end bands and connectors",
        parameters: [
          { name: "Nominal Diameter", type: "Length", group: "Dimensions", value: 50 },
          { name: "Center Radius", type: "Length", group: "Dimensions", value: 57 },
          { name: "Body OD", type: "Length", group: "Dimensions", value: 68 },
          { name: "Band OD", type: "Length", group: "Dimensions", value: 76.5 },
          { name: "Band Length", type: "Length", group: "Dimensions", value: 12 },
          { name: "Takeoff Length", type: "Length", group: "Dimensions", value: 69 },
        ],
        materials: [
          { name: "Cast Iron", color: "#61676c", roughness: 0.65, metalness: 0.4 },
          { name: "Galvanized Trim", color: "#9aa1a6", roughness: 0.45, metalness: 0.5 },
        ],
        parts: [
          {
            id: "elbow-body",
            name: "Elbow Center Body",
            material: "Cast Iron",
            solid: {
              kind: "cylinder",
              axis: "z",
              base: { x: 0, y: 0, z: -34 },
              radius: "[Body OD] / 2",
              height: 68,
            },
          },
          {
            id: "flange-port-1",
            name: "End Band Port 1 (+X)",
            material: "Galvanized Trim",
            solid: {
              kind: "cylinder",
              axis: "x",
              base: { x: "[Center Radius]", y: 0, z: 0 },
              radius: "[Band OD] / 2",
              height: 12,
            },
          },
          {
            id: "flange-port-2",
            name: "End Band Port 2 (-Y)",
            material: "Galvanized Trim",
            solid: {
              kind: "cylinder",
              axis: "y",
              base: { x: 0, y: "-[Center Radius]", z: 0 },
              radius: "[Band OD] / 2",
              height: -12,
            },
          },
        ],
        connectors: [
          {
            id: "conn-1",
            name: "Connector 1",
            systemType: "SupplyAir",
            shape: "round",
            direction: "out",
            origin: { x: 69, y: 0, z: 0 },
            directionVector: { x: 1, y: 0, z: 0 },
            diameter: 50,
          },
          {
            id: "conn-2",
            name: "Connector 2",
            systemType: "SupplyAir",
            shape: "round",
            direction: "in",
            origin: { x: 0, y: -69, z: 0 },
            directionVector: { x: 0, y: -1, z: 0 },
            diameter: 50,
          },
        ],
      };
    }

    if (!demoRaw) return;
    const parsed = validateSpec(demoRaw).spec;

    // Reset viewport and start simulated Agent run
    applySpec(null, { reset: true });
    setSelectedPartId(null);
    setHiddenPartIds([]);
    setTransparentPartIds([]);
    setCurrentModelId(null);
    setRunning(true);
    const startSimTime = Date.now();
    setRunStartedAt(startSimTime);
    setNow(startSimTime);

    pushEntry({
      role: "user",
      text: userPromptText,
    });

    // Step 1: Reading (t=0)
    setStage({ stage: "reading", message: "Đang đọc bản vẽ và tài liệu kỹ thuật..." });

    // Step 2: Thinking / Analyzing (t=700ms)
    setTimeout(() => {
      setStage({ stage: "thinking", message: "Phân tích đầu nối MEP, kích thước & mặt phẳng làm việc..." });
    }, 700);

    // Step 3: Progressive Generation directly in real time (Agent dựng từng part như xây nhà)
    const allParts = parsed.parts || [];
    const baseDelay = 1500;
    const partStep = 450; // mỗi part cách nhau 450ms

    // Bắt đầu dựng part đầu tiên
    setTimeout(() => {
      setStage({
        stage: "generating",
        message: `Đang dựng: ${allParts[0]?.name || "Khung chính"} (1/${allParts.length})`,
      });
      applySpec({
        ...parsed,
        parts: allParts.slice(0, 1),
        connectors: [],
      }, { record: false });
    }, baseDelay);

    // Các part tiếp theo mọc dần lên
    for (let i = 2; i <= allParts.length; i++) {
      setTimeout(() => {
        setStage({
          stage: "generating",
          message: `Đang dựng: ${allParts[i - 1]?.name || `Part ${i}`} (${i}/${allParts.length})`,
        });
        applySpec({
          ...parsed,
          parts: allParts.slice(0, i),
          connectors: i === allParts.length ? parsed.connectors : [],
        }, { record: false });
      }, baseDelay + (i - 1) * partStep);
    }

    const totalBuildTime = baseDelay + allParts.length * partStep;

    // Step 4: Checking & validation
    setTimeout(() => {
      setStage({ stage: "checking", message: "Kiểm tra ràng buộc công thức & MEP connector..." });
    }, totalBuildTime + 200);

    // Step 5: Finish
    setTimeout(() => {
      setRunning(false);
      setRunStartedAt(null);
      setStage(null);
      applySpec(parsed, { record: false });

      const partCount = parsed.parts?.length ?? 0;
      const paramCount = parsed.parameters?.length ?? 0;
      pushEntry({
        role: "agent",
        text: `⚡ [Giả lập Agent - 0 token] Đã hoàn thành thiết kế ${parsed.name}.\n${partCount} parts · ${paramCount} parameters`,
        notes: Array.isArray(parsed.notes)
          ? parsed.notes
          : [parsed.notes || "Chạy giả lập kiểm thử giao diện & hiệu ứng dựng tuần tự từng part thời gian thực thành công."],
        meta: `${((totalBuildTime + 600) / 1000).toFixed(1)}s · Simulated pass`,
      });

      setToast({
        text: `Đã hoàn thành dựng mô hình: ${parsed.name}`,
        tone: "ok",
      });
    }, totalBuildTime + 600);
  };

  return (
    <div className="app">
      <TopBar
        name={spec?.name ?? t.noFamily}
        category={spec?.category ?? t.noFamilyHint}
        hasSpec={Boolean(spec)}
        reviewed={Boolean(analysis?.ok)}
        native={native}
        running={running}
        agentStage={stage?.stage ?? null}
        elapsed={elapsedLabel}
                units={units}
        onUnits={setUnits}
        revitVersion={revitVersion}
        onRevitVersion={setRevitVersion}
        lod={lod}
        onLod={handleLod}
        onBuild={handleBuild}
        onExportPortable={handleExportPortable}
        exportingPortable={exportingPortable}
        canBuild={Boolean(analysis?.ok)}
        building={building}
        onSaveModel={handleSaveModel}
        onSaveModelAs={handleSaveModelAs}
        onUndo={undoSpec}
        onRedo={redoSpec}
        canUndo={canUndo}
        canRedo={canRedo}
        onOpenLibrary={handleOpenLibrary}
        onNewModel={handleNewModel}
        onLoadDemo={handleLoadDemo}
        theme={themeMode}
        onTheme={setThemeMode}
      />

      <nav className="mobile-tabs" role="tablist" aria-label="Khu vực làm việc">
        {(
          [
            ["chat", t.chatTab],
            ["viewer", t.viewerTab],
            ["params", t.paramsTab],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={mobileTab === key}
            className={mobileTab === key ? "active" : ""}
            onClick={() => setMobileTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div
        className={`workspace ${paramsOpen ? "params-open" : ""}`}
        data-tab={mobileTab}
        style={
          {
            "--left-width": `${leftWidth}px`,
            "--right-width": `${rightWidth}px`,
          } as CSSProperties
        }
      >
        <ChatPanel
          entries={entries}
          running={running}
          stageMessage={stage ? `${stage.message}${elapsedLabel ? ` · ${elapsedLabel}` : ""}` : null}
          stageIssues={stage?.issues}
          onSend={handleSend}
          onStop={handleStop}
          disabled={running || uploading}
          agentReady={health ? health.agent.ready : null}
          agentLabel={
            health
              ? health.agent.provider === "commandcode"
                ? "cmdc"
                : health.agent.model
              : null
          }
          agentDetail={health?.agent.detail ?? null}
          provider={health?.agent.provider ?? null}
          model={model}
          onModel={handleModel}
          availableModels={health?.models}
          backends={health?.backends}
          onFocusPart={handleFocusPart}
          attachments={attachments}
          uploading={uploading}
          onAttach={handleAttach}
          onRemoveAttachment={handleRemoveAttachment}
          onRetry={() => {
            if (lastPromptRef.current) void handleSend(lastPromptRef.current);
          }}
          onAction={(action) => {
            if (action.kind === "use-sample" && action.sampleId) {
              void (async () => {
                const loaded = await fetchSavedModelDetail(action.sampleId!);
                const sampleSpec = (loaded?.spec ?? null) as FamilySpec | null;
                if (!sampleSpec) return;
                applySpec(sampleSpec);
                void handleSend(lastPromptRef.current, sampleSpec);
              })();
              return;
            }
            if (lastPromptRef.current) void handleSend(lastPromptRef.current);
          }}
          sessionUsage={sessionUsage}
          incomplete={incomplete}
          serverOnline={serverOnline}
        />

        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the agent panel"
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={(event) => beginResize("left", event)}
          onDoubleClick={() => setLeftWidth(DEFAULT_LEFT_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            nudgeWidth("left", event.key);
          }}
        />

        <Viewer
          model={previewModel ?? deferredModel}
          onCanvasReady={(canvas) => {
            viewerCanvasRef.current = canvas;
          }}
          onLoadSample={() => {
            if (running) return;
            void handleSend("Thang cáp ngã ba 400×100, 6 bậc, LOD 400");
          }}
          parameters={deferredParameters}
          materials={spec?.materials ?? []}
          units={units}
          showGrid={showGrid}
          onToggleGrid={() => setShowGrid((current) => !current)}
          showPlanes={showPlanes}
          onTogglePlanes={() => setShowPlanes((current) => !current)}
          showConnectors={showConnectors}
          onToggleConnectors={() => setShowConnectors((current) => !current)}
          showHandles={showHandles}
          onToggleHandles={() => setShowHandles((current) => !current)}
          selectedPartId={selectedPartId}
          onSelectPart={setSelectedPartId}
          hiddenPartIds={hiddenPartIds}
          onToggleHidePart={handleToggleHidePart}
          onUnhideAll={handleUnhideAll}
          transparentPartIds={transparentPartIds}
          onToggleTransparentPart={handleToggleTransparentPart}
          onResetTransparent={handleResetTransparent}
          issuePartIds={issuePartIds}
          highlightPartIds={highlightPartIds}
          focusPartId={focusPartId}
          onUpdateParameter={handleUpdateParameter}
        />

        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the parameter panel"
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={(event) => beginResize("right", event)}
          onDoubleClick={() => setRightWidth(DEFAULT_RIGHT_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            nudgeWidth("right", event.key);
          }}
        />

        {spec && analysis ? (
          <ParameterPanel
            spec={spec}
            analysis={analysis}
            units={units}
            selectedPartId={selectedPartId}
            onSelectPart={setSelectedPartId}
            hiddenPartIds={hiddenPartIds}
            onToggleHidePart={handleToggleHidePart}
            transparentPartIds={transparentPartIds}
            onToggleTransparentPart={handleToggleTransparentPart}
            onIsolatePart={handleIsolatePart}
            issuePartIds={issuePartIds}
            onUpdateParameter={handleUpdateParameter}
            onAddParameter={handleAddParameter}
            onHighlightParts={setHighlightPartIds}
            onUpdateConnectorHost={handleUpdateConnectorHost}
            types={spec.types ?? []}
            onChangeTypes={handleChangeTypes}
            onPreviewType={handlePreviewType}
            onExportTypes={handleExportTypes}
            exportingTypes={exportingTypes}
            previewTypeActive={Boolean(previewTypeValues)}
          />
        ) : (
          <section className="pane right">
            <div className="pane-header">{t.paramsTab}</div>
            <div className="pane-empty">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M4 7h16M4 12h10M4 17h6" />
              </svg>
              <p>{t.parametersEmpty}</p>
            </div>
          </section>
        )}

        <button
          type="button"
          className="params-fab"
          onClick={() => setParamsOpen((current) => !current)}
          aria-expanded={paramsOpen}
          aria-label={paramsOpen ? t.closeParams : t.openParams}
          title={paramsOpen ? t.closeParams : t.openParams}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 7h16M4 12h10M4 17h6" />
          </svg>
          <span>{t.paramsTab}</span>
        </button>
      </div>

      {toast && (
        <div className={`toast ${toast.tone === "error" ? "error" : ""}`} role="status">
          {toast.text}
          {toast.sub && <span className="sub">{toast.sub}</span>}
        </div>
      )}

      {libraryOpen && (
        <LibraryPanel
          models={savedList}
          groups={libraryGroups}
          loading={libraryLoading}
          currentModelId={currentModelId}
          activeGroup={libraryGroup}
          historyModelId={historyModelId}
          revisions={revisions}
          revisionsLoading={revisionsLoading}
          onClose={() => {
            setLibraryOpen(false);
            setHistoryModelId(null);
          }}
          onActiveGroup={setLibraryGroup}
          onLoadModel={(id) => void handleLoadModel(id)}
          onNewModel={handleNewModel}
          onOpenHistory={(id) => void handleOpenHistory(id)}
          onCloseHistory={() => setHistoryModelId(null)}
          onRestoreRevision={(stamp) => void handleRestoreRevision(stamp)}
          onRenameModel={(id, name) => void handleRenameModel(id, name)}
          onDeleteModel={(id) => void handleDeleteModel(id)}
          onCreateGroup={(name) => void handleCreateGroup(name)}
          onRenameGroup={(from, to) => void handleRenameGroup(from, to)}
          onDeleteGroup={(name) => void handleDeleteGroup(name)}
          onMoveModel={(id, group) => void handleMoveModel(id, group)}
        />
      )}
    </div>
  );
}

