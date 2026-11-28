import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { FamilySpec, Issue } from "@family/spec-core";
import {
  isImageDocument,
  type AgentBackends,
  type CmdcModel,
  type UploadedDocument,
} from "../lib/api";
import type { ApiKeyStatus } from "./ApiKeyPanel";

const ApiKeyPanel = lazy(() =>
  import("./ApiKeyPanel").then((m) => ({ default: m.ApiKeyPanel })),
);

function hasSavedApiKey(): boolean {
  try {
    const raw = localStorage.getItem("custom_api_config");
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { apiKey?: unknown; baseUrl?: unknown };
    return Boolean(parsed?.apiKey || parsed?.baseUrl);
  } catch {
    return false;
  }
}
import { isApiReady } from "../lib/api-key";
import { useI18n } from "../lib/i18n";
import type { SpecDiff } from "../lib/spec-diff";
import type { ChatTarget } from "../lib/annotations";

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

/** Render `formula` spans from a note as small inline code without a markdown dependency. */
function InlineCode({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, index) =>
        part.startsWith("`") && part.endsWith("`") ? (
          <code key={index} className="chat-inline-code">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

export interface ChatEntry {
  id: string;
  role: "user" | "agent";
  text: string;
  tone?: "normal" | "error";
  meta?: string;
  /** Structured meta for a finished design turn. */
  metaInfo?: {
    elapsed?: string;
    model?: string;
    calls?: number;
    inChars?: number;
    outChars?: number;
    cached?: string;
    local?: boolean;
  };
  issues?: Issue[];
  /** Assumptions introduced this turn. */
  notes?: string[];
  /** Assumptions carried over from earlier turns, collapsed by default. */
  oldNotes?: string[];
  changes?: SpecDiff;
  check?: {
    ok: boolean;
    errors: number;
    warnings: number;
    missing?: string[];
  };
  /** Spec before this turn, used by the undo button on the result card. */
  undoSpec?: FamilySpec | null;
  /** Parts / notes attached to a user message. */
  targets?: ChatTarget[];
  /** Warnings from the run (separate from the assumptions in `notes`). */
  warnings?: string[];
  /** Parameter values the agent used, with where each one came from. */
  resolution?: ResolutionRow[];
  attachments?: UploadedDocument[];
  action?: {
    label: string;
    kind?: "retry" | "use-sample" | "open-api" | "fresh";
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
  onSend: (text: string, targets?: ChatTarget[]) => void;
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
  /** Parts currently present in the spec; missing target chips read "changed". */
  partIds?: string[];
  targets?: ChatTarget[];
  onRemoveTarget?: (index: number) => void;
  /** Bump this to focus the composer after the viewer adds chips. */
  focusSignal?: number;
  /** Highlight every part changed in one turn on the 3D model. */
  onHighlightParts?: (partIds: string[]) => void;
  /** Restore the spec snapshot from before a design turn. */
  onUndoSpec?: (spec: FamilySpec | null) => void;
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
  partIds = [],
  targets = [],
  onRemoveTarget,
  focusSignal = 0,
  onHighlightParts,
  onUndoSpec,
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
  const { t, formatDate, formatDateTime, formatNumber, localizeIssue } = useI18n();

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

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    setDraft("");
    onSend(text, targets.length > 0 ? targets : undefined);
    if (inputRef.current) inputRef.current.style.height = "auto";
  };

  const modelList: CmdcModel[] = availableModels ?? EMPTY_MODELS;
  const hasModels = modelList.length > 0;
  const modelValue =
    hasModels && modelList.some((entry) => entry.id === model) ? model : (modelList[0]?.id ?? "");

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
  let statusText = modelBackendReady ? t.chatStatusReady : t.chatStatusConnecting;
  let statusTone: "ok" | "warn" | "error" = modelBackendReady ? "ok" : "warn";
  let statusHint = agentDetail || t.chatStatusReadyHint;

  if (serverOnline === false) {
    // The API itself is unreachable: no model can run, whatever is selected.
    isCurrentModelReady = false;
    statusText = t.chatStatusServerOffline;
    statusTone = "error";
    statusHint = t.chatStatusServerOfflineHint;
  } else if (isCustomApi) {
    // A machine without any CLI can still work through Direct API, so this status
    // comes from the panel instead of the CLI readiness probe.
    if (isApiReady(apiStatus)) {
      isCurrentModelReady = true;
      statusText = t.chatStatusReady;
      statusTone = "ok";
      const apiProvider = apiStatus?.provider ?? "Direct API";
      const apiCount = formatNumber(apiStatus?.count ?? 0);
      statusHint =
        t.chatStatusApiReadyHint(apiProvider, apiCount) +
        (apiStatus?.revalidating ? ` · ${t.chatStatusApiRefreshing}` : "");
    } else if (!apiStatus || apiStatus.state === "idle") {
      isCurrentModelReady = false;
      statusText = t.chatStatusNoKey;
      statusTone = "warn";
      statusHint = t.chatStatusNoKeyHint;
    } else if (apiStatus.state === "checking") {
      isCurrentModelReady = false;
      statusText = t.chatStatusChecking;
      statusTone = "warn";
      statusHint = t.chatStatusCheckingHint;
    } else if (apiStatus.state === "error") {
      isCurrentModelReady = false;
      statusText = t.chatStatusDisconnected;
      statusTone = "error";
      statusHint = apiStatus.error || t.chatStatusBadKey;
    } else {
      isCurrentModelReady = true;
      statusText = t.chatStatusReady;
      statusTone = "ok";
      statusHint = t.chatStatusApiReadyHint(apiStatus.provider, formatNumber(apiStatus.count));
    }
  } else if (modelBackendReady === false) {
    isCurrentModelReady = false;
    statusText = t.chatStatusDisconnected;
    statusTone = "error";
    statusHint = t.chatStatusCliMissing(modelValue || backendKey);
  }

  const suggestions = [t.chatSuggestionPump, t.chatSuggestionFcu, t.chatSuggestionFan];

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${formatNumber(bytes)} B`;
    if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 1024))} KB`;
    return `${formatNumber(bytes / (1024 * 1024), { maximumFractionDigits: 1 })} MB`;
  };

  /** Locale-aware `2025-9-20-10-30` stamp used in the exported file name. */
  const exportStamp = (): string => {
    const now = new Date();
    const day = formatDate(now);
    const clock = formatDateTime(now).replace(day, "").trim();
    return `${day} ${clock}`.replace(/[^\d]+/g, "-").replace(/^-+|-+$/g, "");
  };

  const downloadResolutionCsv = (rows: ResolutionRow[]) => {
    const cell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = [
      [t.parameters, t.chatColumnValue, t.chatColumnLevel, t.chatColumnSource].map(cell).join(","),
      ...rows.map((row) =>
        [row.name, row.value, row.level ?? "", row.source ?? ""].map(cell).join(","),
      ),
    ].join("\n");

    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${t.chatCsvFileName}-${exportStamp()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="pane left">
      <div
        className="pane-header"
        style={{
          justifyContent: "space-between",
          alignItems: "center",
          gap: 6,
          flexWrap: "nowrap",
        }}
      >
        <span style={{ flexShrink: 0 }}>Agent</span>

        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            maxWidth: "calc(100% - 60px)",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            rowGap: 6,
          }}
        >
          <select
            className="model-select"
            value={modelValue}
            onChange={(event) => onModel(event.target.value)}
            disabled={!hasModels}
            title={t.chatModelSelectTitle}
            aria-label="Agent model"
            style={{ maxWidth: 150, flexShrink: 1, minWidth: 0 }}
          >
            {!hasModels && <option value="">{t.chatAgentNotReady}</option>}
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
              aria-label={t.chatUseApiKeyAria}
            >
              {t.chatUseApiKey}
            </button>
          )}

          {incomplete && incomplete.length > 0 && (
            <span
              className="agent-pill incomplete"
              title={incomplete.join("\n")}
              data-testid="incomplete-pill"
            >
              ⚠ {t.chatIncomplete}
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
          <span className="session-usage-title">{t.chatSessionUsage}</span>
          {Object.entries(sessionUsage)
            .sort((a, b) => b[1] - a[1])
            .map(([modelId, count]) => (
              <span
                key={modelId}
                className="session-usage-item"
                title={t.chatSessionCalls(formatNumber(count))}
              >
                {modelId} ×{formatNumber(count)}
              </span>
            ))}
        </div>
      )}

      {(apiPanelOpen || modelValue === "custom:api" || hasSavedApiKey()) && (
        <Suspense fallback={null}>
          <ApiKeyPanel
            model={modelValue}
            onModel={onModel}
            open={apiPanelOpen}
            onClose={() => setApiPanelOpen(false)}
            onStatus={setApiStatus}
          />
        </Suspense>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {entries.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon" aria-hidden="true">
              <svg
                width="34"
                height="34"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              >
                <path d="M3 7l9-4 9 4-9 4-9-4z" />
                <path d="M3 12l9 4 9-4M3 17l9 4 9-4" />
              </svg>
            </div>
            <h2>{t.chatEmptyTitle}</h2>
            <p>{t.chatEmptyBody}</p>
            <div className="suggestions">
              <span className="suggestions-label">{t.chatTrySuggestions}</span>
              {suggestions.map((suggestion) => (
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
                        aria-label={t.chatViewImage(doc.name)}
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
              {entry.targets && entry.targets.length > 0 && (
                <div className="msg-user-targets">
                  {entry.targets.map((target, index) => {
                    const missing = !partIds.includes(target.partId);
                    return (
                      <button
                        key={`${target.partId}-${target.noteId ?? index}`}
                        type="button"
                        className={`msg-user-target${missing ? " stale" : ""}${
                          target.note ? " with-note" : ""
                        }`}
                        disabled={missing}
                        title={missing ? t.chatTargetChanged : t.chatFocusPartHint}
                        onClick={() => {
                          if (!missing) onFocusPart?.(target.partId);
                        }}
                      >
                        <span className="msg-user-target-part">{target.partName}</span>
                        {target.note && (
                          <span className="msg-user-target-note">{target.note}</span>
                        )}
                        {missing && (
                          <span className="msg-user-target-stale">{t.chatTargetChanged}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {entry.text}
            </div>
          ) : (
            <div
              key={entry.id}
              className={`msg-agent${
                entry.tone === "error"
                  ? entry.text.startsWith("⛔") || (entry.check?.errors ?? 0) > 0
                    ? " msg-error"
                    : " msg-warn"
                  : ""
              }`}
            >
              <div className="role">
                <span
                  className="dot"
                  style={{ width: 5, height: 5, borderRadius: 3, background: "#3c7a63" }}
                />
                Family agent
              </div>
              <div className="body">
                <InlineCode text={entry.text} />
              </div>
              {entry.details && (
                <details className="msg-details" data-testid="chat-details">
                  <summary>{t.chatErrorDetails}</summary>
                  <pre>{entry.details}</pre>
                </details>
              )}
              {entry.changes &&
                (entry.changes.parts.length > 0 || entry.changes.parameters.length > 0) && (
                  <div className="agent-changes" data-testid="chat-changes">
                    <div className="agent-section-title">{t.chatChangesTitle}</div>
                    <ul className="change-list">
                      {entry.changes.parts.slice(0, 6).map((part) => {
                        const label =
                          part.kind === "added"
                            ? t.chatPartAdded
                            : part.kind === "removed"
                              ? t.chatPartRemoved
                              : t.chatPartUpdated;
                        return (
                          <li key={`${part.kind}-${part.id}`} className={`change-part ${part.kind}`}>
                            <span className="change-kind">{label}</span>
                            {part.kind === "removed" ? (
                              <span className="change-name">{part.name}</span>
                            ) : (
                              <button
                                type="button"
                                className="chat-part-link"
                                onClick={() => onFocusPart?.(part.id)}
                                title={t.chatFocusPartHint}
                              >
                                {part.name}
                              </button>
                            )}
                          </li>
                        );
                      })}
                      {entry.changes.parts.length > 6 && (
                        <li className="change-more">
                          {t.chatMoreChanges(entry.changes.parts.length - 6)}
                        </li>
                      )}
                      {entry.changes.parameters.slice(0, 6).map((parameter) => {
                        const label =
                          parameter.kind === "added"
                            ? t.chatParamAdded
                            : parameter.kind === "removed"
                              ? t.chatParamRemoved
                              : t.chatParamUpdated;
                        const values =
                          parameter.kind === "removed"
                            ? parameter.from
                            : parameter.kind === "added"
                              ? parameter.to
                              : `${parameter.from} → ${parameter.to}`;
                        return (
                          <li
                            key={`${parameter.kind}-${parameter.name}`}
                            className={`change-parameter ${parameter.kind}`}
                          >
                            <span className="change-kind">{label}</span>
                            <span className="change-name">{parameter.name}</span>
                            {values && <code className="change-values">{values}</code>}
                          </li>
                        );
                      })}
                      {entry.changes.parameters.length > 6 && (
                        <li className="change-more">
                          {t.chatMoreChanges(entry.changes.parameters.length - 6)}
                        </li>
                      )}
                    </ul>
                  </div>
                )}
              {entry.check &&
                (() => {
                  const hasDetails =
                    entry.issues?.length ||
                    entry.warnings?.length ||
                    (entry.check?.missing?.length ?? 0) > 0;
                  const status = entry.check!.errors
                    ? t.chatCheckErrors(entry.check!.errors)
                    : entry.check!.warnings
                      ? t.chatCheckWarnings(entry.check!.warnings)
                      : (entry.check!.missing?.length ?? 0) > 0
                        ? t.chatCheckIncomplete(entry.check!.missing!.length)
                        : t.chatCheckOk;
                  const tone = entry.check!.ok && !entry.check!.warnings ? "is-ok" : "has-warning";
                  const content = (
                    <>
                      {entry.check!.missing && entry.check!.missing.length > 0 && (
                        <ul className="check-missing">
                          {entry.check!.missing.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      )}
                      {entry.issues && entry.issues.length > 0 && (
                        <div className="check-issues">
                          {entry.issues.map((issue, index) => {
                            const partId = issue.path.startsWith("logic.")
                              ? (issue.path.split(".").pop() ?? null)
                              : null;
                            return (
                              <div
                                key={`${issue.path}-${index}`}
                                className={`issue ${issue.severity}${partId ? " clickable" : ""}`}
                                onClick={partId ? () => onFocusPart?.(partId) : undefined}
                                title={partId ? t.chatFocusPartHint : undefined}
                              >
                                <span className="tag">{issue.severity}</span>
                                <span>
                                  <span className="where">{issue.path}</span>
                                  {localizeIssue(issue.message, issue.code, issue.params)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {entry.warnings && entry.warnings.length > 0 && (
                        <ul className="warnings-list check-warnings">
                          {entry.warnings.map((warning, index) => (
                            <li key={index}>{warning}</li>
                          ))}
                        </ul>
                      )}
                    </>
                  );
                  return hasDetails ? (
                    <details
                      className={`agent-check ${tone}`}
                      open={Boolean(entry.check!.errors || entry.check!.missing?.length)}
                    >
                      <summary>
                        <span className="check-title">{t.chatCheckTitle}</span>
                        <span className="check-status">{status}</span>
                      </summary>
                      {content}
                    </details>
                  ) : (
                    <div className={`agent-check ${tone}`}>
                      <span className="check-title">{t.chatCheckTitle}</span>
                      <span className="check-status">{status}</span>
                    </div>
                  );
                })()}
              {entry.notes && entry.notes.length > 0 && (
                <div className="agent-assumptions">
                  <div className="assumptions-title">
                    {entry.check || entry.changes ? t.chatAssumptionsTitle : t.chatNotesTitle}
                  </div>
                  <ul className="assumptions-list">
                    {entry.notes.map((note, idx) => (
                      <li key={idx}>
                        <InlineCode text={note} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {entry.oldNotes && entry.oldNotes.length > 0 && (
                <details className="agent-assumptions assumptions-history">
                  <summary>{t.chatOldAssumptions(entry.oldNotes.length)}</summary>
                  <ul className="assumptions-list">
                    {entry.oldNotes.map((note, idx) => (
                      <li key={idx}>
                        <InlineCode text={note} />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {entry.resolution && entry.resolution.length > 0 && (
                <details className="agent-resolution">
                  <summary>{t.chatResolutionTitle}</summary>
                  <div className="assumptions-head">
                    <button
                      type="button"
                      className="assumptions-csv"
                      onClick={() => downloadResolutionCsv(entry.resolution!)}
                    >
                      {t.chatDownloadCsv}
                    </button>
                  </div>
                  <table className="resolution-table" data-testid="resolution-table">
                    <thead>
                      <tr>
                        <th>{t.parameters}</th>
                        <th>{t.chatColumnValue}</th>
                        <th>{t.chatColumnSource}</th>
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
                </details>
              )}
              {entry.metaInfo ? (
                <div className="meta chat-meta-line" data-testid="chat-meta">
                  {entry.metaInfo.elapsed && (
                    <span>
                      <span className="meta-label">{t.chatMetaTime}</span>{" "}
                      {entry.metaInfo.elapsed}
                    </span>
                  )}
                  {entry.metaInfo.model && (
                    <span>
                      <span className="meta-label">{t.chatMetaModel}</span>{" "}
                      {entry.metaInfo.model}
                    </span>
                  )}
                  {entry.metaInfo.calls !== undefined && (
                    <span>
                      <span className="meta-label">{t.chatMetaTurns}</span>{" "}
                      {formatNumber(entry.metaInfo.calls)}
                    </span>
                  )}
                  {(entry.metaInfo.inChars !== undefined ||
                    entry.metaInfo.outChars !== undefined) && (
                    <span title={t.chatMetaCharsHint}>
                      <span className="meta-label">{t.chatMetaChars}</span>{" "}
                      {formatNumber(entry.metaInfo.inChars ?? 0)} /{" "}
                      {formatNumber(entry.metaInfo.outChars ?? 0)}
                    </span>
                  )}
                  {entry.metaInfo.cached && (
                    <span className="meta-muted">{entry.metaInfo.cached}</span>
                  )}
                  {entry.metaInfo.local && (
                    <span className="meta-muted">⚡ local</span>
                  )}
                </div>
              ) : (
                entry.meta && <div className="meta">{entry.meta}</div>
              )}
              {!entry.check && entry.warnings && entry.warnings.length > 0 && (
                <div className="agent-warnings">
                  <div className="warnings-title">{t.chatWarningsTitle}</div>
                  <ul className="warnings-list">
                    {entry.warnings.map((warning, idx) => (
                      <li key={idx}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
              {!entry.check && entry.issues && entry.issues.length > 0 && (
                <details className="issues">
                  <summary>{t.chatIssueCount(entry.issues.length)}</summary>
                  {entry.issues.map((issue, index) => {
                    const partId = issue.path.startsWith("logic.")
                      ? (issue.path.split(".").pop() ?? null)
                      : null;
                    return (
                      <div
                        key={`${issue.path}-${index}`}
                        className={`issue ${issue.severity}${partId ? " clickable" : ""}`}
                        onClick={partId ? () => onFocusPart?.(partId) : undefined}
                        title={partId ? t.chatFocusPartHint : undefined}
                      >
                        <span className="tag">{issue.severity}</span>
                        <span>
                          <span className="where">{issue.path}</span>
                          {localizeIssue(issue.message, issue.code, issue.params)}
                        </span>
                      </div>
                    );
                  })}
                </details>
              )}
              {((entry.changes?.changedPartIds.length ?? 0) > 0 || entry.undoSpec !== undefined) && (
                <div className="chat-result-actions">
                  {(entry.changes?.changedPartIds.length ?? 0) > 0 && onHighlightParts && (
                    <button
                      type="button"
                      className="chat-result-action chat-result-action-primary"
                      onClick={() => onHighlightParts(entry.changes!.changedPartIds)}
                    >
                      {t.chatViewOn3d}
                    </button>
                  )}
                  {entry.undoSpec !== undefined && onUndoSpec && (
                    <button
                      type="button"
                      className="chat-result-action"
                      onClick={() => onUndoSpec(entry.undoSpec ?? null)}
                    >
                      {t.chatUndoThisTurn}
                    </button>
                  )}
                </div>
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
            </div>
          ),
        )}

        {running && (
          <div className="live">
            <span className="dots-loader" aria-hidden="true">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </span>
            <div>
              <div>{stageMessage || t.chatWorking}</div>
              {stageIssues && stageIssues.length > 0 && (
                <div className="meta" style={{ fontSize: 11, color: "#8c8e91", marginTop: 3 }}>
                  {localizeIssue(
                    stageIssues[0].message,
                    stageIssues[0].code,
                    stageIssues[0].params,
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {!isCurrentModelReady && !running && (
          <div className="banner warn">{t.chatNotReadyBanner(statusHint)}</div>
        )}
      </div>

      <div className="chat-composer">
        {targets.length > 0 && (
          <div className="composer-targets" data-testid="composer-targets">
            {targets.map((target, index) => (
              <span
                key={`${target.partId}-${target.noteId ?? index}`}
                className={`composer-target${target.note ? " with-note" : ""}${
                  partIds.includes(target.partId) ? "" : " stale"
                }`}
              >
                <button
                  type="button"
                  className="composer-target-name"
                  title={
                    partIds.includes(target.partId)
                      ? t.chatFocusPartHint
                      : t.chatTargetChanged
                  }
                  disabled={!partIds.includes(target.partId)}
                  onClick={() => onFocusPart?.(target.partId)}
                >
                  {target.partName}
                </button>
                {target.note && <span className="composer-target-note">{target.note}</span>}
                {!partIds.includes(target.partId) && (
                  <span className="composer-target-stale">{t.chatTargetChanged}</span>
                )}
                <button
                  type="button"
                  className="composer-target-remove"
                  title={t.chatRemoveTarget}
                  aria-label={t.chatRemoveTarget}
                  onClick={() => onRemoveTarget?.(index)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachments-list">
            {attachments.map((doc, idx) => {
              const showThumb = isImageDocument(doc) && Boolean(doc.url);
              return (
                <div
                  key={`${doc.path}-${idx}`}
                  className={`attachment-chip${showThumb ? " image" : ""}`}
                >
                  {showThumb ? (
                    <button
                      type="button"
                      className="attachment-thumb"
                      onClick={() => setPreview(doc)}
                      title={doc.name}
                      aria-label={t.chatViewImage(doc.name)}
                    >
                      <img src={doc.url} alt={doc.name} draggable={false} />
                    </button>
                  ) : (
                    <>
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                      >
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
                    aria-label={t.chatRemoveAttachment}
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
                  const file = new File([blob], `pasted-drawing-${Date.now()}-${i + 1}.${ext}`, {
                    type: item.type,
                  });
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
          title={t.chatAttach}
          aria-label={t.chatAttach}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <path d="M9.5 4.5 5 9a2.1 2.1 0 0 0 3 3l5-5a3.2 3.2 0 0 0-4.5-4.5L3 8a4.2 4.2 0 0 0 6 6l4-4" />
          </svg>
        </button>

        {running ? (
          <button
            type="button"
            className="send stop"
            onClick={onStop}
            title={t.chatStop}
            aria-label={t.chatStop}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <rect x="1" y="1" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            className="send"
            data-testid="chat-send"
            onClick={submit}
            disabled={disabled || !draft.trim()}
            aria-label={t.chatSend}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
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
          aria-label={t.chatViewImage(preview.name)}
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
                aria-label={t.chatClosePreview}
                title={t.close}
              >
                ×
              </button>
            </div>
            {preview.url ? (
              <img className="attachment-preview-image" src={preview.url} alt={preview.name} />
            ) : (
              <div className="attachment-preview-empty">{t.chatPreviewEmpty}</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
