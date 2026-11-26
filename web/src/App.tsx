import { lazy, Suspense, useRef, useState, type CSSProperties } from "react";
import { migrateSpec, type FamilySpec } from "@family/spec-core";
import { ChatPanel, type ChatEntry } from "./components/ChatPanel";
import { ParameterPanel } from "./components/ParameterPanel";
import { TopBar } from "./components/TopBar";
import { Viewer } from "./components/Viewer";
import { newId } from "./hooks/types";
import { useDesignChat } from "./hooks/useDesignChat";
import { useLibrary } from "./hooks/useLibrary";
import { useModelState } from "./hooks/useModelState";
import { usePanelLayout } from "./hooks/usePanelLayout";
import { useServerConnection } from "./hooks/useServerConnection";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./hooks/useToast";
import { fetchSavedModelDetail } from "./lib/api";
import { useI18n } from "./lib/i18n";

const LibraryPanel = lazy(() =>
  import("./components/LibraryPanel").then((m) => ({ default: m.LibraryPanel })),
);

export function App() {
  const { t, formatDate, formatDateTime, formatNumber, language } = useI18n();
  const [entries, setEntries] = useState<ChatEntry[]>([
    { id: "seed", role: "agent", text: t.appChatGreeting },
  ]);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [showPlanes, setShowPlanes] = useState(false);
  const [showConnectors, setShowConnectors] = useState(false);
  const [showHandles, setShowHandles] = useState(false);
  const viewerCaptureRef = useRef<(() => string | null) | null>(null);

  const { toast, setToast } = useToast();
  const { themeMode, setThemeMode, resolvedTheme } = useTheme();
  const {
    mobileTab,
    setMobileTab,
    paramsOpen,
    setParamsOpen,
    leftWidth,
    rightWidth,
    beginResize,
    nudgeWidth,
    resetWidth,
  } = usePanelLayout();

  const pushEntry = (entry: Omit<ChatEntry, "id">) => {
    setEntries((current) => [...current, { ...entry, id: newId() }]);
  };

  const syncDefaultModelRef = useRef<(availableIds: string[], serverDefaultModel?: string | null) => void>(
    () => {},
  );
  const { health, serverOnline, setServerOnline } = useServerConnection((result) => {
    const available = (result.models ?? []).map((entry) => entry.id);
    syncDefaultModelRef.current(available, result.agent?.model);
  });

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
  syncDefaultModelRef.current = chat.syncDefaultModel;

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
          onDoubleClick={() => resetWidth("left")}
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
          onDoubleClick={() => resetWidth("right")}
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
