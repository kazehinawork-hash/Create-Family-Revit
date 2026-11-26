import { useRef, useState, type CSSProperties } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { ParameterPanel } from "./components/ParameterPanel";
import {
  EmptyParametersPane,
  LibraryModal,
  MobileTabs,
  PanelResizer,
  ParamsFab,
  ThumbnailRenderHost,
  ToastBanner,
} from "./components/StudioChrome";
import { TopBar } from "./components/TopBar";
import { Viewer } from "./components/Viewer";
import { StudioProvider, useStudio } from "./hooks/StudioContext";
import { useDesignChat } from "./hooks/useDesignChat";
import { useLibrary } from "./hooks/useLibrary";
import { useModelState } from "./hooks/useModelState";
import { usePanelLayout } from "./hooks/usePanelLayout";
import { useServerConnection } from "./hooks/useServerConnection";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./hooks/useToast";
import { useI18n } from "./lib/i18n";

export function App() {
  return (
    <StudioProvider>
      <StudioWorkspace />
    </StudioProvider>
  );
}

function StudioWorkspace() {
  const { t, language } = useI18n();
  const { state } = useStudio();
  const [showGrid, setShowGrid] = useState(true);
  const [showPlanes, setShowPlanes] = useState(false);
  const [showConnectors, setShowConnectors] = useState(false);
  const [showHandles, setShowHandles] = useState(false);
  const viewerCaptureRef = useRef<(() => string | null) | null>(null);

  const { toast, setToast } = useToast();
  const { themeMode, setThemeMode, resolvedTheme } = useTheme();
  const layout = usePanelLayout();

  const syncDefaultModelRef = useRef<
    (availableIds: string[], serverDefaultModel?: string | null) => void
  >(() => {});
  const { health, serverOnline, setServerOnline } = useServerConnection((result) => {
    const available = (result.models ?? []).map((entry) => entry.id);
    syncDefaultModelRef.current(available, result.agent?.model);
  });

  const modelState = useModelState({ setToast, setMobileTab: layout.setMobileTab });
  const chat = useDesignChat({ setServerOnline, setToast, setMobileTab: layout.setMobileTab });
  syncDefaultModelRef.current = chat.syncDefaultModel;
  const library = useLibrary({ viewerCaptureRef, setToast });

  const stageMessage = chat.stage
    ? `${chat.stage.message}${chat.elapsedLabel ? ` · ${chat.elapsedLabel}` : ""}`
    : null;
  const agentLabel = health
    ? health.agent.provider === "commandcode"
      ? "cmdc"
      : health.agent.model
    : null;

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
        revitConnected={Boolean(health?.revit?.connected)}
        onExportRfa={() => void modelState.handleExportRfa(Boolean(health?.revit?.connected))}
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

      <MobileTabs mobileTab={layout.mobileTab} onSelect={layout.setMobileTab} t={t} />

      <div
        className={`workspace ${layout.paramsOpen ? "params-open" : ""}`}
        data-tab={layout.mobileTab}
        style={
          {
            "--left-width": `${layout.leftWidth}px`,
            "--right-width": `${layout.rightWidth}px`,
          } as CSSProperties
        }
      >
        <ChatPanel
          entries={state.entries}
          running={chat.running}
          stageMessage={stageMessage}
          stageIssues={chat.stage?.issues}
          onSend={(text, targets) =>
            void chat.handleSend(text, undefined, targets?.length ? { targets } : undefined)
          }
          onStop={chat.handleStop}
          disabled={chat.running || chat.uploading}
          agentReady={health ? health.agent.ready : null}
          agentLabel={agentLabel}
          agentDetail={health?.agent.detail ?? null}
          provider={health?.agent.provider ?? null}
          model={chat.model}
          onModel={chat.handleModel}
          availableModels={health?.models}
          backends={health?.backends}
          onFocusPart={modelState.handleFocusPart}
          partIds={modelState.spec?.parts.map((part) => part.id) ?? []}
          targets={chat.chatTargets}
          onRemoveTarget={chat.handleRemoveTarget}
          focusSignal={chat.chatFocusSignal}
          onHighlightParts={(partIds) => {
            modelState.setHighlightPartIds(partIds);
            layout.setMobileTab("viewer");
          }}
          onUndoSpec={chat.handleUndoSpecEntry}
          attachments={chat.attachments}
          uploading={chat.uploading}
          onAttach={chat.handleAttach}
          onRemoveAttachment={chat.handleRemoveAttachment}
          onRetry={chat.handleRetryLast}
          onAction={chat.handleEntryAction}
          sessionUsage={chat.sessionUsage}
          incomplete={chat.incomplete}
          serverOnline={serverOnline}
        />

        <PanelResizer
          side="left"
          ariaLabel={t.appResizeAgentPanel}
          title={t.resizePanel}
          onPointerDown={layout.beginResize}
          onDoubleClick={layout.resetWidth}
          onNudge={layout.nudgeWidth}
        />

        <Viewer
          model={modelState.previewModel ?? modelState.deferredModel}
          fileName={modelState.spec?.name ?? undefined}
          theme={resolvedTheme}
          skippedCutPartIds={modelState.skippedCutPartIds}
          onCaptureReady={(capture) => {
            viewerCaptureRef.current = capture;
          }}
          onLoadSample={chat.handleLoadSampleChat}
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

        <PanelResizer
          side="right"
          ariaLabel={t.appResizeParamPanel}
          title={t.resizePanel}
          onPointerDown={layout.beginResize}
          onDoubleClick={layout.resetWidth}
          onNudge={layout.nudgeWidth}
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
          <EmptyParametersPane title={t.paramsTab} hint={t.parametersEmpty} />
        )}

        <ParamsFab
          open={layout.paramsOpen}
          onToggle={() => layout.setParamsOpen((current) => !current)}
          label={layout.paramsOpen ? t.closeParams : t.openParams}
          tabLabel={t.paramsTab}
        />
      </div>

      <ToastBanner toast={toast} onDismiss={() => setToast(null)} />
      <LibraryModal library={library} currentModelId={state.currentModelId} />
      <ThumbnailRenderHost thumbJob={library.thumbJob} thumbCaptureRef={library.thumbCaptureRef} />
    </div>
  );
}
