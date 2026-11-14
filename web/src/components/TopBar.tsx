import { useEffect, useRef, useState } from "react";

import type { Lod } from "../lib/api";
import type { Units } from "../lib/format";
import { t } from "../lib/strings";
import type { ThemeMode } from "../lib/theme";

export interface AgentPill {
  tone: "ok" | "warn" | "error";
  text: string;
  hint?: string;
}

interface Props {
  name: string;
  category: string;
  hasSpec: boolean;
  reviewed: boolean;
  native: boolean;
  running?: boolean;
  agentStage?: string | null;
  elapsed?: string | null;
  units: Units;
  onUnits: (units: Units) => void;
  revitVersion: string;
  onRevitVersion: (version: string) => void;
  lod: Lod;
  onLod: (lod: Lod) => void;
  onBuild?: () => void;
  onExportPortable?: () => void;
  exportingPortable?: boolean;
  canBuild: boolean;
  building?: boolean;
  onSaveModel?: () => void;
  onSaveModelAs?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onOpenLibrary?: () => void;
  onNewModel?: () => void;
  onLoadDemo?: (key: "fcu" | "pump" | "elbow" | "ystrainer" | "ystrainer-tube") => void;
  theme: ThemeMode;
  onTheme: (mode: ThemeMode) => void;
}

const LOD_OPTIONS: { value: Lod; label: string; hint: string }[] = [
  { value: 200, label: "200", hint: "LOD 200 · khối bao, 3–10 parts" },
  { value: 300, label: "300", hint: "LOD 300 · thiết kế thực tế, 5–20 parts" },
  { value: 350, label: "350", hint: "LOD 350 · phối hợp MEP, 10–40 parts" },
  { value: 400, label: "400", hint: "LOD 400 · chế tạo, 20–80 parts (phức tạp đến 150)" },
];

const DEMOS: { key: "fcu" | "pump" | "elbow" | "ystrainer" | "ystrainer-tube"; label: string }[] = [
  { key: "fcu", label: "FCU giấu trần 080 (Trane)" },
  { key: "pump", label: "Bơm ly tâm DN80" },
  { key: "ystrainer", label: "Y lọc bích DN80 PN16, nhánh 45°" },
  { key: "ystrainer-tube", label: "Y lọc nhánh tube 45°" },
  { key: "elbow", label: "Cút ren 90° Duct Elbow DN50" },
];

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "system", label: t.themeSystem },
  { value: "light", label: t.themeLight },
  { value: "dark", label: t.themeDark },
];

function getAgentStepIndex(stage: string | null | undefined): number {
  if (!stage) return 0;
  if (stage === "thinking" || stage === "reading") return 0;
  if (stage === "checking") return 2;
  if (stage === "generating" || stage === "working" || stage === "repairing") return 1;
  return 0;
}

function Check() {
  return (
    <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M1.5 5.2 4 7.5 8.5 2.5" />
    </svg>
  );
}

function Icon({ name }: { name: "book" | "save" | "download" | "plus" | "more" | "undo" | "redo" }) {
  const common = { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 } as const;
  if (name === "book") {
    return (
      <svg {...common}>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    );
  }
  if (name === "save") {
    return (
      <svg {...common}>
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
        <polyline points="17 21 17 13 7 13 7 21" />
        <polyline points="7 3 7 8 15 8" />
      </svg>
    );
  }
  if (name === "download") {
    return (
      <svg {...common}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    );
  }
  if (name === "plus") {
    return (
      <svg {...common}>
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    );
  }
  if (name === "undo") {
    return (
      <svg {...common}>
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h9a6 6 0 0 1 0 12h-3" />
      </svg>
    );
  }
  if (name === "redo") {
    return (
      <svg {...common}>
        <path d="m15 14 5-5-5-5" />
        <path d="M20 9h-9a6 6 0 0 0 0 12h3" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeWidth={2.4}>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </svg>
  );
}

export function TopBar({
  name,
  category,
  hasSpec,
  reviewed,
  native,
  running,
  agentStage,
  elapsed,
  units,
  onUnits,
  revitVersion,
  onRevitVersion,
  lod,
  onLod,
  onBuild,
  building,
  onExportPortable,
  exportingPortable,
  canBuild,
  onSaveModel,
  onSaveModelAs,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onOpenLibrary,
  onNewModel,
  onLoadDemo,
  theme,
  onTheme,
}: Props) {
  const currentStep = getAgentStepIndex(agentStage);
  const [menuOpen, setMenuOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
        setDemoOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const stages = running
    ? [t.stageRead, t.stageDesign, t.stageCheck]
    : [t.draft, t.reviewed, t.nativeFamily];

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">FA</div>
        <div className="brand-text">
          <div className="project-name">{hasSpec ? name : t.noFamily}</div>
          <div className="project-sub">{hasSpec ? category : t.noFamilyHint}</div>
        </div>
      </div>

      <div className="stages">
        {stages.map((label, index) => {
          const isDone = running
            ? index < currentStep
            : index === 0
              ? hasSpec
              : index === 1
                ? reviewed
                : native;
          const isActive = running
            ? index === currentStep
            : index === 0
              ? hasSpec && !reviewed
              : index === 1
                ? reviewed && !native
                : false;
          return (
            <span key={label} className={`stage ${isDone ? "done" : ""} ${isActive ? "active" : ""}`}>
              <span className="dot">{isDone ? <Check /> : null}</span>
              {label}
            </span>
          );
        })}
        {running && elapsed && <span className="stage-time">{elapsed}</span>}
      </div>

      <div className="top-actions">
        <select
          className="select lod-select"
          value={lod}
          onChange={(event) => onLod(Number(event.target.value) as Lod)}
          aria-label="Level of detail (LOD)"
          title={LOD_OPTIONS.find((option) => option.value === lod)?.hint ?? "Level of detail"}
        >
          {LOD_OPTIONS.map((option) => (
            <option key={option.value} value={option.value} title={option.hint}>
              LOD {option.label}
            </option>
          ))}
        </select>

        {onOpenLibrary && (
          <button
            type="button"
            className="btn-secondary"
            onClick={onOpenLibrary}
            title={t.libraryHint}
          >
            <Icon name="book" />
            <span>{t.library}</span>
          </button>
        )}

        {hasSpec && onSaveModel && (
          <button type="button" className="btn-secondary" onClick={onSaveModel} title={t.saveHint}>
            <Icon name="save" />
            <span>{t.save}</span>
          </button>
        )}

        {onExportPortable && (
          <button
            type="button"
            className="btn-primary"
            onClick={onExportPortable}
            disabled={!canBuild || exportingPortable || building}
            title={t.exportRfaHint}
          >
            {exportingPortable ? (
              <>
                <span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff" }} />
                <span>{t.exportingRfa}</span>
              </>
            ) : (
              <>
                <Icon name="download" />
                <span>{t.exportRfa}</span>
              </>
            )}
          </button>
        )}

        <div className="more-wrap" ref={menuRef}>
          <button
            type="button"
            className={`btn-secondary icon-button ${menuOpen ? "active" : ""}`}
            onClick={() => setMenuOpen((current) => !current)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t.moreActions}
            title={t.moreActions}
          >
            <Icon name="more" />
          </button>

          {menuOpen && (
            <div className="more-menu" role="menu">
              {onNewModel && (
                <button
                  type="button"
                  className="more-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onNewModel();
                  }}
                >
                  <Icon name="plus" />
                  <span>{t.newFamily}</span>
                </button>
              )}

              {hasSpec && onSaveModelAs && (
                <button
                  type="button"
                  className="more-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onSaveModelAs();
                  }}
                >
                  <Icon name="save" />
                  <span>{t.saveAs}</span>
                </button>
              )}

              {(onUndo || onRedo) && (
                <div className="more-row">
                  <button
                    type="button"
                    className="more-icon"
                    onClick={() => {
                      setMenuOpen(false);
                      onUndo?.();
                    }}
                    disabled={!canUndo}
                    title={t.undo}
                    aria-label={t.undo}
                  >
                    <Icon name="undo" />
                  </button>
                  <button
                    type="button"
                    className="more-icon"
                    onClick={() => {
                      setMenuOpen(false);
                      onRedo?.();
                    }}
                    disabled={!canRedo}
                    title={t.redo}
                    aria-label={t.redo}
                  >
                    <Icon name="redo" />
                  </button>
                  <span className="more-label">Undo / Redo</span>
                </div>
              )}

              <div className="more-label">{t.units}</div>
              <div className="more-segmented" role="group" aria-label={t.units}>
                <button
                  type="button"
                  className={units === "mm" ? "active" : ""}
                  onClick={() => onUnits("mm")}
                >
                  mm
                </button>
                <button
                  type="button"
                  className={units === "ft-in" ? "active" : ""}
                  onClick={() => onUnits("ft-in")}
                >
                  ft-in
                </button>
              </div>

              <label className="more-field">
                <span className="more-label">{t.revitVersion}</span>
                <select
                  className="select"
                  value={revitVersion}
                  onChange={(event) => onRevitVersion(event.target.value)}
                  aria-label={t.revitVersion}
                >
                  <option value="2024">Revit 2024</option>
                  <option value="2025">Revit 2025</option>
                  <option value="2026">Revit 2026</option>
                </select>
              </label>

              <div className="more-label">{t.theme}</div>
              <div className="more-segmented theme-switch" role="group" aria-label={t.theme}>
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={theme === option.value ? "active" : ""}
                    onClick={() => onTheme(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              {onBuild && (
                <button
                  type="button"
                  className="more-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onBuild();
                  }}
                  disabled={!canBuild || building || exportingPortable}
                  title={t.buildRevitHint}
                >
                  <span className="more-dot" />
                  <span>{building ? t.building : t.buildRevit}</span>
                </button>
              )}

              {onLoadDemo && (
                <div className="more-demo">
                  <button
                    type="button"
                    className="more-item"
                    onClick={() => setDemoOpen((current) => !current)}
                    aria-expanded={demoOpen}
                    title={t.demoPresetsHint}
                  >
                    <span className="more-dot" />
                    <span>{t.demoPresets}</span>
                    <span className="more-caret">{demoOpen ? "▴" : "▾"}</span>
                  </button>
                  {demoOpen && (
                    <div className="more-submenu">
                      <div className="more-label">{t.demoHeader}</div>
                      {DEMOS.map((demo) => (
                        <button
                          key={demo.key}
                          type="button"
                          className="more-item sub"
                          onClick={() => {
                            setMenuOpen(false);
                            setDemoOpen(false);
                            onLoadDemo(demo.key);
                          }}
                        >
                          {demo.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
