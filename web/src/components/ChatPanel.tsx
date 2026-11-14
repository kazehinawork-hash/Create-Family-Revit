import { useEffect, useRef, useState } from "react";
import type { Issue } from "@family/spec-core";
import { isImageDocument, type AgentBackends, type CmdcModel, type UploadedDocument } from "../lib/api";
import { ApiKeyPanel, type ApiKeyStatus } from "./ApiKeyPanel";
import { isApiReady } from "../lib/api-key";
import { t } from "../lib/strings";

export interface ResolutionRow {
  name: string;
  value: unknown;
  level?: number;
  source?: string;
}

/** 1-2 read values (green), 3 measured by scale (amber), 4-5 assumptions (grey). */
function levelClass(level?: number): string {
  if (level === undefined || level === null) return "lvl-assumed";
  if (level <= 2) return "lvl-exact";
  if (level === 3) return "lvl-measured";
  return "lvl-assumed";
}

function downloadResolutionCsv(rows: ResolutionRow[]) {
  const cell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = [
    ["Tham số", "Giá trị", "Mức", "Nguồn"].map(cell).join(","),
    ...rows.map((row) => [row.name, row.value, row.level ?? "", row.source ?? ""].map(cell).join(",")),
  ].join("\n");

  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "thong-so-da-dung.csv";
  link.click();
  URL.revokeObjectURL(url);
}

export interface ChatEntry {
  id: string;
  role: "user" | "agent";
  text: string;
  tone?: "normal" | "error";
  meta?: string;
  issues?: Issue[];
  notes?: string[];
  /** Warnings from the run (separate from the assumptions in `notes`). */
  warnings?: string[];
  /** Parameter values the agent used, with where each one came from. */
  resolution?: ResolutionRow[];
  attachments?: UploadedDocument[];
  action?: {
    label: string;
    kind?: "retry" | "use-sample" | "open-api";
    sampleId?: string;
  };
  /** Raw provider error, kept for the collapsible details block. */
  details?: string;
}


interface Props {
  entries: ChatEntry[];
  running: boolean;
  stageMessage: string | null;
  stageIssues: Issue[] | undefined;
  onSend: (text: string) => void;
  onStop: () => void;
  disabled: boolean;
  agentReady: boolean | null;
  agentLabel: string | null;
  agentDetail: string | null;
  provider: string | null;
  model: string;
  onModel: (model: string) => void;
  availableModels?: CmdcModel[];
  backends?: AgentBackends;
  onFocusPart?: (partId: string) => void;
  attachments: UploadedDocument[];
  uploading: boolean;
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
  onRetry?: () => void;
  onAction?: (action: NonNullable<ChatEntry["action"]>) => void;
  /** Model calls spent in this session, per model. */
  sessionUsage?: Record<string, number>;
  /** Missing requirement items; when set the spec is not ready to build. */
  incomplete?: string[] | null;
  /** Liveness of the local API; false overrides every model-specific status. */
  serverOnline?: boolean | null;
}

const EMPTY_MODELS: CmdcModel[] = [];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SUGGESTIONS = [
  "Bơm ly tâm trục ngang DN80 xả DN65, động cơ 15 kW, bệ đỡ thép hình U",
  "FCU giấu trần nối ống gió 800 CFM, 3 hàng coil, hộp hồi kèm lưới lọc G4",
  "Quạt thông gió gắn tường cánh 350 mm, chớp lật trọng lực, động cơ 1 pha",
];

export function ChatPanel({
  entries,
  running,
  stageMessage,
  stageIssues,
  onSend,
  onStop,
  disabled,
  agentReady,
  agentDetail,
  model,
  onModel,
  availableModels,
  backends,
  onFocusPart,
  attachments,
  uploading,
  onAttach,
  onRemoveAttachment,
  onRetry,
  onAction,
  sessionUsage,
  incomplete,
  serverOnline,
}: Props) {
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<UploadedDocument | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Direct API panel: it owns the key, verification and model selection.
  const [apiPanelOpen, setApiPanelOpen] = useState(false);
  const [apiStatus, setApiStatus] = useState<ApiKeyStatus | null>(null);

  // User-aware auto scroll: only auto-scroll down if user is already near the bottom
  const isNearBottomRef = useRef(true);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    // Considered near bottom if within 80px of the end
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    isNearBottomRef.current = distanceToBottom < 80;
  };

  useEffect(() => {
    const node = scrollRef.current;
    if (node && isNearBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [entries, running, stageMessage]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    setDraft("");
    onSend(text);
    if (inputRef.current) inputRef.current.style.height = "auto";
  };

  const modelList: CmdcModel[] = availableModels ?? EMPTY_MODELS;
  const hasModels = modelList.length > 0;
  const modelValue = hasModels && modelList.some((entry) => entry.id === model)
    ? model
    : (modelList[0]?.id ?? "");

  // The server lists only CLIs that exist on this machine. If the stored selection
  // is gone (other machine, uninstalled CLI), fall back to the first available one.
  useEffect(() => {
    if (!hasModels) return;
    if (modelList.some((entry) => entry.id === model)) return;
    onModel(modelList[0].id);
  }, [hasModels, modelList, model, onModel]);

  // Group models by category
  const groupedModels = modelList.reduce<Record<string, CmdcModel[]>>((acc, item) => {
    const cat = item.category || "Other";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {});

  const isCustomApi = modelValue === "custom:api";

  // Choosing Direct API in the header opens the panel; it can also be opened alone.
  useEffect(() => {
    if (isCustomApi) setApiPanelOpen(true);
  }, [isCustomApi]);

  // Readiness belongs to the backend behind the selected model, not to the default CLI.
  const backendKey = modelValue.startsWith("agy:")
    ? "agy"
    : modelValue.startsWith("codex:")
      ? "codex"
      : modelValue.startsWith("claude:")
        ? "claude"
        : "commandcode";
  const modelBackendReady = backends ? backends[backendKey] : agentReady;

  // Calculate real-time status for the selected model
  let isCurrentModelReady = modelBackendReady === true;
  let statusText = modelBackendReady ? "Sẵn sàng" : "Đang kết nối...";
  let statusTone: "ok" | "warn" | "error" = modelBackendReady ? "ok" : "warn";
  let statusHint = agentDetail || "Agent đang hoạt động sẵn sàng nhận yêu cầu";

  if (serverOnline === false) {
    // The API itself is unreachable: no model can run, whatever is selected.
    isCurrentModelReady = false;
    statusText = "Mất kết nối server";
    statusTone = "error";
    statusHint = "API 127.0.0.1:8787 không phản hồi — đang thử lại…";
  } else if (isCustomApi) {
    // A machine without any CLI can still work through Direct API, so this status
    // comes from the panel instead of the CLI readiness probe.
    if (isApiReady(apiStatus)) {
      isCurrentModelReady = true;
      statusText = "Sẵn sàng";
      statusTone = "ok";
      statusHint =
        `${apiStatus?.provider ?? "Direct API"} · ${apiStatus?.count ?? 0} model` +
        (apiStatus?.revalidating ? " · đang làm mới" : "");
    } else if (!apiStatus || apiStatus.state === "idle") {
      isCurrentModelReady = false;
      statusText = "Chưa có key";
      statusTone = "warn";
      statusHint = "Dán API key trong khung Cấu hình API";
    } else if (apiStatus.state === "checking") {
      isCurrentModelReady = false;
      statusText = "Đang kiểm tra...";
      statusTone = "warn";
      statusHint = "Đang kiểm tra API key và quét model";
    } else if (apiStatus.state === "error") {
      isCurrentModelReady = false;
      statusText = "Không kết nối";
      statusTone = "error";
      statusHint = apiStatus.error || "API Key không hợp lệ";
    } else {
      isCurrentModelReady = true;
      statusText = "Sẵn sàng";
      statusTone = "ok";
      statusHint = `${apiStatus.provider} · ${apiStatus.count} model`;
    }
  } else if (modelBackendReady === false) {
    isCurrentModelReady = false;
    statusText = "Không kết nối";
    statusTone = "error";
    statusHint = `Không tìm thấy CLI cho model "${modelValue || backendKey}" trên máy — chọn model từ CLI đang cài hoặc Direct API`;
  }

  return (
    <section className="pane left">
      <div className="pane-header" style={{ justifyContent: "space-between", alignItems: "center", gap: 6, flexWrap: "nowrap" }}>
        <span style={{ flexShrink: 0 }}>Agent</span>

        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "calc(100% - 60px)", flexWrap: "wrap", justifyContent: "flex-end", rowGap: 6 }}>
          <select
            className="model-select"
            value={modelValue}
            onChange={(event) => onModel(event.target.value)}
            disabled={!hasModels}
            title="Chọn CLI hoặc Direct API"
            aria-label="Agent model"
            style={{ maxWidth: 150, flexShrink: 1, minWidth: 0 }}
          >
            {!hasModels && <option value="">Agent chưa sẵn sàng</option>}
            {Object.entries(groupedModels).map(([group, items]) => (
              <optgroup key={group} label={group}>
                {items.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          {!apiPanelOpen && (
            <button
              type="button"
              className="model-api-button"
              onClick={() => setApiPanelOpen(true)}
              aria-label="Dùng API key trực tiếp"
            >
              Dùng API key
            </button>
          )}

          {incomplete && incomplete.length > 0 && (
            <span
              className="agent-pill incomplete"
              title={incomplete.join("\n")}
              data-testid="incomplete-pill"
            >
              ⚠ Chưa đầy đủ
            </span>
          )}

          <span
            className={`agent-pill ${statusTone} ${statusTone === "ok" ? "agent-pill-pulse" : ""}`}
            title={statusHint}
            style={{ flexShrink: 0, height: 24, padding: "0 8px", fontSize: 11 }}
          >
            <span className="agent-pill-dot" />
            <span className="agent-pill-text">{statusText}</span>
          </span>
        </div>
      </div>

      {sessionUsage && Object.keys(sessionUsage).length > 0 && (
        <div className="session-usage" data-testid="session-usage">
          <span className="session-usage-title">Phiên này</span>
          {Object.entries(sessionUsage)
            .sort((a, b) => b[1] - a[1])
            .map(([modelId, count]) => (
              <span key={modelId} className="session-usage-item" title={`${count} lượt gọi model`}>
                {modelId} ×{count}
              </span>
            ))}
        </div>
      )}

      <ApiKeyPanel
        model={modelValue}
        onModel={onModel}
        open={apiPanelOpen}
        onClose={() => setApiPanelOpen(false)}
        onStatus={setApiStatus}
      />

      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {entries.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon" aria-hidden="true">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M3 7l9-4 9 4-9 4-9-4z" />
                <path d="M3 12l9 4 9-4M3 17l9 4 9-4" />
              </svg>
            </div>
            <h2>{t.chatEmptyTitle}</h2>
            <p>{t.chatEmptyBody}</p>
            <div className="suggestions">
              <span className="suggestions-label">Thử:</span>
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="suggestion"
                  onClick={() => {
                    setDraft(suggestion);
                    inputRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((entry) =>
          entry.role === "user" ? (
            <div key={entry.id} className="msg-user">
              {entry.attachments && entry.attachments.length > 0 && (
                <div className="msg-user-attachments">
                  {entry.attachments.map((doc, index) =>
                    isImageDocument(doc) && doc.url ? (
                      <button
                        key={`${doc.path}-${index}`}
                        type="button"
                        className="msg-user-thumb"
                        onClick={() => setPreview(doc)}
                        title={doc.name}
                        aria-label={`Xem ${doc.name}`}
                      >
                        <img src={doc.url} alt={doc.name} draggable={false} />
                      </button>
                    ) : (
                      <span key={`${doc.path}-${index}`} className="msg-user-file" title={doc.name}>
                        {doc.name}
                      </span>
                    ),
                  )}
                </div>
              )}
              {entry.text}
            </div>
          ) : (
            <div
              key={entry.id}
              className={`msg-agent${
                entry.tone === "error"
                  ? entry.text.startsWith("⛔")
                    ? " msg-error"
                    : " msg-warn"
                  : ""
              }`}
            >
              <div className="role">
                <span className="dot" style={{ width: 5, height: 5, borderRadius: 3, background: "#3c7a63" }} />
                Family agent
              </div>
              <div className="body">{entry.text}</div>
              {entry.details && (
                <details className="msg-details" data-testid="chat-details">
                  <summary>Chi tiết lỗi</summary>
                  <pre>{entry.details}</pre>
                </details>
              )}
              {entry.action && (
                <button
                  type="button"
                  className="msg-action"
                  onClick={() => {
                    if (entry.action?.kind === "open-api") {
                      setApiPanelOpen(true);
                      return;
                    }
                    return onAction ? onAction(entry.action!) : onRetry?.();
                  }}
                  data-testid="chat-retry"
                >
                  {entry.action.label}
                </button>
              )}
              {entry.resolution && entry.resolution.length > 0 && (
                <div className="agent-assumptions">
                  <div className="assumptions-head">
                    <div className="assumptions-title">Thông số đã dùng</div>
                    <button
                      type="button"
                      className="assumptions-csv"
                      onClick={() => downloadResolutionCsv(entry.resolution!)}
                    >
                      Tải CSV
                    </button>
                  </div>
                  <table className="resolution-table" data-testid="resolution-table">
                    <thead>
                      <tr>
                        <th>Tham số</th>
                        <th>Giá trị</th>
                        <th>Nguồn</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.resolution.map((row, index) => (
                        <tr key={`${row.name}-${index}`} className={levelClass(row.level)}>
                          <td>{row.name}</td>
                          <td>{String(row.value ?? "")}</td>
                          <td>{row.source ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {entry.warnings && entry.warnings.length > 0 && (
                <div className="agent-warnings">
                  <div className="warnings-title">Cảnh báo</div>
                  <ul className="warnings-list">
                    {entry.warnings.map((warning, idx) => (
                      <li key={idx}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
              {entry.notes && entry.notes.length > 0 && (
                <div className="agent-assumptions">
                  <div className="assumptions-title">Giả định Agent đã dùng</div>
                  <ul className="assumptions-list">
                    {entry.notes.map((note, idx) => (
                      <li key={idx}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}
              {entry.meta && <div className="meta">{entry.meta}</div>}
              {entry.issues && entry.issues.length > 0 && (
                <details className="issues">
                  <summary>Chi tiết · {entry.issues.length} mục</summary>
                  {entry.issues.map((issue, index) => {
                    const partId = issue.path.startsWith("logic.")
                      ? issue.path.split(".").pop() ?? null
                      : null;
                    return (
                      <div
                        key={`${issue.path}-${index}`}
                        className={`issue ${issue.severity}${partId ? " clickable" : ""}`}
                        onClick={partId ? () => onFocusPart?.(partId) : undefined}
                        title={partId ? "Chọn và zoom tới part này trong 3D" : undefined}
                      >
                        <span className="tag">{issue.severity}</span>
                        <span>
                          <span className="where">{issue.path}</span>
                          {issue.message}
                        </span>
                      </div>
                    );
                  })}
                </details>
              )}
            </div>
          ),
        )}

        {running && (
          <div className="live">
            <span className="spinner" />
            <div>
              <div>{stageMessage || "Working"}</div>
              {stageIssues && stageIssues.length > 0 && (
                <div className="meta" style={{ fontSize: 11, color: "#8c8e91", marginTop: 3 }}>
                  {stageIssues[0].message}
                </div>
              )}
            </div>
          </div>
        )}

        {!isCurrentModelReady && !running && (
          <div className="banner warn">
            Agent chưa sẵn sàng. {statusHint}
          </div>
        )}
      </div>

      <div className="chat-composer">
        {attachments.length > 0 && (
          <div className="attachments-list">
            {attachments.map((doc, idx) => {
              const showThumb = isImageDocument(doc) && Boolean(doc.url);
              return (
                <div key={`${doc.path}-${idx}`} className={`attachment-chip${showThumb ? " image" : ""}`}>
                  {showThumb ? (
                    <button
                      type="button"
                      className="attachment-thumb"
                      onClick={() => setPreview(doc)}
                      title={doc.name}
                      aria-label={`View ${doc.name}`}
                    >
                      <img src={doc.url} alt={doc.name} draggable={false} />
                    </button>
                  ) : (
                    <>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                        <path d="M9.5 4.5 5 9a2.1 2.1 0 0 0 3 3l5-5a3.2 3.2 0 0 0-4.5-4.5L3 8a4.2 4.2 0 0 0 6 6l4-4" />
                      </svg>
                      <span className="name" title={doc.name}>
                        {doc.name}
                      </span>
                    </>
                  )}
                  <span className="size">{formatSize(doc.size)}</span>
                  <button
                    type="button"
                    className="remove"
                    onClick={() => onRemoveAttachment(idx)}
                    aria-label="Remove attachment"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          placeholder={
            uploading
              ? t.chatPlaceholderUploading
              : disabled
                ? t.chatPlaceholderWaiting
                : t.chatPlaceholder
          }
          onPaste={(event) => {
            const items = event.clipboardData?.items;
            if (!items) return;
            const imageFiles: File[] = [];
            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              if (item.type.startsWith("image/")) {
                const blob = item.getAsFile();
                if (blob) {
                  const ext = item.type.split("/")[1] || "png";
                  const file = new File([blob], `pasted-drawing-${Date.now()}-${i + 1}.${ext}`, { type: item.type });
                  imageFiles.push(file);
                }
              }
            }
            if (imageFiles.length > 0) {
              event.preventDefault();
              onAttach(imageFiles);
            }
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            const node = event.currentTarget;
            // Grow from one to six lines, then scroll inside the box.
            node.style.height = "auto";
            const styles = getComputedStyle(node);
            const line = parseFloat(styles.lineHeight) || 18;
            const padding =
              (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
            const max = line * 6 + padding;
            node.style.height = `${Math.min(node.scrollHeight, max)}px`;
            node.style.overflowY = node.scrollHeight > max ? "auto" : "hidden";
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <button
          type="button"
          className="attach"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
          title="Attach a datasheet, drawing or schedule (PDF, image, Word, Excel)"
          aria-label="Attach a document"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M9.5 4.5 5 9a2.1 2.1 0 0 0 3 3l5-5a3.2 3.2 0 0 0-4.5-4.5L3 8a4.2 4.2 0 0 0 6 6l4-4" />
          </svg>
        </button>

        {running ? (
          <button type="button" className="send stop" onClick={onStop} title="Stop the agent" aria-label="Stop">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <rect x="1" y="1" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button type="button" className="send" onClick={submit} disabled={disabled || !draft.trim()} aria-label="Send">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M8 13V3M4 7l4-4 4 4" />
            </svg>
          </button>
        )}

        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.xls,.csv,.txt,.md,.step,.stp,.dwg"
          onChange={(event) => {
            const files = event.target.files ? Array.from(event.target.files) : [];
            if (files.length > 0) onAttach(files);
            event.target.value = "";
          }}
        />
      </div>

      {preview && (
        <div
          className="attachment-preview"
          role="dialog"
          aria-modal="true"
          aria-label={`Xem ${preview.name}`}
          onClick={() => setPreview(null)}
        >
          <div className="attachment-preview-panel" onClick={(event) => event.stopPropagation()}>
            <div className="attachment-preview-head">
              <span className="attachment-preview-name" title={preview.name}>
                {preview.name}
              </span>
              <button
                type="button"
                className="attachment-preview-close"
                onClick={() => setPreview(null)}
                aria-label="Đóng ảnh"
                title="Đóng"
              >
                ×
              </button>
            </div>
            {preview.url ? (
              <img className="attachment-preview-image" src={preview.url} alt={preview.name} />
            ) : (
              <div className="attachment-preview-empty">Ảnh không có URL để hiển thị.</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
