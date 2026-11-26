import { lazy, Suspense, type MutableRefObject, type PointerEvent } from "react";
import type { useLibrary } from "../hooks/useLibrary";
import type { ThumbJob, ToastState } from "../hooks/types";
import type { Strings } from "../lib/strings";
import { Viewer } from "./Viewer";

const LibraryPanel = lazy(() =>
  import("./LibraryPanel").then((m) => ({ default: m.LibraryPanel })),
);

interface PanelResizerProps {
  side: "left" | "right";
  ariaLabel: string;
  title: string;
  onPointerDown: (side: "left" | "right", event: PointerEvent) => void;
  onDoubleClick: (side: "left" | "right") => void;
  onNudge: (side: "left" | "right", key: "ArrowLeft" | "ArrowRight") => void;
}

export function PanelResizer({
  side,
  ariaLabel,
  title,
  onPointerDown,
  onDoubleClick,
  onNudge,
}: PanelResizerProps) {
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      title={title}
      onPointerDown={(event) => onPointerDown(side, event)}
      onDoubleClick={() => onDoubleClick(side)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onNudge(side, event.key);
      }}
    />
  );
}

interface MobileTabsProps {
  mobileTab: "chat" | "viewer" | "params";
  onSelect: (tab: "chat" | "viewer" | "params") => void;
  t: Strings;
}

export function MobileTabs({ mobileTab, onSelect, t }: MobileTabsProps) {
  const tabs = [
    ["chat", t.chatTab],
    ["viewer", t.viewerTab],
    ["params", t.paramsTab],
  ] as const;

  return (
    <nav className="mobile-tabs" role="tablist" aria-label={t.appWorkspaceTabs}>
      {tabs.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={mobileTab === key}
          className={mobileTab === key ? "active" : ""}
          onClick={() => onSelect(key)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

export function EmptyParametersPane({ title, hint }: { title: string; hint: string }) {
  return (
    <section className="pane right">
      <div className="pane-header">{title}</div>
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
        <p>{hint}</p>
      </div>
    </section>
  );
}

interface ParamsFabProps {
  open: boolean;
  onToggle: () => void;
  label: string;
  tabLabel: string;
}

export function ParamsFab({ open, onToggle, label, tabLabel }: ParamsFabProps) {
  return (
    <button
      type="button"
      className="params-fab"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={label}
      title={label}
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
      <span>{tabLabel}</span>
    </button>
  );
}

export function ToastBanner({
  toast,
  onDismiss,
}: {
  toast: ToastState | null;
  onDismiss: () => void;
}) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.tone === "error" ? "error" : ""}`} role="status">
      {toast.text}
      {toast.sub && <span className="sub">{toast.sub}</span>}
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action?.onClick();
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

export function ThumbnailRenderHost({
  thumbJob,
  thumbCaptureRef,
}: {
  thumbJob: ThumbJob | null;
  thumbCaptureRef: MutableRefObject<(() => string | null) | null>;
}) {
  if (!thumbJob) return null;
  return (
    <div className="thumb-render-host" aria-hidden="true">
      <Viewer
        model={thumbJob.model}
        parameters={thumbJob.parameters}
        materials={thumbJob.materials}
        units="mm"
        theme="light"
        showGrid={false}
        onToggleGrid={() => {}}
        showPlanes={false}
        showConnectors={false}
        showHandles={false}
        fileName={`${thumbJob.id}.jpg`}
        onCaptureReady={(capture) => {
          thumbCaptureRef.current = capture;
        }}
      />
    </div>
  );
}

export function LibraryModal({
  library,
  currentModelId,
}: {
  library: ReturnType<typeof useLibrary>;
  currentModelId: string | null;
}) {
  if (!library.libraryOpen) return null;
  return (
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
  );
}
