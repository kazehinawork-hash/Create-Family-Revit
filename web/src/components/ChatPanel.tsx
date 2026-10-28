import { useEffect, useRef, useState } from "react";
import type { Issue } from "@family/spec-core";
import { isImageDocument, type CmdcModel, type UploadedDocument } from "../lib/api";

export interface ChatEntry {
  id: string;
  role: "user" | "agent";
  text: string;
  meta?: string;
  notes?: string[];
  issues?: Issue[];
  tone?: "normal" | "error";
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
  attachments: UploadedDocument[];
  uploading: boolean;
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
}

const MODELS = [
  { id: "", label: "cmdc default" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "moonshotai/kimi-k3.1-pro", label: "Kimi K3.1 Pro" },
  { id: "moonshotai/kimi-k2.7-code", label: "Kimi K2.7 Code" },
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash" },
  { id: "zai-org/glm-5.3", label: "GLM 5.3" },
  { id: "qwen/qwen3.8-max", label: "Qwen 3.8 Max" },
  { id: "qwen/qwen3.8-flash", label: "Qwen 3.8 Flash" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-6-sol", label: "GPT-6 Sol" },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "xai/grok-4.6", label: "Grok 4.6" },
  { id: "reflection/beam:free", label: "Beam (Free)" },
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SUGGESTIONS = [
  "Horizontal fan coil 080, 1910 × 1600 × 560 casing, 4-pipe coil, drain pan on the left",
  "Rooftop AHU, 6000 × 2400 × 2100, supply and return fans, filter section, 6 access doors",
  "Wall mounted electric panel heater, 1200 mm wide, louvred outlet",
  "Centrifugal inline pump, DN80 flanges, 90 mm stub length, base frame",
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
  agentLabel: _agentLabel,
  agentDetail,
  provider: _provider,
  model,
  onModel,
  availableModels,
  attachments,
  uploading,
  onAttach,
  onRemoveAttachment,
}: Props) {
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<UploadedDocument | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
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

  const modelList = availableModels && availableModels.length > 0
    ? [{ id: "", label: "cmdc default" }, ...availableModels]
    : MODELS;

  return (
    <section className="pane left">
      <div className="pane-header" style={{ justifyContent: "space-between" }}>
        <span>Agent</span>
        <select
          className="model-select"
          value={model}
          onChange={(event) => onModel(event.target.value)}
          title="Model used by the Command Code CLI"
          aria-label="Agent model"
        >
          {modelList.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
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
                  {entry.issues.map((issue, index) => (
                    <div key={`${issue.path}-${index}`} className={`issue ${issue.severity}`}>
                      <span className="tag">{issue.severity}</span>
                      <span>
                        <span className="where">{issue.path}</span>
                        {issue.message}
                      </span>
                    </div>
                  ))}
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

        {agentReady === false && (
          <div className="banner warn">
            The design agent is not ready. {agentDetail}
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

      {preview?.url && (
        <div className="modal-backdrop image-viewer-backdrop" onClick={() => setPreview(null)}>
          <div className="modal-card image-viewer-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div className="title-row">
                <h3>{preview.name}</h3>
                <span className="meta">{formatSize(preview.size)}</span>
              </div>
              <div className="header-actions">
                <a
                  className="modal-close"
                  href={preview.url}
                  target="_blank"
                  rel="noreferrer"
                  title="Open in a new tab"
                  aria-label="Open in a new tab"
                >
                  ↗
                </a>
                <button type="button" className="modal-close" onClick={() => setPreview(null)} aria-label="Close">
                  ×
                </button>
              </div>
            </div>
            <div className="modal-body image-viewer-body">
              <img src={preview.url} alt={preview.name} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
