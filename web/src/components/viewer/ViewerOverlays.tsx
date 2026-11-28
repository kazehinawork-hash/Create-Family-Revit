import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ResolvedModel } from "@family/spec-core";
import type { ChatTarget, ModelNote, NoteDraft } from "../../lib/annotations";
import type { Units } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { DISPLAY_MODE_OPTIONS } from "./displayMode";
import type {
  ActiveHandleState,
  ContextMenuState,
  NoteComposerState,
  SectionCustomState,
  ViewerDisplayMode,
} from "./types";

interface ViewerOverlaysProps {
  model: ResolvedModel | null;
  units: Units;
  dims: string | null;
  showGrid: boolean;
  onToggleGrid: () => void;
  shadowsEnabled: boolean;
  setShadowsEnabled: Dispatch<SetStateAction<boolean>>;
  displayMode: ViewerDisplayMode;
  setDisplayMode: Dispatch<SetStateAction<ViewerDisplayMode>>;
  showSilhouettes: boolean;
  setShowSilhouettes: Dispatch<SetStateAction<boolean>>;
  showPlanes: boolean;
  onTogglePlanes?: () => void;
  toolsMenuOpen: boolean;
  setToolsMenuOpen: Dispatch<SetStateAction<boolean>>;
  sectionAxis: "off" | "x" | "y" | "z" | "custom";
  setSectionAxis: Dispatch<SetStateAction<"off" | "x" | "y" | "z" | "custom">>;
  setSectionT: Dispatch<SetStateAction<number>>;
  sectionCustom: SectionCustomState | null;
  setSectionCustom: Dispatch<SetStateAction<SectionCustomState | null>>;
  pickingSection: boolean;
  setPickingSection: Dispatch<SetStateAction<boolean>>;
  sectionFill: boolean;
  setSectionFill: Dispatch<SetStateAction<boolean>>;
  sectionMm: { value: number; range: number } | null;
  applySectionMm: (value: number) => void;
  measuring: boolean;
  setMeasuring: Dispatch<SetStateAction<boolean>>;
  detailLevel: "coarse" | "medium" | "fine";
  setDetailLevel: Dispatch<SetStateAction<"coarse" | "medium" | "fine">>;
  showConnectors: boolean;
  onToggleConnectors?: () => void;
  turntableActive: boolean;
  setTurntableActive: Dispatch<SetStateAction<boolean>>;
  dimOthers: boolean;
  setDimOthers: Dispatch<SetStateAction<boolean>>;
  explodeOpen: boolean;
  setExplodeOpen: Dispatch<SetStateAction<boolean>>;
  explode: number;
  setExplode: Dispatch<SetStateAction<number>>;
  showDimensions: boolean;
  setShowDimensions: Dispatch<SetStateAction<boolean>>;
  hiddenPartIds: string[];
  transparentPartIds: string[];
  onToggleHidePart?: (partId: string) => void;
  onUnhideAll?: () => void;
  onToggleTransparentPart?: (partId: string) => void;
  onResetTransparent?: () => void;
  onSelectPart?: (partId: string | null) => void;
  onSendPartsToChatRef: MutableRefObject<((targets: ChatTarget[]) => void) | undefined>;
  onAddNote?: (draft: NoteDraft) => void;
  onFocusNoteRef: MutableRefObject<((note: ModelNote) => void) | undefined>;
  onLoadSample?: () => void;
  fit: () => void;
  saveImage: () => void;
  hoverInfo: { x: number; y: number; name: string } | null;
  measureLabel: string | null;
  measureCount: number;
  clearMeasurements: () => void;
  cubeHostRef: RefObject<HTMLDivElement | null>;
  activeHandle: ActiveHandleState | null;
  notes: ModelNote[];
  notePinRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
  noteComposer: NoteComposerState | null;
  setNoteComposer: Dispatch<SetStateAction<NoteComposerState | null>>;
  contextMenu: ContextMenuState | null;
  setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
  pickedPartIds: string[];
  selectedPartId?: string | null;
  animatingPartName: string | null;
  visiblePartCount: number;
}

export function ViewerOverlays({
  model,
  units,
  dims,
  showGrid,
  onToggleGrid,
  shadowsEnabled,
  setShadowsEnabled,
  displayMode,
  setDisplayMode,
  showSilhouettes,
  setShowSilhouettes,
  showPlanes,
  onTogglePlanes,
  toolsMenuOpen,
  setToolsMenuOpen,
  sectionAxis,
  setSectionAxis,
  setSectionT,
  sectionCustom,
  setSectionCustom,
  pickingSection,
  setPickingSection,
  sectionFill,
  setSectionFill,
  sectionMm,
  applySectionMm,
  measuring,
  setMeasuring,
  detailLevel,
  setDetailLevel,
  showConnectors,
  onToggleConnectors,
  turntableActive,
  setTurntableActive,
  dimOthers,
  setDimOthers,
  explodeOpen,
  setExplodeOpen,
  explode,
  setExplode,
  showDimensions,
  setShowDimensions,
  hiddenPartIds,
  transparentPartIds,
  onToggleHidePart,
  onUnhideAll,
  onToggleTransparentPart,
  onResetTransparent,
  onSelectPart,
  onSendPartsToChatRef,
  onAddNote,
  onFocusNoteRef,
  onLoadSample,
  fit,
  saveImage,
  hoverInfo,
  measureLabel,
  measureCount,
  clearMeasurements,
  cubeHostRef,
  activeHandle,
  notes,
  notePinRefs,
  noteComposer,
  setNoteComposer,
  contextMenu,
  setContextMenu,
  pickedPartIds,
  selectedPartId,
  animatingPartName,
  visiblePartCount,
}: ViewerOverlaysProps) {
  const { t, formatNumber } = useI18n();
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const displayMenuRef = useRef<HTMLDivElement>(null);
  const displayBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!displayMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (displayMenuRef.current?.contains(target) || displayBtnRef.current?.contains(target))
      ) {
        return;
      }
      setDisplayMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDisplayMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [displayMenuOpen]);

  const displayModeLabel: Record<ViewerDisplayMode, string> = {
    shaded: t.viewerModeShaded,
    shadedEdges: t.viewerModeShadedEdges,
    hiddenLine: t.viewerModeHiddenLine,
    wireframe: t.viewerModeWireframe,
  };

  return (
    <>
      <div className="viewer-tools">
        <button type="button" className="tool tool-primary" onClick={fit} title={t.fitView}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
          </svg>
          <span className="tool-label">{t.fitView}</span>
        </button>
        <button
          type="button"
          className={`tool ${showGrid ? "active" : ""}`}
          aria-pressed={showGrid}
          onClick={onToggleGrid}
          title={t.grid}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M2 2h12v12H2zM2 6h12M2 10h12M6 2v12M10 2v12" />
          </svg>
          <span className="tool-label">{t.grid}</span>
        </button>
        <button
          type="button"
          className={`tool ${shadowsEnabled ? "active" : ""}`}
          aria-pressed={shadowsEnabled}
          onClick={() => setShadowsEnabled((curr) => !curr)}
          title={t.shadows}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <circle cx="8" cy="7" r="3" />
            <path d="M8 1v1.6M8 11.4V13M2 7h1.6M12.4 7H14M3.8 2.8l1.1 1.1M10.5 9.5l1.1 1.1M12.2 2.8l-1.1 1.1M5.1 9.5l-1.1 1.1" />
          </svg>
          <span className="tool-label">{t.shadows}</span>
        </button>
        {onTogglePlanes && (
          <button
            type="button"
            className={`tool ${showPlanes ? "active" : ""}`}
            aria-pressed={showPlanes}
            onClick={onTogglePlanes}
            title={t.refPlanes}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path strokeDasharray="3 2" d="M8 1v14M1 8h14" />
            </svg>
          </button>
        )}
        <button
          ref={displayBtnRef}
          type="button"
          className={`tool tool-primary ${displayMenuOpen || displayMode !== "shadedEdges" ? "active" : ""}`}
          data-testid="viewer-display-mode-btn"
          onClick={() => {
            setToolsMenuOpen(false);
            setDisplayMenuOpen((current) => !current);
          }}
          title={`${t.viewerDisplayMode}: ${displayModeLabel[displayMode]}`}
          aria-expanded={displayMenuOpen}
          aria-haspopup="menu"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M8 1.5 14 4.8v6.4L8 14.5 2 11.2V4.8z" />
            <path d="M8 1.5v6.5m0 0 6-3.2M8 8 2 4.8" />
          </svg>
          <span className="tool-label">{displayModeLabel[displayMode]}</span>
        </button>
        <button
          type="button"
          className={`tool ${showSilhouettes ? "active" : ""}`}
          aria-pressed={showSilhouettes}
          data-testid="viewer-silhouettes-btn"
          onClick={() => setShowSilhouettes((curr) => !curr)}
          title={t.viewerSilhouettesHint}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
            <rect x="5" y="5" width="6" height="6" rx="1" strokeWidth="1" opacity="0.6" />
          </svg>
          <span className="tool-label">{t.viewerSilhouettes}</span>
        </button>
        <button
          type="button"
          className="tool viewer-tools-more"
          onClick={() => {
            setDisplayMenuOpen(false);
            setToolsMenuOpen((current) => !current);
          }}
          title={t.moreViewerTools}
          aria-expanded={toolsMenuOpen}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <circle cx="5" cy="12" r="1.2" />
            <circle cx="12" cy="12" r="1.2" />
            <circle cx="19" cy="12" r="1.2" />
          </svg>
        </button>
        <button
          type="button"
          className={`tool tool-primary ${sectionAxis !== "off" ? "active" : ""}`}
          aria-pressed={sectionAxis !== "off"}
          onClick={() => {
            if (sectionAxis === "off") {
              setSectionT(1);
              setSectionAxis("x");
            } else {
              setSectionAxis("off");
              setPickingSection(false);
            }
          }}
          title={t.section}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 7l9-4 9 4-9 4-9-4z" />
            <path d="M3 12l9 4 9-4M3 17l9 4 9-4" />
          </svg>
          <span className="tool-label">{t.section}</span>
        </button>
        <button
          type="button"
          className={`tool tool-primary ${measuring ? "active" : ""}`}
          aria-pressed={measuring}
          onClick={() => setMeasuring((current) => !current)}
          title={t.measure}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 15 15 3l6 6L9 21l-6-6z" />
            <path d="M7 11l2 2M10 8l2 2M13 5l2 2" />
          </svg>
          <span className="tool-label">{t.measure}</span>
        </button>
        <span className="tool-sep" aria-hidden="true" />
        <button
          type="button"
          className={`tool tool-primary ${detailLevel === "coarse" ? "active" : ""}`}
          aria-pressed={detailLevel === "coarse"}
          onClick={() => setDetailLevel((cur) => (cur === "coarse" ? "fine" : "coarse"))}
          title={detailLevel === "coarse" ? t.viewerToFine : t.viewerToCoarse}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 21V9" />
          </svg>
          <span className="tool-label">{detailLevel === "coarse" ? t.coarse : t.fine}</span>
        </button>
        {onToggleConnectors && (
          <button
            type="button"
            className={`tool tool-primary ${showConnectors ? "active" : ""}`}
            aria-pressed={showConnectors}
            onClick={onToggleConnectors}
            title={t.connectorsTooltip}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 4v8M5 7l3-3 3 3" />
            </svg>
            <span className="tool-label">{t.connectors}</span>
          </button>
        )}
        <button
          type="button"
          className={`tool ${turntableActive ? "active" : ""}`}
          aria-pressed={turntableActive}
          onClick={() => setTurntableActive((curr) => !curr)}
          title={t.viewerTurntableHint}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
          </svg>
          <span className="tool-label">360°</span>
        </button>
        <button
          type="button"
          className={`tool ${dimOthers ? "active" : ""}`}
          aria-pressed={dimOthers}
          onClick={() => setDimOthers((current) => !current)}
          title={t.dimOthers}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="8" cy="8" r="5.5" strokeDasharray="3 2" />
            <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
          </svg>
          <span className="tool-label">{t.dimOthers}</span>
        </button>
        <button
          type="button"
          className={`tool ${explodeOpen ? "active" : ""}`}
          onClick={() => {
            setExplodeOpen((current) => !current);
            if (explodeOpen) setExplode(0);
          }}
          title={t.explode}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.5 3.5M14.9 14.9l3.5 3.5M18.4 5.6l-3.5 3.5M9.1 14.9l-3.5 3.5" />
          </svg>
          <span className="tool-label">{t.explode}</span>
        </button>
        <button
          type="button"
          className={`tool ${showDimensions ? "active" : ""}`}
          aria-pressed={showDimensions}
          onClick={() => setShowDimensions((current) => !current)}
          title={t.dimensions}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 17h18M3 14v6M21 14v6M7 20l-4-3 4-3M17 20l4-3-4-3" />
          </svg>
          <span className="tool-label">{t.dimensions}</span>
        </button>
        <button type="button" className="tool" onClick={saveImage} title={t.saveImage}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8.5" cy="9.5" r="1.5" />
            <path d="m4 17 5-5 4 4 3-3 4 4" />
          </svg>
          <span className="tool-label">{t.saveImage}</span>
        </button>
        {hiddenPartIds.length > 0 && onUnhideAll && (
          <button
            type="button"
            className="tool unhide-all-btn"
            onClick={onUnhideAll}
            title={t.viewerUnhideAllHint}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span className="tool-label">{t.viewerUnhideCount(formatNumber(hiddenPartIds.length))}</span>
          </button>
        )}
      </div>

      {explodeOpen && (
        <div className="viewer-explode-panel floating">
          <span>
            {t.explode} · {formatNumber(explode)}%
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={explode}
            aria-label={t.explode}
            onChange={(event) => setExplode(Number(event.target.value))}
          />
        </div>
      )}

      {displayMenuOpen && (
        <div
          ref={displayMenuRef}
          className="viewer-display-menu"
          role="menu"
          aria-label={t.viewerDisplayMode}
          data-testid="viewer-display-menu"
        >
          <div className="viewer-display-menu-head">{t.viewerDisplayMode}</div>
          {DISPLAY_MODE_OPTIONS.map((mode) => {
            const active = displayMode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                data-testid={`viewer-display-option-${mode}`}
                className={active ? "active" : ""}
                onClick={() => {
                  setDisplayMode(mode);
                  setDisplayMenuOpen(false);
                }}
              >
                <span>{displayModeLabel[mode]}</span>
                {active && <span aria-hidden="true">✓</span>}
              </button>
            );
          })}
          <div className="viewer-display-menu-sep" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={showSilhouettes}
            data-testid="viewer-display-silhouettes-item"
            className={showSilhouettes ? "active" : ""}
            onClick={() => setShowSilhouettes((curr) => !curr)}
          >
            <span>{t.viewerSilhouettes}</span>
            {showSilhouettes && <span aria-hidden="true">✓</span>}
          </button>
        </div>
      )}

      {toolsMenuOpen && (
        <div className="viewer-more-menu">
          <button type="button" onClick={() => { setToolsMenuOpen(false); onToggleGrid(); }}>
            {t.grid}
          </button>
          <button type="button" onClick={() => { setToolsMenuOpen(false); setShadowsEnabled((v) => !v); }}>
            {t.shadows}
          </button>
          <button type="button" onClick={() => { setToolsMenuOpen(false); setShowSilhouettes((v) => !v); }}>
            {t.viewerSilhouettes}
          </button>
          {onTogglePlanes && (
            <button type="button" onClick={() => { setToolsMenuOpen(false); onTogglePlanes(); }}>
              {t.refPlanes}
            </button>
          )}
          <button type="button" onClick={() => { setToolsMenuOpen(false); setTurntableActive((v) => !v); }}>
            {t.turnaround}
          </button>
          <button type="button" onClick={() => { setToolsMenuOpen(false); setDimOthers((v) => !v); }}>
            {t.dimOthers}
          </button>
          <button type="button" onClick={() => { setToolsMenuOpen(false); setExplodeOpen(true); }}>
            {t.explode}
          </button>
          <button type="button" onClick={() => { setToolsMenuOpen(false); setShowDimensions((v) => !v); }}>
            {t.dimensions}
          </button>
          <button type="button" onClick={() => { setToolsMenuOpen(false); saveImage(); }}>
            {t.saveImage}
          </button>
          {hiddenPartIds.length > 0 && onUnhideAll && (
            <button type="button" onClick={() => { setToolsMenuOpen(false); onUnhideAll(); }}>
              {t.unhideAll}
            </button>
          )}
        </div>
      )}

      {sectionAxis !== "off" && (
        <div className="section-card">
          <div className="section-card-head">
            <span>{t.section}</span>
            <button
              type="button"
              className="modal-close"
              onClick={() => setSectionAxis("off")}
              aria-label={t.viewerCloseSection}
            >
              ×
            </button>
          </div>
          <div className="section-axis">
            {(["x", "y", "z"] as const).map((axis) => (
              <button
                key={axis}
                type="button"
                className={sectionAxis === axis ? "active" : ""}
                onClick={() => {
                  setSectionAxis(axis);
                  setPickingSection(false);
                  setSectionT(1);
                }}
              >
                {axis.toUpperCase()}
              </button>
            ))}
            <button
              type="button"
              className={sectionAxis === "custom" ? "active" : ""}
              onClick={() => setPickingSection(true)}
              title={t.viewerPickSection}
            >
              ⌖
            </button>
          </div>

          <label
            className="section-fill-toggle"
            title={model && model.parts.length >= 200 ? t.viewerSectionFillDisabled : t.sectionFill}
          >
            <input
              type="checkbox"
              checked={sectionFill}
              disabled={Boolean(model && model.parts.length >= 200)}
              onChange={(event) => setSectionFill(event.target.checked)}
            />
            <span>{t.sectionFill}</span>
          </label>

          {pickingSection && <div className="section-hint">{t.viewerPickSectionHint}</div>}

          {sectionAxis === "custom" && sectionCustom && (
            <button
              type="button"
              className="section-flip"
              onClick={() =>
                setSectionCustom((current) =>
                  current ? { ...current, normal: current.normal.clone().negate() } : current,
                )
              }
            >
              {t.viewerFlipSection}
            </button>
          )}

          <div className="section-value">
            <input
              type="number"
              step={10}
              value={sectionMm?.value ?? 0}
              onChange={(event) => applySectionMm(Number(event.target.value))}
              disabled={!sectionMm}
              aria-label={t.viewerSectionPosition}
            />
            <span>mm</span>
          </div>
          <div className="section-tip">{t.viewerSectionTip}</div>
        </div>
      )}

      {model && dims && <div className="viewer-dims">{dims}</div>}

      {hoverInfo && (
        <div className="viewer-hover-tip" style={{ left: hoverInfo.x + 14, top: hoverInfo.y + 14 }}>
          {hoverInfo.name}
        </div>
      )}

      {measuring && !measureLabel && <div className="measure-badge">{t.viewerMeasureHint}</div>}
      {measureLabel && (
        <div className="measure-badge">
          <span>{measureLabel}</span>
          {measureCount > 0 && (
            <button type="button" onClick={clearMeasurements}>
              {t.viewerClearMeasurements(formatNumber(measureCount))}
            </button>
          )}
        </div>
      )}

      <div className="viewcube-container" ref={cubeHostRef} title={t.alignView} />

      {!model && (
        <div className="viewer-empty">
          <div className="chat-empty-icon" aria-hidden="true">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M3 7l9-4 9 4-9 4-9-4z" />
              <path d="M3 12l9 4 9-4M3 17l9 4 9-4" />
            </svg>
          </div>
          <strong>{t.viewerEmptyTitle}</strong>
          <p>{t.viewerEmptyBody}</p>
          <button
            type="button"
            className="viewer-empty-suggestion"
            onClick={() => onLoadSample?.()}
            disabled={!onLoadSample}
          >
            {t.viewerTryPrefix} {t.viewerTrySample}
          </button>
        </div>
      )}

      {activeHandle && (
        <div
          className="viewer-handle-tooltip"
          style={{ left: `${activeHandle.screenX}px`, top: `${activeHandle.screenY}px` }}
        >
          <span className="name">{activeHandle.label}</span>
          <span className="val">
            {formatNumber(activeHandle.value)} {units}
          </span>
        </div>
      )}

      <div className="viewer-note-pins">
        {notes.map((note, index) => {
          const exists = Boolean(model?.parts.some((part) => part.id === note.partId));
          return (
            <button
              key={note.id}
              ref={(node) => {
                if (node) notePinRefs.current.set(note.id, node);
                else notePinRefs.current.delete(note.id);
              }}
              type="button"
              className={`viewer-note-pin${note.status === "resolved" ? " resolved" : ""}${
                exists ? "" : " stale"
              }`}
              style={{ left: 0, top: 0, display: "none" }}
              title={`${note.text}${exists ? "" : ` · ${t.viewerNoteChanged}`}`}
              onClick={(event) => {
                event.stopPropagation();
                onFocusNoteRef.current?.(note);
              }}
            >
              {index + 1}
            </button>
          );
        })}
      </div>

      {noteComposer && (
        <form
          className="viewer-note-composer"
          style={{ left: `${noteComposer.x}px`, top: `${noteComposer.y}px` }}
          onSubmit={(event) => {
            event.preventDefault();
            const text = noteComposer.text.trim();
            if (!text || !onAddNote) return;
            onAddNote({
              partId: noteComposer.partId,
              partName: noteComposer.partName,
              point: noteComposer.point,
              normal: noteComposer.normal,
              text,
            });
            setNoteComposer(null);
          }}
        >
          <div className="note-composer-part">{noteComposer.partName}</div>
          <textarea
            autoFocus
            rows={3}
            maxLength={2000}
            value={noteComposer.text}
            placeholder={t.viewerNotePlaceholder}
            onChange={(event) =>
              setNoteComposer((current) =>
                current ? { ...current, text: event.target.value } : current,
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setNoteComposer(null);
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="note-composer-actions">
            <button type="button" className="btn-ghost" onClick={() => setNoteComposer(null)}>
              {t.viewerNoteCancel}
            </button>
            <button type="submit" className="btn-primary" disabled={!noteComposer.text.trim()}>
              {t.viewerNoteSave}
            </button>
          </div>
        </form>
      )}

      {contextMenu && (
        <div
          className="viewer-context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="menu-header">
            <span className="menu-part-icon" />
            <span className="menu-part-name" title={contextMenu.partName}>
              {pickedPartIds.length > 1 && pickedPartIds.includes(contextMenu.partId)
                ? t.viewerSelectedParts(formatNumber(pickedPartIds.length))
                : contextMenu.partName}
            </span>
          </div>
          <div className="menu-divider" />

          <button
            type="button"
            className="menu-item"
            onClick={() => {
              const ids =
                pickedPartIds.length > 1 && pickedPartIds.includes(contextMenu.partId)
                  ? pickedPartIds
                  : [contextMenu.partId];
              const targets = ids
                .map((id) => {
                  const part = model?.parts.find((item) => item.id === id);
                  if (!part) return null;
                  return { partId: part.id, partName: part.name };
                })
                .filter((target): target is ChatTarget => Boolean(target));
              if (targets.length > 0) onSendPartsToChatRef.current?.(targets);
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
              <path d="M8 9h8M8 13h5" />
            </svg>
            <span>{t.viewerSendToChat}</span>
          </button>

          <button
            type="button"
            className="menu-item"
            onClick={() => {
              if (!contextMenu.point) {
                setContextMenu(null);
                return;
              }
              setNoteComposer({
                partId: contextMenu.partId,
                partName: contextMenu.partName,
                x: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 270)),
                y: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 190)),
                point: { x: contextMenu.point.x, y: contextMenu.point.y, z: contextMenu.point.z },
                normal: contextMenu.surfaceNormal
                  ? {
                      x: contextMenu.surfaceNormal.x,
                      y: contextMenu.surfaceNormal.y,
                      z: contextMenu.surfaceNormal.z,
                    }
                  : undefined,
                text: "",
              });
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 21s7-5.2 7-11a7 7 0 1 0-14 0c0 5.8 7 11 7 11z" />
              <circle cx="12" cy="10" r="2.2" />
            </svg>
            <span>{t.viewerAddNoteHere}</span>
          </button>

          <div className="menu-divider" />

          <button
            type="button"
            className="menu-item"
            onClick={() => {
              onToggleHidePart?.(contextMenu.partId);
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {hiddenPartIds.includes(contextMenu.partId) ? (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              ) : (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </>
              )}
            </svg>
            <span>
              {hiddenPartIds.includes(contextMenu.partId) ? t.viewerUnhidePart : t.viewerHidePart}
            </span>
          </button>

          <button
            type="button"
            className="menu-item"
            onClick={() => {
              onToggleTransparentPart?.(contextMenu.partId);
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z" />
              <path d="M12 6a6 6 0 0 0 0 12z" fill="currentColor" opacity="0.6" />
            </svg>
            <span>
              {transparentPartIds.includes(contextMenu.partId)
                ? t.viewerMakeSolid
                : t.viewerMakeGhost}
            </span>
          </button>

          <div className="menu-divider" />

          <button
            type="button"
            className="menu-item"
            onClick={() => {
              if (model) {
                model.parts
                  .map((p) => p.id)
                  .filter((id) => id !== contextMenu.partId)
                  .forEach((id) => {
                    if (!hiddenPartIds.includes(id)) onToggleHidePart?.(id);
                  });
              }
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3" />
              <rect x="7" y="7" width="10" height="10" fill="currentColor" fillOpacity="0.3" />
            </svg>
            <span>{t.viewerIsolate}</span>
          </button>

          <button
            type="button"
            className="menu-item"
            title={t.viewerSectionThroughPart}
            onClick={() => {
              if (contextMenu.normal && contextMenu.center) {
                setSectionCustom({
                  normal: contextMenu.normal.clone(),
                  base: contextMenu.center.clone(),
                });
                setSectionAxis("custom");
                setSectionT(0.5);
                setPickingSection(false);
              }
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3h18v18H3z" strokeDasharray="3 3" />
              <path d="M3 12h18" />
              <path d="M12 3v18" opacity="0.4" />
            </svg>
            <span>{t.viewerSectionFromPart}</span>
          </button>

          {(hiddenPartIds.length > 0 || transparentPartIds.length > 0) && (
            <>
              <div className="menu-divider" />
              {hiddenPartIds.length > 0 && (
                <button
                  type="button"
                  className="menu-item secondary"
                  onClick={() => {
                    onUnhideAll?.();
                    setContextMenu(null);
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  <span>{t.viewerUnhideCount(formatNumber(hiddenPartIds.length))}</span>
                </button>
              )}
              {transparentPartIds.length > 0 && (
                <button
                  type="button"
                  className="menu-item secondary"
                  onClick={() => {
                    onResetTransparent?.();
                    setContextMenu(null);
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                  <span>{t.viewerResetTransparency}</span>
                </button>
              )}
            </>
          )}
        </div>
      )}

      {animatingPartName && (
        <div className="viewer-assembly-badge">
          <span className="assembly-pulse" />
          <span>
            {t.assembling}: <strong>{animatingPartName}</strong> (
            {formatNumber(visiblePartCount)}/{formatNumber(model?.parts.length ?? 0)})
          </span>
        </div>
      )}

      {selectedPartId && (
        <div className="viewer-selected-chip">
          <span className="dot" />
          <span>
            {t.part}:{" "}
            <strong>
              {pickedPartIds.length > 1
                ? t.viewerSelectedParts(formatNumber(pickedPartIds.length))
                : model?.parts.find((p) => p.id === selectedPartId)?.name || selectedPartId}
            </strong>
          </span>
          {onToggleHidePart && (
            <button
              type="button"
              className="chip-action-btn"
              title={t.viewerHidePartHint}
              onClick={() => {
                onToggleHidePart(selectedPartId);
                onSelectPart?.(null);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
              <span>· {t.viewerHideShort}</span>
            </button>
          )}
          <button
            type="button"
            className="chip-close"
            title={t.viewerDeselect}
            onClick={() => onSelectPart?.(null)}
          >
            ×
          </button>
        </div>
      )}

      {model && (
        <div className="viewer-caption">
          {t.viewerModelCaption(formatNumber(model.parts.length), formatNumber(model.instances))}
        </div>
      )}
    </>
  );
}
