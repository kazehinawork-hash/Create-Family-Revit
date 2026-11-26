import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { migrateSpec, type FamilySpec } from "@family/spec-core";
import { ChatPanel, type ChatEntry } from "./components/ChatPanel";
import { ParameterPanel } from "./components/ParameterPanel";
import { TopBar } from "./components/TopBar";
import { Viewer } from "./components/Viewer";
import { newId, type ToastState } from "./hooks/types";
import { useDesignChat } from "./hooks/useDesignChat";
import { useLibrary } from "./hooks/useLibrary";
import { useModelState } from "./hooks/useModelState";
import {
  fetchHealth,
  fetchSavedModelDetail,
  pingServer,
  type Health,
} from "./lib/api";
import { useI18n } from "./lib/i18n";
import {
  applyTheme,
  readTheme,
  resolveTheme,
  systemPrefersDark,
  writeTheme,
  type ThemeMode,
} from "./lib/theme";

const LibraryPanel = lazy(() =>
  import("./components/LibraryPanel").then((m) => ({ default: m.LibraryPanel })),
);

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

export function App() {
  const { t, formatDate, formatDateTime, formatNumber, language } = useI18n();
  const [entries, setEntries] = useState<ChatEntry[]>([
    { id: "seed", role: "agent", text: t.appChatGreeting },
  ]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [showPlanes, setShowPlanes] = useState(false);
  const [showConnectors, setShowConnectors] = useState(false);
  const [showHandles, setShowHandles] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const serverOnlineRef = useRef<boolean | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readTheme());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const [mobileTab, setMobileTab] = useState<"chat" | "viewer" | "params">("chat");
  const [paramsOpen, setParamsOpen] = useState(false);
  const viewerCaptureRef = useRef<(() => string | null) | null>(null);
  const resolvedTheme = resolveTheme(themeMode, systemDark);

  const [leftWidth, setLeftWidth] = useState(() =>
    readStoredWidth("fa.leftWidth", DEFAULT_LEFT_WIDTH),
  );
  const [rightWidth, setRightWidth] = useState(() =>
    readStoredWidth("fa.rightWidth", DEFAULT_RIGHT_WIDTH),
  );

  const pushEntry = (entry: Omit<ChatEntry, "id">) => {
    setEntries((current) => [...current, { ...entry, id: newId() }]);
  };

  const modelState = useModelState({
    t,
    formatNumber,
    pushEntry,
    setToast,
    setMobileTab,
  });

  const chat = useDesignChat({
    t,
    formatDate,
    formatNumber,
    language,
    spec: modelState.spec,
    specRef: modelState.specRef,
    applySpec: modelState.applySpec,
    setNative: modelState.setNative,
    modelNotes: modelState.modelNotes,
    setModelNotes: modelState.setModelNotes,
    setFocusNote: modelState.setFocusNote,
    setSelectedPartId: modelState.setSelectedPartId,
    setHiddenPartIds: modelState.setHiddenPartIds,
    setTransparentPartIds: modelState.setTransparentPartIds,
    setCurrentModelId,
    setServerOnline,
    setToast,
    setMobileTab,
    pushEntry,
  });

  const library = useLibrary({
    t,
    formatDateTime,
    spec: modelState.spec,
    setSpec: modelState.setSpec,
    applySpec: modelState.applySpec,
    entries,
    setEntries,
    modelNotes: modelState.modelNotes,
    setModelNotes: modelState.setModelNotes,
    setFocusNote: modelState.setFocusNote,
    setChatTargets: chat.setChatTargets,
    currentModelId,
    setCurrentModelId,
    handleLod: chat.handleLod,
    viewerCaptureRef,
    setToast,
  });

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

  useEffect(() => {
    storeWidth("fa.leftWidth", leftWidth);
  }, [leftWidth]);

  useEffect(() => {
    storeWidth("fa.rightWidth", rightWidth);
  }, [rightWidth]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.action ? 6000 : 9000);
    return () => clearTimeout(timer);
  }, [toast]);

  const { syncDefaultModel } = chat;
  const applyHealth = useCallback(
    (result: Health) => {
      setHealth(result);
      const available = (result.models ?? []).map((entry) => entry.id);
      syncDefaultModel(available, result.agent?.model);
    },
    [syncDefaultModel],
  );

  const refreshHealth = useCallback(async () => {
    const result = await fetchHealth();
    if (result) applyHealth(result);
    return result;
  }, [applyHealth]);

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

  return (
    <div className="app" lang={language}>
      <TopBar
        name={modelState.spec?.name ?? t.noFamily}
        category={modelState.spec?.category ?? t.noFamilyHint}
        hasSpec={Boolean(modelState.spec)}
        reviewed={Boolean(modelState.analysis?.ok)}
        native={modelState.native}
        running={chat.running}
        agentStage={chat.stage?.stage ?? null}
        elapsed={chat.elapsedLabel}
        units={modelState.units}
        onUnits={modelState.setUnits}
        revitVersion={modelState.revitVersion}
        onRevitVersion={modelState.setRevitVersion}
        lod={chat.lod}
        onLod={chat.handleLod}
        onBuild={modelState.handleBuild}
        onExportPortable={modelState.handleExportPortable}
        exportingPortable={modelState.exportingPortable}
        canBuild={Boolean(modelState.analysis?.ok)}
        building={modelState.building}
        onSaveModel={library.handleSaveModel}
        onSaveModelAs={library.handleSaveModelAs}
        onUndo={modelState.undoSpec}
        onRedo={modelState.redoSpec}
        canUndo={modelState.canUndo}
        canRedo={modelState.canRedo}
        onOpenLibrary={library.handleOpenLibrary}
        onNewModel={library.handleNewModel}
        onLoadDemo={chat.handleLoadDemo}
        theme={themeMode}
        onTheme={setThemeMode}
      />

      <nav className="mobile-tabs" role="tablist" aria-label={t.appWorkspaceTabs}>
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
          running={chat.running}
          stageMessage={
            chat.stage
              ? `${chat.stage.message}${chat.elapsedLabel ? ` · ${chat.elapsedLabel}` : ""}`
              : null
          }
          stageIssues={chat.stage?.issues}
          onSend={(text, targets) =>
            void chat.handleSend(text, undefined, targets?.length ? { targets } : undefined)
          }
          onStop={chat.handleStop}
          disabled={chat.running || chat.uploading}
          agentReady={health ? health.agent.ready : null}
          agentLabel={
            health ? (health.agent.provider === "commandcode" ? "cmdc" : health.agent.model) : null
          }
          agentDetail={health?.agent.detail ?? null}
          provider={health?.agent.provider ?? null}
          model={chat.model}
          onModel={chat.handleModel}
          availableModels={health?.models}
          backends={health?.backends}
          onFocusPart={modelState.handleFocusPart}
          partIds={modelState.spec?.parts.map((part) => part.id) ?? []}
          targets={chat.chatTargets}
          onRemoveTarget={(index) =>
            chat.setChatTargets((current) => current.filter((_, position) => position !== index))
          }
          focusSignal={chat.chatFocusSignal}
          onHighlightParts={(partIds) => {
            modelState.setHighlightPartIds(partIds);
            setMobileTab("viewer");
          }}
          onUndoSpec={(snapshot) => {
            modelState.applySpec(snapshot);
            modelState.setNative(false);
          }}
          attachments={chat.attachments}
          uploading={chat.uploading}
          onAttach={chat.handleAttach}
          onRemoveAttachment={chat.handleRemoveAttachment}
          onRetry={() => {
            if (chat.lastPromptRef.current) {
              void chat.handleSend(chat.lastPromptRef.current, undefined, {
                targets: chat.lastTargetsRef.current,
                noteIds: chat.lastNoteIdsRef.current,
              });
            }
          }}
          onAction={(action) => {
            if (action.kind === "fresh") {
              if (chat.lastPromptRef.current) {
                void chat.handleSend(chat.lastPromptRef.current, undefined, {
                  fresh: true,
                  targets: chat.lastTargetsRef.current,
                  noteIds: chat.lastNoteIdsRef.current,
                });
              }
              return;
            }
            if (action.kind === "use-sample" && action.sampleId) {
              void (async () => {
                const loaded = await fetchSavedModelDetail(action.sampleId!);
                const rawSample = loaded?.spec ?? null;
                if (!rawSample) return;
                const sampleSpec = migrateSpec(rawSample).spec as unknown as FamilySpec;
                modelState.applySpec(sampleSpec);
                void chat.handleSend(chat.lastPromptRef.current, sampleSpec);
              })();
              return;
            }
            if (chat.lastPromptRef.current) void chat.handleSend(chat.lastPromptRef.current);
          }}
          sessionUsage={chat.sessionUsage}
          incomplete={chat.incomplete}
          serverOnline={serverOnline}
        />

        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t.appResizeAgentPanel}
          tabIndex={0}
          title={t.resizePanel}
          onPointerDown={(event) => beginResize("left", event)}
          onDoubleClick={() => setLeftWidth(DEFAULT_LEFT_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            nudgeWidth("left", event.key);
          }}
        />

        <Viewer
          model={modelState.previewModel ?? modelState.deferredModel}
          fileName={modelState.spec?.name ?? undefined}
          theme={resolvedTheme}
          skippedCutPartIds={modelState.skippedCutPartIds}
          onCaptureReady={(capture) => {
            viewerCaptureRef.current = capture;
          }}
          onLoadSample={() => {
            if (chat.running) return;
            void chat.handleSend(t.chatSuggestion1);
          }}
          parameters={modelState.deferredParameters}
          materials={modelState.spec?.materials ?? []}
          units={modelState.units}
          showGrid={showGrid}
          onToggleGrid={() => setShowGrid((current) => !current)}
          showPlanes={showPlanes}
          onTogglePlanes={() => setShowPlanes((current) => !current)}
          showConnectors={showConnectors}
          onToggleConnectors={() => setShowConnectors((current) => !current)}
          showHandles={showHandles}
          onToggleHandles={() => setShowHandles((current) => !current)}
          selectedPartId={modelState.selectedPartId}
          onSelectPart={modelState.setSelectedPartId}
          onSendPartsToChat={chat.handleSendPartsToChat}
          notes={modelState.modelNotes}
          onAddNote={modelState.handleAddNote}
          onFocusNote={modelState.handleFocusNote}
          focusNote={modelState.focusNote}
          hiddenPartIds={modelState.hiddenPartIds}
          onToggleHidePart={modelState.handleToggleHidePart}
          onUnhideAll={modelState.handleUnhideAll}
          transparentPartIds={modelState.transparentPartIds}
          onToggleTransparentPart={modelState.handleToggleTransparentPart}
          onResetTransparent={modelState.handleResetTransparent}
          issuePartIds={modelState.issuePartIds}
          highlightPartIds={modelState.highlightPartIds}
          focusPartId={modelState.focusPartId}
          onUpdateParameter={modelState.handleUpdateParameter}
        />

        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t.appResizeParamPanel}
          tabIndex={0}
          title={t.resizePanel}
          onPointerDown={(event) => beginResize("right", event)}
          onDoubleClick={() => setRightWidth(DEFAULT_RIGHT_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            nudgeWidth("right", event.key);
          }}
        />

        {modelState.spec && modelState.analysis ? (
          <ParameterPanel
            spec={modelState.spec}
            analysis={modelState.analysis}
            units={modelState.units}
            selectedPartId={modelState.selectedPartId}
            onSelectPart={modelState.setSelectedPartId}
            hiddenPartIds={modelState.hiddenPartIds}
            onToggleHidePart={modelState.handleToggleHidePart}
            transparentPartIds={modelState.transparentPartIds}
            onToggleTransparentPart={modelState.handleToggleTransparentPart}
            onIsolatePart={modelState.handleIsolatePart}
            issuePartIds={modelState.issuePartIds}
            onUpdateParameter={modelState.handleUpdateParameter}
            notes={modelState.modelNotes}
            notesSending={chat.running}
            onFocusNote={modelState.handleFocusNote}
            onUpdateNote={modelState.handleUpdateNote}
            onDeleteNote={modelState.handleDeleteNote}
            onToggleNoteResolved={modelState.handleToggleNoteResolved}
            onSendNote={chat.handleSendNote}
            onSendAllNotes={chat.handleSendAllNotes}
            onAddParameter={modelState.handleAddParameter}
            onHighlightParts={modelState.setHighlightPartIds}
            onUpdateConnectorHost={modelState.handleUpdateConnectorHost}
            types={modelState.spec.types ?? []}
            onChangeTypes={modelState.handleChangeTypes}
            onPreviewType={modelState.handlePreviewType}
            onExportTypes={modelState.handleExportTypes}
            exportingTypes={modelState.exportingTypes}
            previewTypeActive={Boolean(modelState.previewTypeValues)}
          />
        ) : (
          <section className="pane right">
            <div className="pane-header">{t.paramsTab}</div>
            <div className="pane-empty">
              <svg
                width="34"
                height="34"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              >
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
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M4 7h16M4 12h10M4 17h6" />
          </svg>
          <span>{t.paramsTab}</span>
        </button>
      </div>

      {toast && (
        <div className={`toast ${toast.tone === "error" ? "error" : ""}`} role="status">
          {toast.text}
          {toast.sub && <span className="sub">{toast.sub}</span>}
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                toast.action?.onClick();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}

      {library.libraryOpen && (
        <Suspense fallback={null}>
          <LibraryPanel
            models={library.savedList}
            groups={library.libraryGroups}
            loading={library.libraryLoading}
            currentModelId={currentModelId}
            activeGroup={library.libraryGroup}
            historyModelId={library.historyModelId}
            revisions={library.revisions}
            revisionsLoading={library.revisionsLoading}
            historyKeep={library.historyKeep}
            onClose={() => {
              library.setLibraryOpen(false);
              library.setHistoryModelId(null);
            }}
            onActiveGroup={library.setLibraryGroup}
            onLoadModel={(id) => void library.handleLoadModel(id)}
            onNewModel={library.handleNewModel}
            onOpenHistory={(id) => void library.handleOpenHistory(id)}
            onCloseHistory={() => library.setHistoryModelId(null)}
            onRestoreRevision={(stamp) => void library.handleRestoreRevision(stamp)}
            onRenameModel={(id, name) => void library.handleRenameModel(id, name)}
            onDeleteModel={(id) => void library.handleDeleteModel(id)}
            onCreateGroup={(name) => void library.handleCreateGroup(name)}
            onRenameGroup={(from, to) => void library.handleRenameGroup(from, to)}
            onDeleteGroup={(name) => void library.handleDeleteGroup(name)}
            onMoveModel={(id, group) => void library.handleMoveModel(id, group)}
            trashItems={library.trashItems}
            onRestoreTrash={(id) => void library.handleRestoreTrash(id)}
            onPurgeTrash={(id) => void library.handlePurgeTrash(id)}
            onEmptyTrash={() => void library.handleEmptyTrash()}
          />
        </Suspense>
      )}

      {library.thumbJob && (
        <div className="thumb-render-host" aria-hidden="true">
          <Viewer
            model={library.thumbJob.model}
            parameters={library.thumbJob.parameters}
            materials={library.thumbJob.materials}
            units="mm"
            theme="light"
            showGrid={false}
            onToggleGrid={() => {}}
            showPlanes={false}
            showConnectors={false}
            showHandles={false}
            fileName={`${library.thumbJob.id}.jpg`}
            onCaptureReady={(capture) => {
              library.thumbCaptureRef.current = capture;
            }}
          />
        </div>
      )}
    </div>
  );
}
