import { useEffect, useMemo, useState } from "react";
import {
  paramKey,
  type Analysis,
  type FamilyParameter,
  type FamilySpec,
  type ParameterType,
  type ResolvedParameter,
} from "@family/spec-core";
import { parameterDisplay, parameterUnit, type Units } from "../lib/format";

interface Props {
  spec: FamilySpec;
  analysis: Analysis;
  units: Units;
  selectedPartId?: string | null;
  onSelectPart?: (partId: string | null) => void;
  hiddenPartIds?: string[];
  onToggleHidePart?: (partId: string) => void;
  transparentPartIds?: string[];
  onToggleTransparentPart?: (partId: string) => void;
  onUpdateParameter: (name: string, value: number | string) => void;
  onAddParameter: (draft: { name: string; type: ParameterType; value: number | string }) => void;
}

const GROUP_ORDER = [
  "Dimensions",
  "Constraints",
  "Data",
  "Identity Data",
  "Graphics",
  "Materials and Finishes",
  "Mechanical",
  "Electrical",
  "Plumbing",
  "Energy Analysis",
  "Structural",
  "Construction",
  "Visibility",
  "Fire Protection",
  "General",
  "Other",
];

const PARAM_TYPES: ParameterType[] = ["Length", "Angle", "Number", "Integer", "Text", "YesNo"];

function ParameterRow({
  param,
  resolved,
  units,
  onUpdate,
}: {
  param: FamilyParameter;
  resolved: ResolvedParameter;
  units: Units;
  onUpdate: (name: string, value: number | string) => void;
}) {
  const derived = Boolean(resolved.formula);
  const locked = derived || param.type === "YesNo" || (param.type === "Length" && units === "ft-in");
  const display = parameterDisplay(resolved, units);
  const unit = parameterUnit(resolved, units);
  const [draft, setDraft] = useState(display);

  useEffect(() => {
    setDraft(display);
  }, [display]);

  const commit = () => {
    if (locked || draft === display) return;
    if (param.type === "Text") {
      onUpdate(param.name, draft);
      return;
    }
    const parsed = Number(draft.replace(/,/g, "").trim());
    if (!Number.isFinite(parsed)) {
      setDraft(display);
      return;
    }
    onUpdate(param.name, parsed);
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const val = event.target.value;
    setDraft(val);
    if (!locked && param.type !== "Text") {
      const parsed = Number(val.replace(/,/g, "").trim());
      if (Number.isFinite(parsed) && val.trim() !== "" && !val.endsWith(".")) {
        onUpdate(param.name, parsed);
      }
    }
  };

  return (
    <div className={`param-row ${derived ? "derived" : ""}`}>
      <span className="swatch" />
      <div className="param-name" title={param.description || param.name}>
        {param.name}
        {resolved.formula && <span className="param-formula">= {resolved.formula}</span>}
        {resolved.error && (
          <span className="param-formula" style={{ color: "#ae463b" }}>
            {resolved.error}
          </span>
        )}
      </div>
      <div className="param-value-wrap">
        <input
          className="param-input"
          value={draft}
          disabled={locked}
          inputMode={param.type === "Text" ? "text" : "decimal"}
          onChange={handleInputChange}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(display);
              event.currentTarget.blur();
            }
          }}
          aria-label={param.name}
          title={String(display)}
        />
        {unit && <span className="param-unit">{unit}</span>}
      </div>
    </div>
  );
}

export function ParameterPanel({
  spec,
  analysis,
  units,
  selectedPartId,
  onSelectPart,
  hiddenPartIds = [],
  onToggleHidePart,
  transparentPartIds = [],
  onToggleTransparentPart,
  onUpdateParameter,
  onAddParameter,
}: Props) {
  const [tab, setTab] = useState<"parameters" | "parts">("parameters");
  const [filter, setFilter] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftType, setDraftType] = useState<ParameterType>("Length");

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [group]: !prev[group],
    }));
  };

  const groups = useMemo(() => {
    const search = filter.trim().toLowerCase();
    const buckets = new Map<string, { param: FamilyParameter; resolved: ResolvedParameter }[]>();

    for (const param of spec.parameters) {
      const resolved = analysis.parameters.byKey.get(paramKey(param.name));
      if (!resolved) continue;
      if (search && !param.name.toLowerCase().includes(search)) continue;
      const group = param.group || resolved.group || "Other";
      const list = buckets.get(group) ?? [];
      list.push({ param, resolved });
      buckets.set(group, list);
    }

    return [...buckets.entries()].sort(
      (a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]),
    );
  }, [spec.parameters, analysis.parameters, filter]);

  const materialColor = (name?: string) =>
    spec.materials?.find((material) => material.name === name)?.color ?? "#a9aeb2";

  const submitNew = () => {
    const name = draftName.trim();
    if (!name) return;
    onAddParameter({ name, type: draftType, value: draftType === "Text" ? "" : 0 });
    setDraftName("");
    setAdding(false);
  };

  return (
    <section className="pane right">
      <div className="tabs">
        <button
          type="button"
          className={`tab ${tab === "parameters" ? "active" : ""}`}
          onClick={() => setTab("parameters")}
        >
          Parameters <span className="count">{spec.parameters.length}</span>
        </button>
        <button
          type="button"
          className={`tab ${tab === "parts" ? "active" : ""}`}
          onClick={() => setTab("parts")}
        >
          Parts <span className="count">{spec.parts.length}</span>
        </button>
      </div>

      {tab === "parameters" && (
        <>
          <div className="filter">
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter parameters"
              aria-label="Filter parameters"
            />
          </div>

          <div className="param-scroll">
            {spec.typeName && (
              <div className="editing-type-badge">
                <span className="editing-label">Editing type</span>
                <span className="editing-name">{spec.typeName}</span>
              </div>
            )}
            {groups.map(([group, items]) => {
              const isCollapsed = Boolean(collapsedGroups[group]);
              return (
                <div key={group} className="param-group-section">
                  <button
                    type="button"
                    className="param-group-head"
                    onClick={() => toggleGroup(group)}
                  >
                    <span className="group-title">
                      <span className={`chevron ${isCollapsed ? "collapsed" : ""}`}>▾</span>
                      {group}
                    </span>
                    <span className="count">{items.length}</span>
                  </button>
                  {!isCollapsed &&
                    items.map(({ param, resolved }) => (
                      <ParameterRow
                        key={param.name}
                        param={param}
                        resolved={resolved}
                        units={units}
                        onUpdate={onUpdateParameter}
                      />
                    ))}
                </div>
              );
            })}

            {groups.length === 0 && (
              <div style={{ padding: "18px 12px", color: "#8c8e91" }}>No parameter matches that filter.</div>
            )}

            {adding ? (
              <div className="add-form">
                <input
                  autoFocus
                  value={draftName}
                  placeholder="Parameter name"
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitNew();
                    if (event.key === "Escape") setAdding(false);
                  }}
                />
                <div className="row">
                  <select value={draftType} onChange={(event) => setDraftType(event.target.value as ParameterType)}>
                    {PARAM_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn-ghost" onClick={submitNew}>
                    Add
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="add-param" onClick={() => setAdding(true)}>
                + Add parameter
              </button>
            )}

            {spec.parameters.some((parameter) => parameter.formula) && (
              <div className="banner info" style={{ marginTop: 4 }}>
                Values marked with a formula are driven by other parameters — edit the driver instead.
              </div>
            )}
          </div>
        </>
      )}

      {tab === "parts" && (
        <div className="param-scroll">
          <div className="parts-list">
            {spec.parts.map((part) => {
              const isSelected = part.id === selectedPartId;
              const isHidden = hiddenPartIds.includes(part.id);
              const isTransparent = transparentPartIds.includes(part.id);
              return (
                <div
                  key={part.id}
                  className={`part-row ${isSelected ? "selected" : ""} ${isHidden ? "hidden-part" : ""} ${isTransparent ? "transparent-part" : ""}`}
                  onClick={() => onSelectPart?.(isSelected ? null : part.id)}
                  title="Click to highlight in 3D viewer"
                >
                  <span className="swatch" style={{ background: part.color || materialColor(part.material) }} />
                  <span className="name">{part.name}</span>
                  <span className="id">{part.id}</span>
                  <div className="part-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={`btn-part-action ${isTransparent ? "active" : ""}`}
                      title={isTransparent ? "Làm đặc lại (Opaque)" : "Làm mờ (Ghost / Translucent)"}
                      onClick={() => onToggleTransparentPart?.(part.id)}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z" />
                        <path d="M12 6a6 6 0 0 0 0 12z" fill="currentColor" opacity={isTransparent ? 0.9 : 0.4} />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={`btn-hide-part ${isHidden ? "hidden" : ""}`}
                      title={isHidden ? "Unhide part (Hiện cấu kiện)" : "Hide part (Ẩn cấu kiện)"}
                      onClick={() => onToggleHidePart?.(part.id)}
                    >
                      {isHidden ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="banner info">
            {analysis.model.instances} solids in the model · {spec.materials?.length ?? 0} materials
          </div>
        </div>
      )}
    </section>
  );
}
