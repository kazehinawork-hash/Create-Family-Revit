import { useEffect, useRef, useState } from "react";
import type { Issue } from "@family/spec-core";
import { isImageDocument, type AgentBackends, type CmdcModel, type CustomApiConfig, type UploadedDocument } from "../lib/api";

export interface ChatEntry {
  id: string;
  role: "user" | "agent";
  text: string;
  tone?: "normal" | "error";
  meta?: string;
  issues?: Issue[];
  notes?: string[];
  attachments?: UploadedDocument[];
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
}

const EMPTY_MODELS: CmdcModel[] = [];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Tự động nhận diện loại API và model mặc định từ API Key hoặc chuỗi nhập.
 */
function analyzeKeyOrInput(keyInput: string): { provider: string; label: string; defaultBaseUrl: string; defaultModel: string } {
  const trimmed = (keyInput || "").trim();

  // 1. Google Gemini API: thường bắt đầu bằng AIzaSy...
  if (trimmed.startsWith("AIzaSy") || trimmed.includes("AIza")) {
    return {
      provider: "gemini",
      label: "Google Gemini API",
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultModel: "gemini-2.5-flash",
    };
  }

  // 2. Anthropic API: thường bắt đầu bằng sk-ant-...
  if (trimmed.startsWith("sk-ant-")) {
    return {
      provider: "anthropic",
      label: "Anthropic Claude API",
      defaultBaseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-3-7-sonnet-latest",
    };
  }

  // 3. OpenRouter: thường bắt đầu bằng sk-or-...
  if (trimmed.startsWith("sk-or-")) {
    return {
      provider: "openai",
      label: "OpenRouter API",
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      defaultModel: "anthropic/claude-3.7-sonnet",
    };
  }

  // 4. Groq, xAI, Perplexity: OpenAI-compatible providers with distinct prefixes.
  if (trimmed.startsWith("gsk_")) {
    return {
      provider: "openai",
      label: "Groq API",
      defaultBaseUrl: "https://api.groq.com/openai/v1",
      defaultModel: "llama-3.3-70b-versatile",
    };
  }

  if (trimmed.startsWith("xai-")) {
    return {
      provider: "openai",
      label: "xAI API",
      defaultBaseUrl: "https://api.x.ai/v1",
      defaultModel: "grok-4",
    };
  }

  if (trimmed.startsWith("pplx-")) {
    return {
      provider: "openai",
      label: "Perplexity API",
      defaultBaseUrl: "https://api.perplexity.ai",
      defaultModel: "sonar",
    };
  }

  // 5. DeepSeek: thường bắt đầu bằng sk-... nhưng có thể là deepseek hoặc openai
  if (trimmed.startsWith("sk-") && trimmed.length === 34) {
    return {
      provider: "openai",
      label: "DeepSeek API",
      defaultBaseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-chat",
    };
  }

  // 5. OpenAI hoặc chuẩn tương thích
  if (trimmed.startsWith("sk-proj-") || trimmed.startsWith("sk-")) {
    return {
      provider: "openai",
      label: "OpenAI API",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o",
    };
  }

  // Nếu người dùng dán URL vào
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const lower = trimmed.toLowerCase();
    if (lower.includes("googleapis.com")) {
      return {
        provider: "gemini",
        label: "Google Gemini API",
        defaultBaseUrl: trimmed,
        defaultModel: "gemini-2.5-flash",
      };
    }
    if (lower.includes("anthropic.com")) {
      return {
        provider: "anthropic",
        label: "Anthropic Claude API",
        defaultBaseUrl: trimmed,
        defaultModel: "claude-3-7-sonnet-latest",
      };
    }
    return {
      provider: "openai",
      label: "OpenAI-compatible Endpoint",
      defaultBaseUrl: trimmed,
      defaultModel: "gpt-4o",
    };
  }

  // Mặc định là Google Gemini nếu chưa nhập
  return {
    provider: "gemini",
    label: "Tự động nhận diện",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
  };
}

const DEFAULT_BASE_URLS = new Set([
  "https://generativelanguage.googleapis.com/v1beta",
  "https://api.openai.com/v1",
  "https://api.anthropic.com/v1",
  "https://openrouter.ai/api/v1",
  "https://api.deepseek.com/v1",
  "https://api.groq.com/openai/v1",
  "https://api.x.ai/v1",
  "https://api.perplexity.ai",
]);

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
}: Props) {
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<UploadedDocument | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [showAdvancedUrl, setShowAdvancedUrl] = useState(false);

  // Custom API configuration state
  const [apiConfig, setApiConfig] = useState<CustomApiConfig>(() => {
    try {
      const saved = localStorage.getItem("custom_api_config");
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "",
      model: "gemini-2.5-flash",
    };
  });

  // Verification state for custom API
  const [apiVerification, setApiVerification] = useState<{
    checked: boolean;
    valid: boolean;
    checking: boolean;
    error?: string;
    models?: string[];
  }>({ checked: false, valid: false, checking: false });

  const detected = analyzeKeyOrInput(apiConfig.apiKey || apiConfig.baseUrl);
  const selectedModelRef = useRef(apiConfig.model);
  selectedModelRef.current = apiConfig.model;

  // Debounce check API Key validity when user changes apiKey or baseUrl
  useEffect(() => {
    if (model !== "custom:api") return;

    const trimmedKey = apiConfig.apiKey?.trim();
    if (!trimmedKey) {
      setApiVerification({ checked: true, valid: false, checking: false, error: "Chưa nhập API Key", models: [] });
      return;
    }

    setApiVerification((prev) => ({ ...prev, checking: true }));

    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/verify-api", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: apiConfig.baseUrl,
            apiKey: trimmedKey,
            model: selectedModelRef.current,
          }),
        });
        const data = await res.json();
        const models = Array.isArray(data.models)
          ? data.models.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
          : [];
        setApiVerification({
          checked: true,
          valid: Boolean(data.ok),
          checking: false,
          error: data.ok ? undefined : data.error || "API Key không hợp lệ",
          models,
        });
        if (data.ok && models.length > 0) {
          setApiConfig((prev) => {
            // Keep a model the user typed explicitly; only replace an empty or
            // still-default model that this provider no longer serves.
            const shouldPick =
              !prev.model || (prev.model === detected.defaultModel && !models.includes(prev.model));
            if (!shouldPick) return prev;
            const next = { ...prev, model: models[0] };
            try {
              localStorage.setItem("custom_api_config", JSON.stringify(next));
            } catch {}
            return next;
          });
        }
      } catch (err: any) {
        setApiVerification({
          checked: true,
          valid: false,
          checking: false,
          error: err?.message || "Không thể kết nối tới server xác minh",
          models: [],
        });
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [apiConfig.apiKey, apiConfig.baseUrl, detected.defaultModel, model]);

  // A model present in /models can still be retired or temporarily unavailable.
  // Probe only the selected model, drop it when the provider rejects it, and
  // move to the next scanned model instead of wasting a full design request.
  useEffect(() => {
    if (model !== "custom:api" || !apiVerification.valid) return;
    const key = apiConfig.apiKey?.trim();
    const current = apiConfig.model;
    if (!key || !current || !apiVerification.models?.includes(current)) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/check-model", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: apiConfig.baseUrl,
            apiKey: key,
            model: current,
          }),
        });
        const data = await res.json();
        if (cancelled || data.ok || !data.unavailable) return;

        const remaining = apiVerification.models!.filter((id) => id !== current);
        setApiVerification((prev) => ({
          ...prev,
          models: (prev.models ?? []).filter((id) => id !== current),
        }));
        if (remaining.length > 0) {
          const next = { ...apiConfig, model: remaining[0] };
          setApiConfig(next);
          try {
            localStorage.setItem("custom_api_config", JSON.stringify(next));
          } catch {}
        }
      } catch {
        // Network errors are transient; keep the model selectable.
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiConfig, apiVerification.models, apiVerification.valid, model]);

  const handleApiKeyChange = (rawKey: string) => {
    const trimmed = rawKey.trim();
    const info = analyzeKeyOrInput(trimmed);
    const currentBase = (apiConfig.baseUrl || "").trim().replace(/\/+$/, "");
    // Do not discard an endpoint the user configured deliberately when they
    // paste or edit the key afterwards. Only replace known provider defaults.
    const keepCustomBase = Boolean(currentBase) && !DEFAULT_BASE_URLS.has(currentBase);
    const newConfig = {
      ...apiConfig,
      apiKey: trimmed,
      baseUrl: keepCustomBase ? apiConfig.baseUrl : info.defaultBaseUrl || apiConfig.baseUrl,
      model: (!apiConfig.model || apiConfig.model === "gemini-2.5-flash" || apiConfig.model === "gpt-4o" || apiConfig.model === "claude-3-7-sonnet-latest")
        ? info.defaultModel
        : apiConfig.model,
    };
    setApiConfig(newConfig);
    try {
      localStorage.setItem("custom_api_config", JSON.stringify(newConfig));
    } catch {}
  };

  const saveApiConfig = (newConfig: CustomApiConfig) => {
    setApiConfig(newConfig);
    try {
      localStorage.setItem("custom_api_config", JSON.stringify(newConfig));
    } catch {}
  };

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

  if (isCustomApi) {
    // A machine without any CLI can still work through Direct API, so this status
    // must not inherit the "no CLI installed" readiness of the default backend.
    if (!apiConfig.apiKey?.trim()) {
      isCurrentModelReady = false;
      statusText = "Không kết nối";
      statusTone = "error";
      statusHint = "Chưa nhập API Key";
    } else if (apiVerification.checking) {
      isCurrentModelReady = false;
      statusText = "Đang kiểm tra...";
      statusTone = "error";
      statusHint = "Đang kiểm tra tính hợp lệ của API Key...";
    } else if (apiVerification.checked && !apiVerification.valid) {
      isCurrentModelReady = false;
      statusText = "Không kết nối";
      statusTone = "error";
      statusHint = apiVerification.error || "API Key không hợp lệ hoặc sai endpoint";
    } else {
      isCurrentModelReady = true;
      statusText = "Sẵn sàng";
      statusTone = "ok";
      statusHint = `${detected.label} · Model: ${apiConfig.model || detected.defaultModel}`;
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

      {isCustomApi && (
        <div className="api-config">
          <div className="api-config-head">
            <span className="api-config-title">Cấu hình API</span>
            {apiVerification.checking ? (
              <span className="api-config-status">
                <span className="api-config-dot" />
                Đang xác thực &amp; quét model
              </span>
            ) : apiVerification.checked && apiVerification.valid ? (
              <span className="api-config-status ok">
                <span className="api-config-dot" />
                Đã xác thực
                {apiVerification.models?.length ? ` · ${apiVerification.models.length} model` : ""}
              </span>
            ) : apiVerification.checked && apiConfig.apiKey?.trim() ? (
              <span className="api-config-status error">
                <span className="api-config-dot" />
                Key không hợp lệ
              </span>
            ) : null}
          </div>

          <div className="api-config-grid">
            <label className="api-field">
              <span>API key (tự nhận diện Google / Claude / OpenAI)</span>
              <input
                type="password"
                className={
                  apiVerification.checked && !apiVerification.valid && apiConfig.apiKey?.trim() ? "invalid" : undefined
                }
                placeholder="AIzaSy… hoặc sk-…"
                value={apiConfig.apiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
              />
            </label>
            <label className="api-field">
              <span>
                Model
                {apiVerification.models?.length
                  ? ` · ${apiVerification.models.length} model khả dụng`
                  : " (tự quét sau khi nhập key)"}
              </span>
              {apiVerification.models && apiVerification.models.length > 0 ? (
                <select
                  className="api-model-select"
                  value={apiConfig.model}
                  onChange={(e) => saveApiConfig({ ...apiConfig, model: e.target.value })}
                  aria-label="Chọn model đã quét"
                >
                  {!apiConfig.model && <option value="">Chọn model…</option>}
                  {apiConfig.model && !apiVerification.models.includes(apiConfig.model) && (
                    <option value={apiConfig.model}>{apiConfig.model} (hiện tại)</option>
                  )}
                  {apiVerification.models.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  placeholder={`Mặc định: ${detected.defaultModel}`}
                  value={apiConfig.model}
                  onChange={(e) => saveApiConfig({ ...apiConfig, model: e.target.value })}
                  autoComplete="off"
                />
              )}
            </label>
          </div>

          <button
            type="button"
            className="api-advanced-toggle"
            onClick={() => setShowAdvancedUrl(!showAdvancedUrl)}
          >
            {showAdvancedUrl ? "Ẩn endpoint URL" : "Tùy chỉnh endpoint URL (proxy / Ollama)"}
          </button>

          {showAdvancedUrl && (
            <label className="api-field">
              <span>Endpoint URL</span>
              <input
                type="text"
                placeholder={detected.defaultBaseUrl}
                value={apiConfig.baseUrl}
                onChange={(e) => saveApiConfig({ ...apiConfig, baseUrl: e.target.value })}
              />
            </label>
          )}
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {entries.length === 0 && (
          <div className="chat-empty">
            <h2>Describe the family you need</h2>
            Sizes, arrangement, connections, materials. The outline appears in seconds, the full
            detail follows.
            <div className="suggestions">
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
              className="msg-agent"
              style={entry.tone === "error" ? { color: "#8a352c" } : undefined}
            >
              <div className="role">
                <span className="dot" style={{ width: 5, height: 5, borderRadius: 3, background: "#3c7a63" }} />
                Family agent
              </div>
              <div className="body">{entry.text}</div>
              {entry.notes && entry.notes.length > 0 && (
                <div className="agent-assumptions">
                  <div className="assumptions-title">Giả định & Câu hỏi từ Agent (Assumptions & Questions)</div>
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
                  <summary>
                    Details · {entry.issues.length} item{entry.issues.length === 1 ? "" : "s"}
                  </summary>
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

        {!isCurrentModelReady && (
          <div className="banner warn">
            The design agent is not ready. {statusHint}
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
              ? "Uploading document(s)…"
              : disabled
                ? "Waiting for the agent…"
                : "Ask for a change or paste multiple images (Ctrl+V)"
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
            node.style.height = "auto";
            node.style.height = `${Math.min(node.scrollHeight, 120)}px`;
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
