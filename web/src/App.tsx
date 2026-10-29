import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  analyzeSpec,
  paramKey,
  validateSpec,
  type FamilyParameter,
  type FamilySpec,
  type Issue,
  type ParameterType,
} from "@family/spec-core";
import fcuExampleRaw from "../../spec/examples/fcu-080.json";
import pumpExampleRaw from "../../spec/examples/pump-dn80.json";
import { ChatPanel, type ChatEntry } from "./components/ChatPanel";
import { ParameterPanel } from "./components/ParameterPanel";
import { TopBar } from "./components/TopBar";
import { Viewer } from "./components/Viewer";
import {
  buildFamily,
  fetchHealth,
  pingServer,
  streamDesign,
  uploadDocument,
  fetchSavedModels,
  fetchSavedModelDetail,
  saveModel,
  deleteSavedModel,
  type Health,
  type Lod,
  type UploadedDocument,
  type SavedModelMeta,
} from "./lib/api";
import { formatDuration, type Units } from "./lib/format";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
  const [native, setNative] = useState(false);
  const [units, setUnits] = useState<Units>("mm");
  const [revitVersion, setRevitVersion] = useState("2024");
  const [lod, setLod] = useState<Lod>(readStoredLod);
  const [model, setModel] = useState("");
  const [attachments, setAttachments] = useState<UploadedDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showPlanes, setShowPlanes] = useState(false);
  const [showConnectors, setShowConnectors] = useState(false);
  const [showHandles, setShowHandles] = useState(false);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [hiddenPartIds, setHiddenPartIds] = useState<string[]>([]);
  const [transparentPartIds, setTransparentPartIds] = useState<string[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [_serverOnline, setServerOnline] = useState<boolean | null>(null); void _serverOnline;
  const [_agentReady, setAgentReady] = useState<boolean | null>(null); void _agentReady;
  const [lastBeatAt, setLastBeatAt] = useState<number | null>(null); void lastBeatAt;
  const [toast, setToast] = useState<ToastState | null>(null);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [savedList, setSavedList] = useState<SavedModelMeta[]>([]);
  const abortRef = useRef<AbortController | null>(null);
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

  // Typing in a parameter field re-solves the geometry; defer it so the input stays smooth.
  const deferredModel = useDeferredValue(analysis?.model ?? null);
  const deferredParameters = useDeferredValue(spec?.parameters);

  useEffect(() => {
    let alive = true;

    // Heavy endpoint: only once, for the model list.
    void fetchHealth().then((result) => {
      if (!alive || !result) return;
      setHealth(result);
      if (result.agent?.model && result.agent.model.startsWith("agy:")) {
        setModel(result.agent.model);
      } else if (result.models && result.models.length > 0) {
        const firstAgy = result.models.find((m) => m.id.startsWith("agy:"));
        if (firstAgy) setModel((curr) => curr || firstAgy.id);
      }
    });

    const probe = async () => {
      const ping = await pingServer();
      if (!alive) return;
      setServerOnline(Boolean(ping?.ok));
      if (ping) setAgentReady(Boolean(ping.agent?.ready));
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
  }, []);

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

  const handleSend = async (text: string) => {
    if (running || uploading) return;
    const hadSpec = Boolean(spec);
    const docs = attachments;
    const names = docs.map((d) => d.name).join(", ");
    pushEntry({ role: "user", text: docs.length > 0 ? `${text}\n(${names})` : text });
    setRunning(true);
    setRunStartedAt(Date.now());
    setNow(Date.now());
    setStage({ stage: "thinking", message: docs.length > 0 ? "Reading attached documents" : "Reading the brief" });

    let failed = false;
    let stalled = false;
    let receivedSpec = false;
    let lastBeat = Date.now();

    const controller = new AbortController();
    abortRef.current = controller;
    setLastBeatAt(Date.now());

    // A restarted server (npm run dev reloads on every file change) leaves the SSE
    // connection open with no data. Abort instead of waiting forever. Keep this above
    // the server's AGENT_TIMEOUT (10 min by default) so a slow model is not cut off.
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastBeat > 900000 && !controller.signal.aborted) {
        stalled = true;
        controller.abort();
      }
    }, 5000);

    try {
      await streamDesign(
        {
          prompt: text,
          spec,
          lod,
          model: model || undefined,
          customApiConfig: model === 'custom:api' ? (() => { try { const raw = localStorage.getItem('custom_api_config'); return raw ? JSON.parse(raw) : undefined; } catch { return undefined; } })() : undefined,
          attachments: docs.length > 0 ? docs.map((d) => ({ path: d.path, name: d.name })) : undefined,
        },
        (event) => {
          if (event.type === "stage") {
            setStage({ stage: event.stage, message: event.message, issues: event.issues });
            return;
          }

          if (event.type === "error") {
            failed = true;
            setStage(null);
            pushEntry({ role: "agent", text: event.message, tone: "error" });
            return;
          }

          const { stats } = event;
          receivedSpec = true;
          setSpec(event.spec);
          setNative(false);
          const dims = stats.bounds ? `${stats.bounds.x} × ${stats.bounds.y} × ${stats.bounds.z} mm` : "";

          pushEntry({
            role: "agent",
            text: `${hadSpec ? "Đã cập nhật" : "Đã tạo"} ${event.spec.name}.\n${stats.parts} chi tiết · ${stats.parameters} tham số${stats.lod ? ` · LOD ${stats.lod}` : ""}${dims ? ` · ${dims}` : ""}`,
            notes: event.spec.notes,
            meta: `${formatDuration(stats.elapsedMs)}${stats.attempts > 1 ? ` · ${stats.attempts} lượt` : ""}${stats.usage?.total_tokens ? ` · ${Math.round(stats.usage.total_tokens / 1000)}k tokens` : ""}`,
            issues: [...event.errors, ...event.issues.filter((issue) => issue.severity === "warning")].slice(0, 12),
          });
        },
        controller.signal,
        () => {
          lastBeat = Date.now();
          setLastBeatAt(lastBeat);
        },
      );

      if (!receivedSpec && !stalled) {
        failed = true;
        pushEntry({
          role: "agent",
          text: "Server đóng kết nối mà chưa trả về spec — có thể API vừa restart. Bấm gửi lại yêu cầu.",
          tone: "error",
        });
      }
    } catch (error) {
      if (stalled) {
        failed = true;
        pushEntry({
          role: "agent",
          text:
            "Không nhận được phản hồi từ server quá 15 phút nên đã dừng.\n" +
            "Thường là do API vừa restart (`npm run dev` reload khi có file thay đổi) — kiểm tra pill trạng thái rồi gửi lại.",
          tone: "error",
        });
      } else if (error instanceof Error && error.name === "AbortError") {
        pushEntry({ role: "agent", text: "Stopped." });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        pushEntry({ role: "agent", text: message, tone: "error" });
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

  const handleToggleTransparentPart = (partId: string) => {
    setTransparentPartIds((current) =>
      current.includes(partId) ? current.filter((id) => id !== partId) : [...current, partId],
    );
  };

  const handleResetTransparent = () => {
    setTransparentPartIds([]);
  };

  const handleUpdateParameter = (name: string, value: number | string) => {
    setSpec((current) => {
      if (!current) return current;
      return {
        ...current,
        parameters: current.parameters.map((param) =>
          param.name === name ? { ...param, value, formula: undefined } : param,
        ),
      };
    });
    setNative(false);
  };

  const handleAddParameter = (draft: { name: string; type: ParameterType; value: number | string }) => {
    setSpec((current) => {
      if (!current) return current;
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
      return { ...current, parameters: [...current.parameters, parameter] };
    });
    setNative(false);
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
        const notes = [
          ...(result.warnings ?? []),
          ...unlabelled.map((item) => `Chưa dẫn động: ${item}`),
          ...inert.map((name) => `Có nhãn nhưng chưa kéo được hình: ${name}`),
        ].slice(0, 8);

        pushEntry({
          role: "agent",
          text:
            `Đã xuất ${spec.name}.rfa (Revit ${result.revitVersion ?? revitVersion}).\n` +
            `${driving.length} tham số dẫn động · ${result.stats?.locks ?? 0} ràng buộc hình học` +
            `${result.stats?.refPlanes ? ` · ${result.stats.refPlanes} reference plane` : ""}`,
          notes: notes.length > 0 ? notes : undefined,
          meta: result.path,
          tone: driving.length === 0 ? "error" : undefined,
        });

        setToast({
          text: "Revit family built successfully!",
          sub: driving.length === 0
            ? "Cảnh báo: chưa có tham số nào được gắn nhãn dimension — đổi thông số sẽ không đổi hình."
            : `${driving.length} tham số dẫn động hình học · ${result.path}`,
          tone: driving.length === 0 ? "warn" : "ok",
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

  const handleSaveModel = async () => {
    if (!spec) return;
    try {
      const res = await saveModel({
        id: currentModelId || undefined,
        name: spec.name,
        spec,
        entries,
      });
      if (res.ok && res.id) {
        setCurrentModelId(res.id);
        setToast({
          text: "Đã lưu mô hình thành công!",
          sub: `ID: ${res.id}`,
          tone: "ok",
        });
      }
    } catch (error) {
      setToast({
        text: `Lưu thất bại: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    }
  };

  const handleOpenLibrary = async () => {
    setLibraryOpen(true);
    const list = await fetchSavedModels();
    setSavedList(list);
  };

  const handleLoadModel = async (id: string) => {
    try {
      const detail = await fetchSavedModelDetail(id);
      if (detail && detail.spec) {
        setSpec(detail.spec);
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

  const handleDeleteModel = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("Bạn có chắc chắn muốn xoá mô hình này khỏi thư viện?")) return;
    try {
      await deleteSavedModel(id);
      setSavedList((curr) => curr.filter((item) => item.id !== id));
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
    setSpec(null);
    setCurrentModelId(null);
    setEntries([
      {
        id: "seed",
        role: "agent",
        text: "Xin chào! Hãy mô tả thiết bị bạn cần dựng hoặc kéo thả tài liệu/bản vẽ (PDF, ảnh) vào đây để tôi bắt đầu thiết kế từ đầu.",
      },
    ]);
  };

  const handleLoadDemo = (key: "fcu" | "pump" | "elbow") => {
    let demoRaw: any = null;
    let userPromptText = "";
    if (key === "fcu") {
      demoRaw = fcuExampleRaw;
      userPromptText = "Dựng FCU âm trần nối ống gió Daikin FXDQ-SPV1 (Demo Preset)";
    } else if (key === "pump") {
      demoRaw = pumpExampleRaw;
      userPromptText = "Dựng bơm ly tâm trục ngang Grundfos NB 50-200 (Demo Preset)";
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
    setSpec(null);
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
      setSpec({
        ...parsed,
        parts: allParts.slice(0, 1),
        connectors: [],
      });
    }, baseDelay);

    // Các part tiếp theo mọc dần lên
    for (let i = 2; i <= allParts.length; i++) {
      setTimeout(() => {
        setStage({
          stage: "generating",
          message: `Đang dựng: ${allParts[i - 1]?.name || `Part ${i}`} (${i}/${allParts.length})`,
        });
        setSpec({
          ...parsed,
          parts: allParts.slice(0, i),
          connectors: i === allParts.length ? parsed.connectors : [],
        });
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
      setSpec(parsed);

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
        name={spec?.name ?? "New family"}
        category={spec?.category ?? "Describe a unit to begin"}
        hasSpec={Boolean(spec)}
        reviewed={Boolean(analysis?.ok)}
        native={native}
        running={running}
        agentStage={stage?.stage ?? null}
                units={units}
        onUnits={setUnits}
        revitVersion={revitVersion}
        onRevitVersion={setRevitVersion}
        lod={lod}
        onLod={handleLod}
        onBuild={handleBuild}
        canBuild={Boolean(analysis?.ok)}
        building={building}
        onSaveModel={handleSaveModel}
        onOpenLibrary={handleOpenLibrary}
        onNewModel={handleNewModel}
        onLoadDemo={handleLoadDemo}
      />

      <div
        className="workspace"
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
          onModel={setModel}
          availableModels={health?.models}
          attachments={attachments}
          uploading={uploading}
          onAttach={handleAttach}
          onRemoveAttachment={handleRemoveAttachment}
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
          model={deferredModel}
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
          onUpdateParameter={handleUpdateParameter}
          status={
            running && stage
              ? { stage: stage.stage, message: stage.message, elapsed: elapsedLabel }
              : null
          }
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
            onUpdateParameter={handleUpdateParameter}
            onAddParameter={handleAddParameter}
          />
        ) : (
          <section className="pane right">
            <div className="pane-header">Parameters</div>
            <div style={{ padding: 16, color: "#8c8e91", lineHeight: 1.6 }}>
              Parameters appear here once a family exists.
            </div>
          </section>
        )}
      </div>

      {toast && (
        <div className={`toast ${toast.tone === "error" ? "error" : ""}`}>
          {toast.text}
          {toast.sub && <span className="sub">{toast.sub}</span>}
        </div>
      )}

      {libraryOpen && (
        <div className="modal-backdrop" onClick={() => setLibraryOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="title-row">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
                <h3>Thư viện mô hình đã lưu ({savedList.length})</h3>
              </div>
              <div className="header-actions">
                <button type="button" className="btn-ghost" onClick={handleNewModel}>
                  + Dựng mô hình mới
                </button>
                <button type="button" className="modal-close" onClick={() => setLibraryOpen(false)}>
                  ×
                </button>
              </div>
            </div>

            <div className="modal-body">
              {savedList.length === 0 ? (
                <div className="empty-library">
                  <p>Chưa có mô hình nào được lưu trong thư viện.</p>
                  <p className="sub">Khi đang xem hoặc chỉnh sửa 1 mô hình trên Web, bấm nút <strong>Save</strong> trên thanh trên cùng để lưu lại.</p>
                </div>
              ) : (
                <div className="saved-model-grid">
                  {savedList.map((item) => (
                    <div
                      key={item.id}
                      className={`saved-model-card ${currentModelId === item.id ? "active" : ""}`}
                      onClick={() => handleLoadModel(item.id)}
                    >
                      <div className="card-top">
                        <span className="model-cat">{item.category}</span>
                        <button
                          type="button"
                          className="btn-delete-model"
                          title="Xoá mô hình này"
                          onClick={(e) => handleDeleteModel(item.id, e)}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                      <h4 className="model-name">{item.name}</h4>
                      <div className="model-meta">
                        <span>{item.partsCount} parts</span>
                        <span>·</span>
                        <span>{item.paramsCount} params</span>
                        <span>·</span>
                        <span>{new Date(item.updatedAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

