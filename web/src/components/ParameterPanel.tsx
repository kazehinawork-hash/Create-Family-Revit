import { useEffect, useMemo, useState } from "react";
import {
  buildParameterGraph,
  collectPartDependencies,
  paramKey,
  type Analysis,
  type FamilyParameter,
  type FamilySpec,
  type FamilyTypeEntry,
  type ParameterType,
  type PartBuildStatus,
  type ResolvedParameter,
} from "@family/spec-core";
import { parameterDisplay, parameterUnit, type Units } from "../lib/format";
import { TypesPanel } from "./TypesPanel";
import { t } from "../lib/strings";

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
  onIsolatePart?: (partId: string) => void;
  issuePartIds?: string[];
  onUpdateParameter: (name: string, value: number | string) => void;
  onAddParameter: (draft: { name: string; type: ParameterType; value: number | string }) => void;
  onHighlightParts?: (partIds: string[]) => void;
  onUpdateConnectorHost?: (connectorId: string, host: "solid" | "reference-plane") => void;
  types: FamilyTypeEntry[];
  onChangeTypes: (types: FamilyTypeEntry[]) => void;
  onPreviewType: (values: Record<string, number> | null) => void;
  onExportTypes: () => void;
  exportingTypes?: boolean;
  previewTypeActive?: boolean;
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

const PARITY_LABELS: Record<PartBuildStatus, string> = {
  native: "Native",
  "native-multi-hole": "Native holes",
  "native-bore": "Native bore",
  "native-revolve": "Revolve",
  "swept-blend": "SweptBlend",
  sweep: "Sweep",
  blend: "Blend",
  freeform: "FreeForm",
  "multi-section": "Multi-section",
};

function ParameterRow({
  param,
  resolved,
  units,
  impact,
  onUpdate,
  onHighlight,
}: {
  param: FamilyParameter;
  resolved: ResolvedParameter;
  units: Units;
  impact?: { parameters: string[]; parts: { id: string; name: string }[] };
  onUpdate: (name: string, value: number | string) => void;
  onHighlight?: (partIds: string[]) => void;
}) {
  const derived = Boolean(resolved.formula);
  const isYesNo = param.type === "YesNo";
  const isNumeric = param.type === "Length" || param.type === "Angle" || param.type === "Number" || param.type === "Integer";
  const locked = derived || (param.type === "Length" && units === "ft-in");
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

  const stepValue = (direction: number) => {
    if (locked || derived) return;
    const currentNum = typeof resolved.value === "number" ? resolved.value : Number(draft);
    if (!Number.isFinite(currentNum)) return;
    const delta = param.type === "Integer" ? 1 : (currentNum < 10 ? 1 : currentNum < 100 ? 5 : 10);
    const updated = Math.max(0, currentNum + direction * delta);
    onUpdate(param.name, updated);
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
        {impact && (impact.parameters.length > 0 || impact.parts.length > 0) && (
          <button
            type="button"
            className="param-impact"
            onClick={() => onHighlight?.(impact.parts.map((part) => part.id))}
            title={`${impact.parameters.length} parameter phụ thuộc · ${impact.parts.length} part bị ảnh hưởng`}
          >
            ↳ {impact.parameters.length} param · {impact.parts.length} part
          </button>
        )}
      </div>
      <div className="param-value-wrap">
        {isYesNo ? (
          <label className="param-checkbox-wrap" title={`Bật/Tắt ${param.name}`}>
            <input
              type="checkbox"
              className="param-checkbox"
              disabled={derived}
              checked={Boolean(resolved.value)}
              onChange={(e) => onUpdate(param.name, e.target.checked ? 1 : 0)}
            />
            <span className="param-checkbox-label">{resolved.value ? "Yes" : "No"}</span>
          </label>
        ) : (
          <>
            {isNumeric && !locked && !derived && (
              <div className="param-stepper">
                <button
                  type="button"
                  className="btn-step"
                  onClick={() => stepValue(-1)}
                  title="Giảm giá trị"
                >
                  −
                </button>
                <button
                  type="button"
                  className="btn-step"
                  onClick={() => stepValue(1)}
                  title="Tăng giá trị"
                >
                  +
                </button>
              </div>
            )}
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
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  stepValue(1);
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  stepValue(-1);
                }
              }}
              aria-label={param.name}
              title={String(display)}
            />
            {unit && <span className="param-unit">{unit}</span>}
          </>
        )}
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
  onIsolatePart,
  issuePartIds = [],
  onUpdateParameter,
  onAddParameter,
  onHighlightParts,
  onUpdateConnectorHost,
  types,
  onChangeTypes,
  onPreviewType,
  onExportTypes,
  exportingTypes = false,
  previewTypeActive = false,
}: Props) {
  const [tab, setTab] = useState<"parameters" | "parts" | "connectors" | "types">("parameters");
  const [filter, setFilter] = useState("");
  const [partFilter, setPartFilter] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftType, setDraftType] = useState<ParameterType>("Length");
  const [onlyRisks, setOnlyRisks] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  const resolvedConnectors = new Map(
    (analysis.model.connectors ?? []).map((connector) => [connector.id, connector]),
  );

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

  const impacts = useMemo(() => {
    const graph = buildParameterGraph(spec.parameters);
    const partDeps = collectPartDependencies(spec);
    const map = new Map<string, { parameters: string[]; parts: { id: string; name: string }[] }>();

    for (const node of graph.parameters) {
      const parameters = graph.impactOf([node.name]);
      const keys = new Set([node.name, ...parameters].map(paramKey));
      const parts = partDeps
        .filter((part) => part.parameters.some((name) => keys.has(paramKey(name))))
        .map((part) => ({ id: part.id, name: part.name }));
      if (parameters.length > 0 || parts.length > 0) {
        map.set(paramKey(node.name), { parameters, parts });
      }
    }

    return map;
  }, [spec]);

  const parityById = useMemo(
    () => new Map(analysis.partParity.map((part) => [part.partId, part])),
    [analysis.partParity],
  );

  const paritySummary = useMemo(() => {
    const total = analysis.partParity.length;
    const risky = analysis.partParity.filter((part) => part.risks.length > 0).length;
    const native = analysis.partParity.filter((part) => part.native).length;
    return { total, risky, native };
  }, [analysis.partParity]);

  const selectedPart = selectedPartId
    ? spec.parts.find((part) => part.id === selectedPartId) ?? null
    : null;

  // Parameters that drive the selected part, including the base parameters behind
  // any formula it references. Those base values are what the user actually edits.
  const selectedPartParameters = useMemo(() => {
    if (!selectedPartId) return [];
    const part = collectPartDependencies(spec).find((entry) => entry.id === selectedPartId);
    if (!part) return [];

    const graph = buildParameterGraph(spec.parameters);
    const byKey = new Map(spec.parameters.map((param) => [paramKey(param.name), param]));
    const keys = new Set<string>();
    const directKeys = new Set(part.parameters.map(paramKey));
    const queue = [...directKeys];

    while (queue.length > 0) {
      const key = queue.shift()!;
      if (keys.has(key)) continue;
      keys.add(key);
      const node = graph.byKey.get(key);
      if (node) queue.push(...node.dependsOn.map(paramKey));
    }

    return [...keys]
      .map((key) => {
        const param = byKey.get(key);
        const resolved = analysis.parameters.byKey.get(key);
        return param && resolved ? { param, resolved, direct: directKeys.has(key) } : null;
      })
      .filter((item): item is { param: FamilyParameter; resolved: ResolvedParameter; direct: boolean } => Boolean(item))
      .sort(
        (a, b) =>
          Number(Boolean(a.resolved.formula)) - Number(Boolean(b.resolved.formula)) ||
          Number(b.direct) - Number(a.direct) ||
          a.param.name.localeCompare(b.param.name),
      );
  }, [analysis.parameters, selectedPartId, spec]);

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
      {selectedPart && (
        <div className="selected-part-params">
          <div className="selected-part-params-head">
            <span className="selected-part-label">Part</span>
            <strong className="selected-part-name" title={selectedPart.name}>
              {selectedPart.name}
            </strong>
            <span className="selected-part-count">
              {selectedPartParameters.length} parameter
            </span>
            <button
              type="button"
              className="selected-part-clear"
              onClick={() => onSelectPart?.(null)}
              title="Bỏ chọn part"
              aria-label="Bỏ chọn part"
            >
              ×
            </button>
          </div>
          <div className="selected-part-param-list">
            {selectedPartParameters.length > 0 ? (
              selectedPartParameters.map(({ param, resolved }) => (
                <ParameterRow
                  key={param.name}
                  param={param}
                  resolved={resolved}
                  units={units}
                  onUpdate={onUpdateParameter}
                />
              ))
            ) : (
              <div className="selected-part-empty">Part này không tham chiếu parameter trực tiếp.</div>
            )}
          </div>
        </div>
      )}

      <div className="tabs">
        <button
          type="button"
          className={`tab ${tab === "parameters" ? "active" : ""}`}
          onClick={() => setTab("parameters")}
        >
          {t.parameters} <span className="count">{spec.parameters.length}</span>
        </button>
        <button
          type="button"
          className={`tab ${tab === "parts" ? "active" : ""}`}
          onClick={() => setTab("parts")}
        >
          {t.parts} <span className="count">{spec.parts.length}</span>
        </button>
        <button
          type="button"
          className={`tab ${tab === "connectors" ? "active" : ""}`}
          onClick={() => setTab("connectors")}
        >
          {t.connectors} <span className="count">{spec.connectors?.length ?? 0}</span>
        </button>
        <button
          type="button"
          className={`tab ${tab === "types" ? "active" : ""}`}
          onClick={() => setTab("types")}
          data-testid="tab-types"
        >
          {t.types} <span className="count">{types.length}</span>
        </button>
      </div>

      {tab === "parameters" && (
        <>
          <div className="filter">
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t.filterParameters}
              aria-label={t.filterParameters}
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
                        impact={impacts.get(paramKey(param.name))}
                        onUpdate={onUpdateParameter}
                        onHighlight={onHighlightParts}
                      />
                    ))}
                </div>
              );
            })}

            {groups.length === 0 && (
              <div className="pane-empty small">Không có tham số nào khớp bộ lọc.</div>
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
        <>
          <div className="filter">
            <input
              value={partFilter}
              onChange={(event) => setPartFilter(event.target.value)}
              placeholder={t.filterParts}
              aria-label="Filter parts"
            />
            <label className="parity-filter" title="Chỉ hiện part sẽ khác preview hoặc mất native form">
              <input
                type="checkbox"
                checked={onlyRisks}
                onChange={(event) => setOnlyRisks(event.target.checked)}
              />
              <span>Rủi ro</span>
            </label>
            <label className="parity-filter" title="Hiện gợi ý info: mặt khít nhau, part bị chôn">
              <input
                type="checkbox"
                checked={showInfo}
                onChange={(event) => setShowInfo(event.target.checked)}
              />
              <span>Info</span>
            </label>
          </div>

          <div className="param-scroll">
            <div className="parts-list">
            {spec.parts
              .filter((part) => {
                const parity = parityById.get(part.id);
                if (onlyRisks && (!parity || parity.risks.length === 0)) return false;
                const query = partFilter.trim().toLowerCase();
                if (!query) return true;
                return (
                  part.name.toLowerCase().includes(query) || part.id.toLowerCase().includes(query)
                );
              })
              .map((part) => {
                const isSelected = part.id === selectedPartId;
                const isHidden = hiddenPartIds.includes(part.id);
                const isTransparent = transparentPartIds.includes(part.id);
                const parity = parityById.get(part.id);
                const partIssues = analysis.issues.filter((issue) => {
                  const isLogic =
                    issue.path === `logic.geometry.${part.id}` ||
                    issue.path.startsWith(`logic.geometry.${part.id}.`);
                  if (isLogic) return true;
                  if (!showInfo) return false;
                  return (
                    issue.path === `info.geometry.${part.id}` ||
                    issue.path.startsWith(`info.geometry.${part.id}.`)
                  );
                });
                const hasIssue =
                  partIssues.some((issue) => issue.severity !== "info") ||
                  issuePartIds.includes(part.id);
                return (
                  <div
                    key={part.id}
                    className={`part-row-wrap ${isSelected ? "selected" : ""}`}
                  >
                    <div
                      className={`part-row ${isSelected ? "selected" : ""} ${isHidden ? "hidden-part" : ""} ${isTransparent ? "transparent-part" : ""}`}
                      onClick={() => onSelectPart?.(isSelected ? null : part.id)}
                      title="Click to highlight in 3D viewer"
                    >
                      <span className="swatch" style={{ background: part.color || materialColor(part.material) }} />
                      <span className="name">{part.name}</span>
                      {parity && (
                        <span
                          className={`part-parity-badge ${parity.status}`}
                          title={
                            parity.risks.length > 0
                              ? parity.risks.map((risk) => risk.message).join("\n")
                              : "Part giữ native form trong Revit"
                          }
                        >
                          {PARITY_LABELS[parity.status]}
                        </span>
                      )}
                      {hasIssue && <span className="part-issue-dot" title="Cảnh báo bố trí" />}
                      <span className="id">{part.id}</span>
                      <div className="part-actions" onClick={(e) => e.stopPropagation()}>
                        {onIsolatePart && (
                          <button
                            type="button"
                            className="btn-part-action"
                            title="Chỉ hiện part này (Isolate)"
                            onClick={() => onIsolatePart(part.id)}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="7" />
                              <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
                            </svg>
                          </button>
                        )}
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
                  {partIssues.length > 0 && (
                    <div className="part-issues-list">
                      {partIssues.map((issue, idx) => (
                        <div key={idx} className={`part-issue-item ${issue.severity}`}>
                          <span className="issue-icon">⚠</span>
                          <span className="issue-msg">{issue.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {parity && parity.risks.length > 0 && (
                    <div className="part-issues-list parity">
                      {parity.risks.map((risk, idx) => (
                        <div key={`${risk.code}-${idx}`} className={`part-issue-item ${risk.severity}`}>
                          <span className="issue-icon">⚠</span>
                          <span className="issue-msg">
                            {risk.message}
                            {risk.hint ? ` — ${risk.hint}` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                );
              })}
          </div>
          {paritySummary.risky > 0 && (
            <div className="banner warn">
              {paritySummary.risky}/{paritySummary.total} part sẽ khác preview hoặc mất native form trong .rfa.
              Bật “Rủi ro” để lọc.
            </div>
          )}
          <div className="banner info">
            {analysis.model.instances} solids · {paritySummary.native}/{paritySummary.total} native ·{" "}
            {spec.materials?.length ?? 0} materials
          </div>
        </div>
        </>
      )}

      {tab === "connectors" && (
        <div className="param-scroll">
          <div className="connectors-tab-list">
            {(spec.connectors ?? []).length === 0 ? (
              <div style={{ padding: "18px 12px", color: "#8c8e91" }}>
                Chưa có MEP Connector nào trong mô hình này.
              </div>
            ) : (
              (spec.connectors ?? []).map((conn, idx) => {
                const resolved = resolvedConnectors.get(conn.id);
                const connIssues = analysis.issues.filter(
                  (issue) => issue.path === `logic.geometry.connector.${conn.id}`
                );
                const referenceHost =
                  resolved?.host === "reference-plane" || conn.host === "reference-plane";
                const isOrphan =
                  !referenceHost &&
                  connIssues.some((issue) => issue.message.includes("orphaned"));
                const dir = (conn.direction ?? "bidirectional").toLowerCase();
                const isRound = conn.shape !== "rectangular";
                const origin = resolved?.origin ?? conn.origin;
                const width = resolved?.width ?? conn.width;
                const height = resolved?.height ?? conn.height;
                const diameter = resolved?.diameter ?? conn.diameter;
                const rounded = (value: unknown, fallback: number) => {
                  const number = Number(value);
                  return Number.isFinite(number) ? Math.round(number) : fallback;
                };
                const sizeText = isRound
                  ? `Ø${rounded(diameter, 50)}mm`
                  : `${rounded(width, 200)}×${rounded(height, 200)}mm`;
                const coordinates = [origin?.x, origin?.y, origin?.z]
                  .map((value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : "—"))
                  .join(", ");

                return (
                  <div key={conn.id || idx} className="connector-card">
                    <div className="connector-card-head">
                      <div className="connector-card-title">
                        <span className="connector-icon">⌾</span>
                        <span className="connector-name">{conn.name || conn.id}</span>
                        <span className={`badge-flow ${dir}`}>{dir.toUpperCase()}</span>
                      </div>
                      <span className="connector-size">{sizeText}</span>
                    </div>

                    <div className="connector-meta-row">
                      <span className="connector-system">
                        {conn.systemType}
                        {referenceHost ? " · reference plane" : ""}
                      </span>
                      <span className="connector-coords">({coordinates})</span>
                      <button
                        type="button"
                        className={`connector-host-toggle${referenceHost ? " ref" : ""}`}
                        onClick={() =>
                          onUpdateConnectorHost?.(
                            conn.id,
                            referenceHost ? "solid" : "reference-plane",
                          )
                        }
                        disabled={!onUpdateConnectorHost}
                        title="Đổi kiểu host của connector"
                      >
                        {referenceHost ? "Reference plane" : "Solid face"}
                      </button>
                    </div>

                    {conn.flow !== undefined && (
                      <div className="connector-flow-row">
                        <span>Flow: {conn.flow} {conn.flowUnit || "L/s"}</span>
                        {conn.pressureDrop !== undefined && <span> · ΔP: {conn.pressureDrop} Pa</span>}
                      </div>
                    )}

                    {isOrphan && (
                      <div className="connector-orphan-warning">
                        ⚠ Cổng kết nối đang bị lơ lửng, không chạm bề mặt chi tiết nào!
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div className="banner info">
            {spec.connectors?.length ?? 0} MEP connectors configured
          </div>
        </div>
      )}
      {tab === "types" && (
        <TypesPanel
          spec={spec}
          resolved={analysis.parameters.parameters}
          units={units}
          types={types}
          onChange={onChangeTypes}
          onPreview={onPreviewType}
          onExport={onExportTypes}
          exporting={exportingTypes}
          previewActive={previewTypeActive}
        />
      )}
    </section>
  );
}
