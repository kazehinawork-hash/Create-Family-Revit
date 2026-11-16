import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  analyzeKeyOrInput,
  filterModels,
  groupModels,
  isModelId,
  normalizeEndpointUrl,
  pickAutoModel,
  resolveModelName,
  shouldAutoCollapse,
  shouldVerify,
  suggestedModelsFor,
  verifiedKeyFor,
  type ModelEntry,
} from "../lib/api-key";
import { useI18n } from "../lib/i18n";

export interface ApiKeyStatus {
  state: "idle" | "checking" | "ok" | "error";
  provider: string;
  count: number;
  error?: string;
  retryable?: boolean;
  /** A key that was already verified is being checked again (endpoint changed). */
  revalidating?: boolean;
}

interface Props {
  /** Model selected in the header. */
  model: string;
  onModel: (id: string) => void;
  /** Panel visibility (opened by "Dùng API key" or by choosing custom:api). */
  open: boolean;
  onClose: () => void;
  onStatus: (status: ApiKeyStatus) => void;
}

interface StoredConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Failure reasons are stored as codes, not sentences, so the visible message can
 * follow a language change without verifying the key again.
 */
type PanelError =
  | { kind: "rejected"; provider: string }
  | { kind: "invalid" }
  | { kind: "server"; message: string }
  | { kind: "offline" };

interface PanelState {
  state: ApiKeyStatus["state"];
  provider: string;
  count: number;
  retryable?: boolean;
  revalidating?: boolean;
}

const DEFAULT_BASE = "https://api.openai.com/v1";

function readStoredConfig(): StoredConfig {
  try {
    const raw = localStorage.getItem("custom_api_config");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredConfig>;
      return {
        baseUrl: String(parsed.baseUrl ?? ""),
        apiKey: String(parsed.apiKey ?? ""),
        model: String(parsed.model ?? ""),
      };
    }
  } catch {
    /* storage can be disabled */
  }
  return { baseUrl: "", apiKey: "", model: "" };
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem("api_panel_collapsed") === "1";
  } catch {
    return false;
  }
}

/**
 * Direct API panel: paste a key, pick a model, done. Detection, endpoint defaults,
 * verification and model selection all happen on their own.
 */
export function ApiKeyPanel({ model, onModel, open, onClose, onStatus }: Props) {
  const { t } = useI18n();
  const [config, setConfig] = useState<StoredConfig>(readStoredConfig);
  const [panel, setPanel] = useState<PanelState>({ state: "idle", provider: "", count: 0 });
  const [panelError, setPanelError] = useState<PanelError | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [retryTick, setRetryTick] = useState(0);

  const describeError = useCallback(
    (error: PanelError | null): string | undefined => {
      if (!error) return undefined;
      switch (error.kind) {
        case "rejected":
          return t.apiKeyRejected(error.provider);
        case "invalid":
          return t.apiKeyInvalid;
        case "offline":
          return t.apiConnectionFailed;
        case "server":
          return error.message;
      }
    },
    [t],
  );

  /** The public status (also reported upward) with its message in the active language. */
  const status = useMemo<ApiKeyStatus>(
    () => ({ ...panel, error: describeError(panelError) }),
    [panel, panelError, describeError],
  );

  const detected = analyzeKeyOrInput(config.apiKey || config.baseUrl, config.baseUrl);
  const suggestions = useMemo(
    () => suggestedModelsFor(detected.label, detected.provider),
    [detected.label, detected.provider],
  );

  const saveConfig = useCallback((next: StoredConfig) => {
    setConfig(next);
    try {
      localStorage.setItem("custom_api_config", JSON.stringify(next));
    } catch {
      /* storage can be disabled */
    }
  }, []);

  // The verification effect must not restart when a model or a callback changes.
  // Everything it reads that is not its trigger lives in a ref.
  const configRef = useRef(config);
  configRef.current = config;
  const modelRef = useRef(model);
  modelRef.current = model;
  const onModelRef = useRef(onModel);
  onModelRef.current = onModel;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const saveConfigRef = useRef(saveConfig);
  saveConfigRef.current = saveConfig;
  const suggestionsRef = useRef<string[]>([]);
  /** `key|baseUrl` that /api/verify-api answered OK for. */
  const verifiedForRef = useRef("");
  const lastStatusRef = useRef("");
  const lastRetryRef = useRef(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const modelSelectRef = useRef<HTMLSelectElement | null>(null);
  /** Key stored when the panel opened: a different one is a "new key". */
  const initialKeyRef = useRef(config.apiKey.trim());
  /** Key whose first successful verify already triggered the auto-collapse. */
  const autoCollapsedForRef = useRef("");
  suggestionsRef.current = suggestions;

  const saveCliKey = (key: string) => {
    try {
      if (key.trim().startsWith("user_")) localStorage.setItem("command_code_api_key", key.trim());
      else localStorage.removeItem("command_code_api_key");
    } catch {
      /* storage can be disabled */
    }
  };

  const rememberCollapsed = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem("api_panel_collapsed", next ? "1" : "0");
    } catch {
      /* storage can be disabled */
    }
  }, []);

  const statusRef = useRef(status);
  statusRef.current = status;

  /**
   * Collapse only on an explicit action. Focus inside the panel always wins, and
   * the model <select> itself is exempt for the "picked" case: choosing an option
   * leaves focus there, which would otherwise block the collapse forever.
   */
  const collapseIfAllowed = useCallback(
    (reason: "picked" | "verified-new-key" | "verified", statusOk = statusRef.current.state === "ok") => {
      const active = document.activeElement;
      const focusInside =
        Boolean(panelRef.current?.contains(active)) && active !== modelSelectRef.current;
      if (shouldAutoCollapse({ reason, focusInside, statusOk })) {
        rememberCollapsed(true);
      }
    },
    [rememberCollapsed],
  );

  // Report upward only when something meaningful changed, so a parent re-render
  // cannot bounce back into this component.
  useEffect(() => {
    const signature = `${status.state}|${status.provider}|${status.count}|${status.error ?? ""}|${status.revalidating ? 1 : 0}`;
    if (lastStatusRef.current === signature) return;
    lastStatusRef.current = signature;
    onStatusRef.current(status);
  }, [status]);

  const verifyKey = config.apiKey.trim();
  const verifyBase =
    normalizeEndpointUrl(config.baseUrl) || analyzeKeyOrInput(verifyKey, config.baseUrl).defaultBaseUrl;

  // Verify only for a new (key, endpoint) pair. Re-renders, model changes and parent
  // callbacks never restart this effect; only a new pair or "Thử lại" does.
  useEffect(() => {
    if (!open) return;

    if (retryTick !== lastRetryRef.current) {
      lastRetryRef.current = retryTick;
      verifiedForRef.current = "";
    }

    if (!verifyKey) {
      verifiedForRef.current = "";
      setModels([]);
      setModelNames({});
      setPanel({ state: "idle", provider: "", count: 0 });
      setPanelError(null);
      return;
    }

    if (!shouldVerify({ key: verifyKey, baseUrl: verifyBase, verifiedFor: verifiedForRef.current })) {
      return;
    }

    let cancelled = false;
    // A key that was already verified stays "ok" while it is checked again.
    setPanelError(null);
    setPanel((current) =>
      current.state === "ok"
        ? { ...current, revalidating: true }
        : { state: "checking", provider: current.provider, count: current.count },
    );

    const timer = window.setTimeout(async () => {
      const current = configRef.current;
      const label = analyzeKeyOrInput(verifyKey, verifyBase).label;

      try {
        const response = await fetch("/api/verify-api", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: verifyBase,
            apiKey: verifyKey,
            model: isModelId(current.model) ? current.model : undefined,
          }),
        });
        const data = await response.json();
        if (cancelled) return;

        const list = Array.isArray(data.models)
          ? (data.models as unknown[]).filter(
              (item): item is string => typeof item === "string" && item.trim().length > 0,
            )
          : [];
        const names =
          data.modelNames && typeof data.modelNames === "object"
            ? (data.modelNames as Record<string, string>)
            : {};

        if (data.ok) {
          verifiedForRef.current = verifiedKeyFor(verifyKey, verifyBase);
          setModels(list);
          setModelNames(names);
          setPanel({
            state: "ok",
            provider: String(data.provider ?? label),
            count: list.length,
          });
          setPanelError(null);

          const mapped =
            current.model && !isModelId(current.model)
              ? resolveModelName(list, names, current.model)
              : null;
          const chosen =
            mapped ??
            pickAutoModel({ models: list, saved: current.model, suggestions: suggestionsRef.current });
          if (chosen && chosen !== current.model) saveConfigRef.current({ ...current, model: chosen });
          if (modelRef.current !== "custom:api") onModelRef.current("custom:api");

          // A brand-new key folds the panel away once, after its first success.
          if (verifyKey !== initialKeyRef.current && autoCollapsedForRef.current !== verifyKey) {
            autoCollapsedForRef.current = verifyKey;
            collapseIfAllowed("verified-new-key", true);
          }
        } else {
          verifiedForRef.current = "";
          setModels([]);
          setModelNames({});
          setPanel({
            state: "error",
            provider: label,
            count: 0,
            retryable: !(data.status === 401 || data.status === 403),
          });
          setPanelError(
            data.status === 401 || data.status === 403
              ? { kind: "rejected", provider: label.replace(/ API$/, "") }
              : data.error
                ? { kind: "server", message: String(data.error) }
                : { kind: "invalid" },
          );
        }
      } catch {
        if (cancelled) return;
        verifiedForRef.current = "";
        setPanel({ state: "error", provider: label, count: 0, retryable: true });
        setPanelError({ kind: "offline" });
      }
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [verifyKey, verifyBase, open, retryTick, collapseIfAllowed]);


  const groups = useMemo(() => groupModels(models, modelNames), [models, modelNames]);
  const suggested = useMemo(
    () => suggestions.filter((id) => models.includes(id)),
    [models, suggestions],
  );

  const grouped = useMemo(() => {
    const out: Array<{ group: string; items: ModelEntry[] }> = [];
    const suggestedEntries = filterModels(
      suggested.map((id) => ({ id, label: modelNames[id] ?? id })),
      query,
    );
    if (suggestedEntries.length > 0) out.push({ group: t.apiSuggestedGroup, items: suggestedEntries });

    for (const [group, entries] of Object.entries(groups)) {
      const filtered = filterModels(entries, query);
      // Ids without a provider prefix share one bucket whose label comes from the
      // api-key helper, so it is renamed here to the active language.
      const ungrouped = entries.length > 0 && entries.every((entry) => !entry.id.includes("/"));
      if (filtered.length > 0) out.push({ group: ungrouped ? t.apiOtherGroup : group, items: filtered });
    }
    return out;
  }, [groups, modelNames, query, suggested, t]);

  const chosenLabel = modelNames[config.model] ?? config.model;
  const providerLabel =
    status.provider || (config.apiKey.trim() || config.baseUrl.trim() ? detected.label : t.apiAutoDetect);

  if (!open) return null;

  if (collapsed && status.state === "ok") {
    return (
      <div className="api-panel api-panel-collapsed" data-testid="api-panel">
        <span className="api-panel-dot ok" />
        <strong>{providerLabel}</strong>
        <span className="api-panel-model-name">{chosenLabel || t.apiNoModelChosen}</span>
        <button
          type="button"
          className="api-panel-link"
          onClick={() => rememberCollapsed(false)}
          aria-label={t.apiOpenConfig}
        >
          {t.apiChange}
        </button>
      </div>
    );
  }

  return (
    <div className="api-panel" data-testid="api-panel" ref={panelRef}>
      <div className="api-panel-head">
        <span className="api-panel-title">{t.apiConfigTitle}</span>
        <div className="api-panel-head-right">
          {status.state === "checking" ? (
            <span className="api-panel-status">{t.apiChecking}</span>
          ) : status.state === "ok" ? (
            <span className="api-panel-status ok">
              ● {t.apiConnected(providerLabel, status.count)}
              {status.revalidating ? t.apiRefreshing : ""}
            </span>
          ) : status.state === "error" ? (
            <span className="api-panel-status error">● {status.error}</span>
          ) : null}
          <button type="button" className="api-panel-close" onClick={onClose} aria-label={t.apiCloseConfig}>
            ×
          </button>
        </div>
      </div>

      {status.state === "error" && status.retryable && (
        <button type="button" className="api-panel-retry" onClick={() => setRetryTick((n) => n + 1)}>
          {t.apiRetry}
        </button>
      )}

      <div className="api-panel-row">
        <input
          type={showKey ? "text" : "password"}
          className="api-panel-key"
          placeholder={t.apiKeyPlaceholder}
          value={config.apiKey}
          onChange={(event) => {
            const key = event.target.value;
            const info = analyzeKeyOrInput(key.trim(), config.baseUrl);
            const currentBase = normalizeEndpointUrl(config.baseUrl);
            const knownDefaults = new Set([
              "",
              "https://generativelanguage.googleapis.com/v1beta",
              "https://api.openai.com/v1",
              "https://api.anthropic.com/v1",
              "https://openrouter.ai/api/v1",
              "https://api.deepseek.com/v1",
              "https://api.groq.com/openai/v1",
              "https://api.x.ai/v1",
              "https://api.perplexity.ai",
              "https://api.commandcode.ai/provider/v1",
            ]);
            const baseUrl = knownDefaults.has(currentBase) ? info.defaultBaseUrl : config.baseUrl;
            saveConfig({ ...config, apiKey: key, baseUrl });
            saveCliKey(key);
            setQuery("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") setRetryTick((n) => n + 1);
          }}
          aria-label="API key"
          autoComplete="off"
        />
        <button
          type="button"
          className="api-panel-icon"
          onClick={() => setShowKey((value) => !value)}
          aria-label={showKey ? t.apiHideKey : t.apiShowKey}
          title={showKey ? t.apiHideKey : t.apiShowKey}
        >
          👁
        </button>
        <button
          type="button"
          className="api-panel-icon"
          onClick={async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (!text?.trim()) return;
              const key = text.trim();
              const info = analyzeKeyOrInput(key, config.baseUrl);
              saveConfig({ ...config, apiKey: key, baseUrl: info.defaultBaseUrl });
              saveCliKey(key);
              setRetryTick((n) => n + 1);
            } catch {
              /* clipboard permission denied: nothing to report */
            }
          }}
          aria-label={t.apiPasteClipboard}
          title={t.apiPasteClipboard}
        >
          {t.apiPaste}
        </button>
      </div>

      {models.length > 0 && (
        <div className="api-panel-model-row">
          {models.length > 15 && (
            <input
              type="search"
              className="api-panel-search"
              placeholder={t.apiSearchModelPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t.apiSearchModel}
            />
          )}
          <select
            className="api-panel-model"
            ref={modelSelectRef}
            value={config.model}
            onChange={(event) => {
              saveConfig({ ...config, model: event.target.value });
              if (model !== "custom:api") onModel("custom:api");
              // Choosing a model is a finished action: fold the panel away.
              collapseIfAllowed("picked");
            }}
            aria-label={t.apiChooseModel}
          >
            {config.model && !models.includes(config.model) && (
              <option value={config.model}>{chosenLabel || config.model}</option>
            )}
            {grouped.map(({ group, items }) => (
              <optgroup key={group} label={group}>
                {items.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}

      {status.state === "ok" && (
        <button type="button" className="api-panel-link api-panel-fold" onClick={() => rememberCollapsed(true)}>
          {t.apiCollapse}
        </button>
      )}

      <button
        type="button"
        className="api-panel-advanced-toggle"
        onClick={() => setAdvanced((value) => !value)}
        aria-expanded={advanced}
      >
        {advanced ? t.apiAdvancedHide : t.apiAdvancedShow}
      </button>

      {advanced && (
        <div className="api-panel-advanced">
          <label className="api-panel-field">
            <span>Endpoint URL</span>
            <input
              type="text"
              value={config.baseUrl}
              placeholder={detected.defaultBaseUrl || DEFAULT_BASE}
              onChange={(event) => saveConfig({ ...config, baseUrl: event.target.value })}
              onBlur={(event) =>
                saveConfig({
                  ...config,
                  baseUrl: normalizeEndpointUrl(event.target.value) || detected.defaultBaseUrl,
                })
              }
              aria-label="Endpoint URL"
            />
          </label>
          <p className="api-panel-hint">
            {t.apiCliHintLead}
            <code>user_…</code>
            {t.apiCliHintMiddle}
            <code>cmd login</code>
            {t.apiCliHintTail}
          </p>
        </div>
      )}

      <button
        type="button"
        className="api-panel-help"
        onClick={() => setHelpOpen((value) => !value)}
        aria-expanded={helpOpen}
      >
        {t.apiWhereIsKey}
      </button>
      {helpOpen && (
        <p className="api-panel-hint">
          {t.apiHelpBefore}
          <code>user_…</code>
          {t.apiHelpAfter}
        </p>
      )}
    </div>
  );
}
