import { useState, useRef, useEffect } from "react";
import type { Units } from "../lib/format";
import type { Lod } from "../lib/api";

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
    units: Units;
  onUnits: (units: Units) => void;
  revitVersion: string;
  onRevitVersion: (version: string) => void;
  lod: Lod;
  onLod: (lod: Lod) => void;
  onBuild: () => void;
  canBuild: boolean;
  building: boolean;
  onSaveModel?: () => void;
  onOpenLibrary?: () => void;
  onNewModel?: () => void;
  onLoadDemo?: (key: "fcu" | "pump" | "elbow") => void;
}

const LOD_OPTIONS: { value: Lod; label: string; hint: string }[] = [
  { value: 200, label: "200", hint: "LOD 200 · khối bao, 3-8 parts" },
  { value: 300, label: "300", hint: "LOD 300 · thiết kế thực tế, 4-16 parts" },
  { value: 350, label: "350", hint: "LOD 350 · phối hợp MEP, tai treo, 10-30 parts" },
  { value: 400, label: "400", hint: "LOD 400 · chi tiết chế tạo, 18-45 parts" },
];

const AGENT_STEPS = ["Read brief", "Design family", "Check model"];

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

export function TopBar({
  name,
  category,
  hasSpec,
  reviewed,
  native,
  running,
  agentStage,
    units,
  onUnits,
  revitVersion,
  onRevitVersion,
  lod,
  onLod,
  onBuild,
  canBuild,
  building,
  onSaveModel,
  onOpenLibrary,
  onNewModel,
  onLoadDemo,
}: Props) {
  const currentStep = getAgentStepIndex(agentStage);
  const [demoOpen, setDemoOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDemoOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">FA</div>
        <div style={{ minWidth: 0 }}>
          <div className="project-name">{hasSpec ? name : "New family"}</div>
          <div className="project-sub">{category}</div>
        </div>
      </div>

      <div className="stages">
        {running ? (
          AGENT_STEPS.map((label, index) => {
            const isDone = index < currentStep;
            const isActive = index === currentStep;
            return (
              <span
                key={label}
                className={`stage ${isDone ? "done" : ""} ${isActive ? "active" : ""}`}
              >
                <span className="dot">{isDone ? <Check /> : null}</span>
                {label}
              </span>
            );
          })
        ) : (
          <>
            <span className={`stage ${hasSpec ? "done" : ""} ${hasSpec && !reviewed ? "active" : ""}`}>
              <span className="dot">{hasSpec ? <Check /> : null}</span>
              Draft
            </span>
            <span className={`stage ${reviewed ? "done" : ""} ${hasSpec && !reviewed ? "" : reviewed && !native ? "active" : ""}`}>
              <span className="dot">{reviewed ? <Check /> : null}</span>
              Reviewed
            </span>
            <span className={`stage ${native ? "done" : ""} ${reviewed && !native ? "active" : ""}`}>
              <span className="dot">{native ? <Check /> : null}</span>
              Native family
            </span>
          </>
        )}
      </div>

      <div className="top-actions">

        {onLoadDemo && (
          <div className="demo-dropdown-container" ref={dropdownRef}>
            <button
              type="button"
              className={`btn-secondary btn-demo ${demoOpen ? "active" : ""}`}
              onClick={() => setDemoOpen((curr) => !curr)}
              title="Nạp nhanh mô hình mẫu để test tính năng (Không tốn token AI)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
              <span>Demo Presets ▾</span>
            </button>
            {demoOpen && (
              <div className="demo-dropdown-menu show">
                <div className="demo-dropdown-header">Mẫu thử nghiệm (Offline - 0 token)</div>
                <button
                  type="button"
                  onClick={() => {
                    onLoadDemo("fcu");
                    setDemoOpen(false);
                  }}
                >
                  🌀 FCU Giấu trần 080 (Trane)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onLoadDemo("pump");
                    setDemoOpen(false);
                  }}
                >
                  ⚡ Bơm ly tâm thẳng hàng DN80
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onLoadDemo("elbow");
                    setDemoOpen(false);
                  }}
                >
                  📐 Cút ren 90° Duct Elbow DN50
                </button>
              </div>
            )}
          </div>
        )}

        {onNewModel && (
          <button type="button" className="btn-secondary" onClick={onNewModel} title="Bắt đầu tạo mô hình mới (xóa màn hình)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>New family</span>
          </button>
        )}

        {onOpenLibrary && (
          <button type="button" className="btn-secondary" onClick={onOpenLibrary} title="Mở danh sách các mô hình đã lưu">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span>Library</span>
          </button>
        )}

        {hasSpec && onSaveModel && (
          <button type="button" className="btn-secondary" onClick={onSaveModel} title="Lưu mô hình này lại">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            <span>Save</span>
          </button>
        )}

        <div className="segmented" role="group" aria-label="Units">
          <button type="button" className={units === "mm" ? "active" : ""} onClick={() => onUnits("mm")}>
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

        <select
          className="select"
          value={revitVersion}
          onChange={(event) => onRevitVersion(event.target.value)}
          aria-label="Revit version"
        >
          <option value="2024">Revit 2024</option>
          <option value="2025">Revit 2025</option>
          <option value="2026">Revit 2026</option>
        </select>

        <button type="button" className="btn-primary" onClick={onBuild} disabled={!canBuild || building}>
          {building ? (
            <>
              <span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff" }} />
              Building
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2 13h12" />
              </svg>
              Build Revit family
            </>
          )}
        </button>
      </div>
    </header>
  );
}
