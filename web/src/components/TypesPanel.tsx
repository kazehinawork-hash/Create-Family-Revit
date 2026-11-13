import { useEffect, useMemo, useRef, useState } from "react";
import type { FamilySpec, FamilyTypeEntry, ResolvedParameter } from "@family/spec-core";
import type { Units } from "../lib/format";
import {
  combinations,
  driverParameters,
  estimateSizeMb,
  mapImport,
  readTable,
  toCsv,
  type ImportResult,
} from "../lib/types-import";

interface Props {
  spec: FamilySpec;
  resolved: ResolvedParameter[];
  units: Units;
  types: FamilyTypeEntry[];
  onChange: (types: FamilyTypeEntry[]) => void;
  onPreview: (values: Record<string, number> | null) => void;
  onExport: () => void;
  exporting?: boolean;
  previewActive?: boolean;
}

const BIG_FAMILY_TYPES = 30;

/** "TP-CLT-MT 400x300x100" -> "TP-CLT-MT"; anything else keeps its own name. */
function derivePrefix(typeName?: string): string {
  const text = (typeName ?? "").trim();
  if (!text) return "TYPE";

  const stripped = text.replace(/\s*\d+(?:[.,]\d+)?(?:\s*x\s*\d+(?:[.,]\d+)?)+\s*$/i, "").trim();
  return stripped || "TYPE";
}

function formatValue(value: number | undefined): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return String(Math.round(number * 10) / 10);
}

function buildName(prefix: string, values: Record<string, number>, columns: string[]): string {
  const size = columns.map((column) => formatValue(values[column])).join("x");
  return `${prefix} ${size}`.trim();
}

function sameValues(a: Record<string, number>, b: Record<string, number>, columns: string[]): boolean {
  return columns.every((column) => formatValue(a[column]) === formatValue(b[column]));
}

/** Adds a numeric suffix until the name is free, and records it. */
function uniqueTypeName(base: string, taken: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate.trim().toLowerCase())) {
    candidate = `${base} ${suffix}`;
    suffix += 1;
  }
  taken.add(candidate.trim().toLowerCase());
  return candidate;
}

/** Generated names use the visible columns, or "prefix 1/2/…" when there are none. */
function nextTypeName(
  values: Record<string, number>,
  prefix: string,
  columns: string[],
  taken: Set<string>,
): string {
  if (columns.length > 0) return uniqueTypeName(buildName(prefix, values, columns), taken);

  let index = 1;
  while (taken.has(`${prefix} ${index}`.trim().toLowerCase())) index += 1;
  return uniqueTypeName(`${prefix} ${index}`, taken);
}

function parseNumberList(text: string): number[] {
  return text
    .split(/[,;\s]+/)
    .map((part) => Number(part.trim().replace(",", ".")))
    .filter((value) => Number.isFinite(value) && value > 0);
}

export function TypesPanel({
  spec,
  resolved,
  units,
  types,
  onChange,
  onPreview,
  onExport,
  exporting = false,
  previewActive = false,
}: Props) {
  const drivers = useMemo(() => driverParameters(spec.parameters), [spec.parameters]);
  const lengthParameters = useMemo(() => new Set(drivers), [drivers]);

  const [extraColumns, setExtraColumns] = useState<string[]>([]);
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([]);
  const [prefix, setPrefix] = useState(() => derivePrefix(spec.typeName));
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [previewedIndex, setPreviewedIndex] = useState<number | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ column: string; direction: "asc" | "desc" } | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [comboOpen, setComboOpen] = useState(false);
  const [comboText, setComboText] = useState<Record<string, string>>({});
  const [comboSmallerOnly, setComboSmallerOnly] = useState(true);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setPrefix(derivePrefix(spec.typeName));
  }, [spec.typeName]);

  useEffect(() => {
    if (!previewActive) setPreviewedIndex(null);
  }, [previewActive]);

  /**
   * The table starts with no data columns: a column exists only when the user picked it
   * with "+ Cột", or when a row already carries a value for that driver (reopened spec,
   * pasted list, imported file, combinations, catalogue).
   */
  const columns = useMemo(() => {
    const extras: string[] = [];
    for (const name of [...extraColumns, ...types.flatMap((type) => Object.keys(type.values ?? {}))]) {
      if (extras.includes(name)) continue;
      if (hiddenColumns.includes(name)) continue;
      if (!lengthParameters.has(name)) continue;
      extras.push(name);
    }

    return extras;
  }, [lengthParameters, extraColumns, hiddenColumns, types]);

  // A column can disappear; drop a stale sort key instead of sorting against nothing.
  useEffect(() => {
    if (sort && sort.column !== "type" && !columns.includes(sort.column)) setSort(null);
  }, [columns, sort]);

  const currentValues = useMemo(() => {
    const values: Record<string, number> = {};
    for (const name of columns) {
      const parameter = resolved.find((item) => item.name === name);
      values[name] = typeof parameter?.value === "number" ? parameter.value : 0;
    }
    return values;
  }, [columns, resolved]);

  const driverOptions = useMemo(
    () => drivers.filter((name) => !columns.includes(name)),
    [drivers, columns],
  );

  const isAutoNamed = (type: FamilyTypeEntry): boolean =>
    type.autoName ?? type.name === buildName(prefix, type.values ?? {}, columns);

  /* ---------------------------------------------------------------- validation */

  /** Blocks the export. */
  const problems = useMemo(() => {
    const byName = new Map<string, number>();
    const issues: string[] = [];

    for (const type of types) {
      const key = type.name.trim().toLowerCase();
      if (!key) issues.push("Tên type không được để trống.");
      byName.set(key, (byName.get(key) ?? 0) + 1);

      for (const [name, value] of Object.entries(type.values ?? {})) {
        if (!Number.isFinite(value) || value <= 0) issues.push(`${type.name}: ${name} ≤ 0.`);
      }
    }

    for (const [name, count] of byName) {
      if (count > 1) issues.push(`Trùng tên type: ${name}.`);
    }

    return [...new Set(issues)];
  }, [types]);

  /** Yellow, informational: the export still runs. */
  const warnings = useMemo(() => {
    const list: string[] = [];

    if (columns.length > 0) {
      for (let i = 0; i < types.length; i += 1) {
        for (let j = i + 1; j < types.length; j += 1) {
          if (sameValues(types[i].values ?? {}, types[j].values ?? {}, columns)) {
            list.push(`"${types[i].name}" và "${types[j].name}" trùng toàn bộ giá trị.`);
          }
        }
      }
    }

    const hasBoth = lengthParameters.has("Ladder Width 1") && lengthParameters.has("Ladder Width 2");
    if (hasBoth) {
      for (const type of types) {
        const w1 = type.values?.["Ladder Width 1"];
        const w2 = type.values?.["Ladder Width 2"];
        if (Number.isFinite(w1) && Number.isFinite(w2) && w2 > w1) {
          list.push(`"${type.name}": Ladder Width 2 (${formatValue(w2)}) lớn hơn Ladder Width 1 (${formatValue(w1)}).`);
        }
      }
    }

    return list;
  }, [types, columns, lengthParameters]);

  const estimate = estimateSizeMb(types.length, spec.parts.length);

  /* ------------------------------------------------------------------- editing */

  const updateRow = (index: number, patch: Partial<FamilyTypeEntry>) => {
    onChange(types.map((type, i) => (i === index ? { ...type, ...patch } : type)));
  };

  const updateValue = (index: number, column: string, value: number) => {
    onChange(
      types.map((type, i) => {
        if (i !== index) return type;

        const values = { ...type.values, [column]: value };
        const auto = isAutoNamed(type);
        return { ...type, values, autoName: auto, name: auto ? buildName(prefix, values, columns) : type.name };
      }),
    );
  };

  const updateName = (index: number, name: string) => {
    updateRow(index, { name, autoName: false });
  };

  /**
   * Names are unique per list. With no columns the generated name is "prefix 1",
   * "prefix 2"… because there is no size to append.
   */
  const applyPrefix = (next: string) => {
    setPrefix(next);

    const taken = new Set<string>();
    let counter = 0;
    onChange(
      types.map((type) => {
        if (!isAutoNamed(type)) {
          taken.add(type.name.trim().toLowerCase());
          return type;
        }

        counter += 1;
        const base = columns.length > 0 ? buildName(next, type.values ?? {}, columns) : `${next} ${counter}`;
        return { ...type, autoName: true, name: uniqueTypeName(base, taken) };
      }),
    );
  };

  const duplicateRow = (index: number) => {
    const source = types[index];
    if (!source) return;

    const taken = new Set(types.map((type) => type.name.trim().toLowerCase()));
    let name = `${source.name} copy`;
    let suffix = 2;
    while (taken.has(name.trim().toLowerCase())) {
      name = `${source.name} copy ${suffix}`;
      suffix += 1;
    }

    onChange([
      ...types.slice(0, index + 1),
      { name, values: { ...(source.values ?? {}) }, autoName: source.autoName },
      ...types.slice(index + 1),
    ]);
  };

  const removeRow = (index: number) => {
    setPreviewedIndex(null);
    setSelected((current) => current.filter((value) => value !== index).map((value) => (value > index ? value - 1 : value)));
    onPreview(null);
    onChange(types.filter((_, i) => i !== index));
  };

  const removeSelected = () => {
    if (selected.length === 0) return;
    const drop = new Set(selected);
    setSelected([]);
    setPreviewedIndex(null);
    onPreview(null);
    onChange(types.filter((_, index) => !drop.has(index)));
  };

  const removeColumn = (name: string) => {
    setExtraColumns((current) => current.filter((column) => column !== name));
    setHiddenColumns((current) => (current.includes(name) ? current : [...current, name]));
    onChange(
      types.map((type) => {
        const values = { ...(type.values ?? {}) };
        delete values[name];
        return { ...type, values };
      }),
    );
  };

  const previewRow = (index: number) => {
    if (previewedIndex === index) {
      setPreviewedIndex(null);
      onPreview(null);
      return;
    }
    setPreviewedIndex(index);
    onPreview(types[index].values);
  };

  /* -------------------------------------------------------------------- import */

  const startResize = (
    key: string,
    event: { clientX: number; preventDefault: () => void; stopPropagation: () => void },
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = widths[key] ?? (key === "type" ? 160 : 78);

    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.max(64, startWidth + moveEvent.clientX - startX);
      setWidths((current) => ({ ...current, [key]: next }));
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing");
    };

    document.body.classList.add("resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleFile = async (file: File | null | undefined) => {
    if (!file) return;
    setImportError(null);

    try {
      const table = await readTable(file);
      const result = mapImport(table, drivers, {
        columns,
        defaults: currentValues,
        prefix,
        buildName: (values, matchedColumns) => buildName(prefix, values, matchedColumns),
      });
      setImportPreview(result);
    } catch (error) {
      setImportPreview(null);
      setImportError(error instanceof Error ? error.message : String(error));
    }
  };

  const applyImport = (replace: boolean) => {
    if (!importPreview) return;
    const rows = importPreview.rows;
    onChange(replace ? rows : [...types, ...rows]);
    setImportPreview(null);
    setSelected([]);
  };

  const downloadTemplate = () => {
    const headers = ["Type Name", ...columns];
    const exampleName = columns.length > 0 ? buildName(prefix, currentValues, columns) : `${prefix} 1`;
    const example = [exampleName, ...columns.map((column) => currentValues[column] ?? 0)];
    const blob = new Blob([toCsv(headers, [example])], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "types-template.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  /* --------------------------------------------------------------- combinations */

  const comboEntries = useMemo(
    () =>
      columns
        .map((column) => ({ column, values: parseNumberList(comboText[column] ?? "") }))
        .filter((entry) => entry.values.length > 0),
    [columns, comboText],
  );

  const comboRows = useMemo(() => {
    if (comboEntries.length === 0) return [];

    const hasBoth = lengthParameters.has("Ladder Width 1") && lengthParameters.has("Ladder Width 2");
    const existing = new Set(
      types.map((type) => columns.map((column) => formatValue(type.values?.[column])).join("|")),
    );

    const taken = new Set(types.map((type) => type.name.trim().toLowerCase()));

    return combinations(comboEntries)
      .filter((values) => {
        if (!hasBoth || !comboSmallerOnly) return true;
        const w1 = values["Ladder Width 1"];
        const w2 = values["Ladder Width 2"];
        return w1 === undefined || w2 === undefined || w2 <= w1;
      })
      .filter((values) => !existing.has(columns.map((column) => formatValue(values[column])).join("|")))
      .map<FamilyTypeEntry>((values) => {
        // Columns without a value list keep the current value, and the generated name
        // must reflect that merged row rather than the partial combination.
        const merged = { ...currentValues, ...values };
        return { name: nextTypeName(merged, prefix, columns, taken), values: merged, autoName: true };
      });
  }, [comboEntries, types, columns, lengthParameters, comboSmallerOnly, prefix, currentValues]);

  const addCombos = () => {
    if (comboRows.length === 0) return;
    onChange([...types, ...comboRows]);
    setComboOpen(false);
  };

  /* ------------------------------------------------------------------ catalogue */

  const catalog = useMemo<FamilyTypeEntry[]>(() => {
    const raw = (spec as { typeCatalog?: unknown }).typeCatalog;
    if (Array.isArray(raw) && raw.length > 0) {
      return raw
        .map((entry): FamilyTypeEntry | null => {
          if (typeof entry === "string") {
            const values = entry
              .split(/x/i)
              .map((part) => Number(part.trim()))
              .reduce<Record<string, number>>((accumulator, value, column) => {
                accumulator[columns[column] ?? `Column ${column + 1}`] = value;
                return accumulator;
              }, {});
            return { name: entry, values, autoName: false };
          }
          if (entry && typeof entry === "object") {
            const object = entry as { name?: string; values?: Record<string, number> };
            const values = object.values ?? {};
            return {
              name: object.name ?? buildName(prefix, values, columns),
              values,
              autoName: object.name ? false : true,
            };
          }
          return null;
        })
        .filter((entry): entry is FamilyTypeEntry => entry !== null);
    }
    return spec.types ?? [];
  }, [spec, columns, prefix]);

  const loadCatalog = () => {
    if (catalog.length === 0) return;
    const seen = new Set(types.map((type) => type.name.trim().toLowerCase()));
    onChange([...types, ...catalog.filter((entry) => !seen.has(entry.name.trim().toLowerCase()))]);
  };

  const pasteRow = () => {
    if (columns.length === 0) {
      setPasteError("Chưa có cột nào. Bấm “+ Cột” để chọn tham số kích thước trước khi dán.");
      return;
    }

    const lines = pasteText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      setPasteError("Chưa có dòng nào.");
      return;
    }

    const taken = new Set(types.map((type) => type.name.trim().toLowerCase()));
    const parsed: FamilyTypeEntry[] = [];
    for (const line of lines) {
      const cells = line.includes("\t") ? line.split("\t") : line.split(/x/i);
      if (cells.length < columns.length) {
        setPasteError(`Thiếu giá trị: "${line}" cần ${columns.length} số.`);
        return;
      }

      const values: Record<string, number> = {};
      for (let index = 0; index < columns.length; index += 1) {
        const raw = cells[index]?.replace(/[^\d.,-]/g, "").replace(",", ".");
        const value = Number(raw);
        if (!raw || !Number.isFinite(value) || value <= 0) {
          setPasteError(`Giá trị không hợp lệ ở dòng: "${line}"`);
          return;
        }
        values[columns[index]] = value;
      }

      parsed.push({ name: nextTypeName(values, prefix, columns, taken), values, autoName: true });
    }

    setPasteError(null);
    setPasteText("");
    setPasteOpen(false);
    onChange([...types, ...parsed]);
  };

  /* --------------------------------------------------------------------- render */

  const visibleRows = useMemo(() => {
    const search = filter.trim().toLowerCase();
    const rows = types
      .map((type, index) => ({ type, index }))
      .filter(({ type }) => !search || type.name.toLowerCase().includes(search));

    if (!sort) return rows;

    const direction = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort.column === "type") return a.type.name.localeCompare(b.type.name) * direction;
      const left = Number(a.type.values?.[sort.column] ?? 0);
      const right = Number(b.type.values?.[sort.column] ?? 0);
      return (left - right) * direction;
    });
  }, [types, filter, sort]);

  const toggleSort = (column: string) => {
    setSort((current) => {
      if (current?.column !== column) return { column, direction: "asc" };
      return { column, direction: current.direction === "asc" ? "desc" : "asc" };
    });
  };

  const sortMark = (column: string) =>
    sort?.column === column ? (sort.direction === "asc" ? " ▲" : " ▼") : "";

  const allVisibleSelected =
    visibleRows.length > 0 && visibleRows.every(({ index }) => selected.includes(index));

  const toggleAll = () => {
    if (allVisibleSelected) {
      const visible = new Set(visibleRows.map(({ index }) => index));
      setSelected((current) => current.filter((index) => !visible.has(index)));
      return;
    }
    setSelected((current) => [...new Set([...current, ...visibleRows.map(({ index }) => index)])]);
  };

  return (
    <div className="types-panel" data-testid="types-panel">
      <div className="types-toolbar">
        <label className="types-prefix">
          <span>Tiền tố</span>
          <input
            value={prefix}
            aria-label="Type prefix"
            onChange={(event) => applyPrefix(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="types-btn"
          onClick={() => setPasteOpen((open) => !open)}
          data-testid="paste-toggle"
        >
          Dán danh sách
        </button>
        <button
          type="button"
          className="types-btn"
          onClick={() => fileInput.current?.click()}
          data-testid="import-file"
        >
          Nhập file…
        </button>
        <button type="button" className="types-btn" onClick={downloadTemplate} data-testid="download-template">
          Tải file mẫu
        </button>
        <button
          type="button"
          className="types-btn"
          onClick={() => setComboOpen((open) => !open)}
          data-testid="combo-toggle"
        >
          Tạo tổ hợp
        </button>
        <button
          type="button"
          className="types-btn"
          onClick={loadCatalog}
          disabled={catalog.length === 0}
          title={catalog.length === 0 ? "Spec không có type catalog" : `Nạp ${catalog.length} type từ catalog`}
          data-testid="load-catalog"
        >
          Lấy từ catalog
        </button>
        <button
          type="button"
          className="types-btn"
          onClick={() => setAddColumnOpen((open) => !open)}
          data-testid="add-column"
        >
          + Cột
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.xlsx,.xls,text/csv"
          style={{ display: "none" }}
          data-testid="import-input"
          onChange={(event) => {
            void handleFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>

      {addColumnOpen && (
        <div className="types-popover">
          {driverOptions.length === 0 ? (
            <span className="types-hint">Không còn tham số dẫn động để thêm.</span>
          ) : (
            driverOptions.map((name) => (
              <button
                key={name}
                type="button"
                className="types-chip"
                onClick={() => {
                  setHiddenColumns((current) => current.filter((column) => column !== name));
                  setExtraColumns((current) => (current.includes(name) ? current : [...current, name]));
                  setAddColumnOpen(false);
                }}
              >
                {name}
              </button>
            ))
          )}
        </div>
      )}

      {pasteOpen && (
        <div className="types-popover" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <textarea
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder={"400x300x100\n500x300x100\nhoặc dán cột từ Excel"}
            rows={5}
            aria-label="Paste type list"
            data-testid="paste-input"
          />
          {pasteError && <span className="types-error">{pasteError}</span>}
          <button type="button" className="types-btn" onClick={pasteRow} data-testid="paste-apply">
            Nhập danh sách
          </button>
        </div>
      )}

      {comboOpen && (
        <div className="types-popover types-combo" data-testid="combo-panel">
          {columns.length === 0 ? (
            <div className="types-hint" data-testid="combo-hint">
              Chưa có cột nào. Bấm “+ Cột” để chọn tham số kích thước trước khi tạo tổ hợp.
            </div>
          ) : (
            <div className="types-combo-grid">
              {columns.map((column) => (
                <label key={column}>
                  <span>{column}</span>
                  <input
                    value={comboText[column] ?? ""}
                    placeholder="200,300,400"
                    aria-label={`Combo ${column}`}
                    onChange={(event) =>
                      setComboText((current) => ({ ...current, [column]: event.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
          )}

          {lengthParameters.has("Ladder Width 1") && lengthParameters.has("Ladder Width 2") && (
            <label className="types-checkbox">
              <input
                type="checkbox"
                checked={comboSmallerOnly}
                onChange={(event) => setComboSmallerOnly(event.target.checked)}
                data-testid="combo-smaller"
              />
              Chỉ giữ Ladder Width 2 ≤ Ladder Width 1
            </label>
          )}

          <div className="types-combo-actions">
            <span data-testid="combo-count">Sẽ tạo {comboRows.length} type</span>
            {comboRows.length > 60 && (
              <span className="types-warning-inline">⚠ Hơn 60 type: file RFA sẽ rất nặng.</span>
            )}
            <button
              type="button"
              className="types-btn"
              disabled={comboRows.length === 0}
              onClick={addCombos}
              data-testid="combo-apply"
            >
              Thêm {comboRows.length} type
            </button>
          </div>
        </div>
      )}

      {importPreview && (
        <div className="types-popover types-import" data-testid="import-preview">
          <div className="types-import-head">
            <strong data-testid="import-summary">
              {importPreview.rows.length} dòng hợp lệ · {importPreview.issues.length} lỗi
            </strong>
            <button type="button" className="types-btn" onClick={() => setImportPreview(null)}>
              Huỷ
            </button>
          </div>

          {importPreview.ignoredColumns.length > 0 && (
            <div className="types-warning-inline">
              Bỏ qua cột không khớp: {importPreview.ignoredColumns.join(", ")}
            </div>
          )}
          {importPreview.missingColumns.length > 0 && (
            <div className="types-warning-inline">
              Thiếu cột, dùng giá trị hiện tại: {importPreview.missingColumns.join(", ")}
            </div>
          )}

          {importPreview.issues.length > 0 && (
            <div className="types-import-issues">
              {importPreview.issues.slice(0, 8).map((issue) => (
                <div key={`${issue.line}-${issue.message}`} data-testid="import-issue">
                  Dòng {issue.line}: {issue.message}
                </div>
              ))}
              {importPreview.issues.length > 8 && <div>… và {importPreview.issues.length - 8} lỗi nữa.</div>}
            </div>
          )}

          <div className="types-import-rows">
            {importPreview.rows.slice(0, 6).map((row) => (
              <div key={row.name}>
                {row.name} · {columns.map((column) => formatValue(row.values[column])).join(" x ")}
              </div>
            ))}
            {importPreview.rows.length > 6 && <div>… {importPreview.rows.length - 6} dòng nữa</div>}
          </div>

          <div className="types-import-actions">
            <button
              type="button"
              className="types-btn"
              disabled={importPreview.rows.length === 0}
              onClick={() => applyImport(false)}
              data-testid="import-add"
            >
              Thêm {importPreview.rows.length} type
            </button>
            <button
              type="button"
              className="types-btn"
              disabled={importPreview.rows.length === 0}
              onClick={() => applyImport(true)}
              data-testid="import-replace"
            >
              Thay thế danh sách
            </button>
          </div>
        </div>
      )}

      {importError && <div className="types-error">{importError}</div>}

      <div className="types-listbar">
        <label className="types-checkbox">
          <input
            type="checkbox"
            aria-label="Select all types"
            checked={allVisibleSelected}
            onChange={toggleAll}
            data-testid="select-all"
          />
          Chọn tất cả
        </label>
        <input
          className="types-filter"
          value={filter}
          placeholder="Lọc theo tên…"
          aria-label="Filter types"
          data-testid="types-filter"
          onChange={(event) => setFilter(event.target.value)}
        />
        {selected.length > 0 && (
          <button
            type="button"
            className="types-btn danger"
            onClick={removeSelected}
            data-testid="delete-selected"
          >
            Xoá các dòng đã chọn ({selected.length})
          </button>
        )}
      </div>

      <div className={`types-scroll ${Object.keys(widths).length > 0 ? "resizable" : ""}`} data-testid="types-scroll">
        <table className="types-table">
          <colgroup>
            <col style={{ width: widths.type ?? "calc(100% - 250px)" }} />
            {columns.map((column) => (
              <col key={column} style={{ width: widths[column] ?? 54 }} />
            ))}
            <col style={{ width: 88 }} />
          </colgroup>
          <thead>
            <tr>
              <th onClick={() => toggleSort("type")} data-testid="sort-type">
                Type (mm){sortMark("type")}
                <span
                  className="types-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize Type column"
                  onPointerDown={(event) => startResize("type", event)}
                />
              </th>
              {columns.map((column) => (
                <th
                  key={column}
                  className="types-number-col"
                  onClick={() => toggleSort(column)}
                  data-testid={`sort-${column}`}
                >
                  <button
                    type="button"
                    className="types-column-remove"
                    aria-label={`Remove ${column} column`}
                    title="Gỡ cột"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeColumn(column);
                    }}
                  >
                    ✕
                  </button>
                  {column}
                  {units === "mm" ? "" : " (ft-in)"}
                  {sortMark(column)}
                  <span
                    className="types-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${column} column`}
                    onPointerDown={(event) => startResize(column, event)}
                  />
                </th>
              ))}
              <th className="types-actions" aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} className="types-hint">
                  {types.length === 0
                    ? "Chưa có type nào. Dùng “Dán danh sách”, “Nhập file…” hoặc nhân bản một dòng."
                    : "Không dòng nào khớp bộ lọc."}
                </td>
              </tr>
            )}
            {columns.length === 0 && (
              <tr>
                <td
                  colSpan={2}
                  className="types-hint"
                  data-testid="no-columns-hint"
                >
                  Bấm “+ Cột” để chọn tham số kích thước cho từng type.
                </td>
              </tr>
            )}
            {visibleRows.map(({ type, index }) => {
              const previewing = previewedIndex === index && previewActive;
              return (
                <tr
                  key={index}
                  data-testid={`type-row-${index}`}
                  className={previewing ? "previewing" : undefined}
                >
                  <td>
                    <div className="types-name-cell">
                      <input
                        className="types-name"
                        value={type.name}
                        title={type.name}
                        aria-label={`Type name ${index + 1}`}
                        onChange={(event) => updateName(index, event.target.value)}
                      />
                    </div>
                  </td>
                  {columns.map((column) => (
                    <td key={column} className="types-number-col">
                      <input
                        className="types-value"
                        type="number"
                        value={type.values?.[column] ?? 0}
                        aria-label={`Type ${index + 1} ${column}`}
                        onChange={(event) => updateValue(index, column, Number(event.target.value))}
                      />
                    </td>
                  ))}
                  <td className="types-actions">
                    <input
                      type="checkbox"
                      aria-label={`Select ${type.name}`}
                      checked={selected.includes(index)}
                      onChange={() =>
                        setSelected((current) =>
                          current.includes(index)
                            ? current.filter((value) => value !== index)
                            : [...current, index],
                        )
                      }
                      data-testid={`select-row-${index}`}
                    />
                    <button
                      type="button"
                      className={`types-icon ${previewing ? "active" : ""}`}
                      onClick={() => previewRow(index)}
                      aria-label={`Preview ${type.name}`}
                      title="Xem trước 3D"
                    >
                      👁
                    </button>
                    <button
                      type="button"
                      className="types-icon"
                      onClick={() => duplicateRow(index)}
                      aria-label={`Duplicate ${type.name}`}
                      title="Nhân bản dòng"
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      className="types-icon"
                      onClick={() => removeRow(index)}
                      aria-label={`Delete ${type.name}`}
                      title="Xoá type"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {problems.length > 0 && (
        <div className="types-error" data-testid="types-problems">
          {problems.join(" ")}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="types-warning" data-testid="types-warnings">
          {warnings.map((warning) => (
            <div key={warning}>⚠ {warning}</div>
          ))}
        </div>
      )}

      <div className="types-footer">
        <button
          type="button"
          className="types-export"
          disabled={exporting || types.length === 0 || problems.length > 0}
          onClick={onExport}
          data-testid="export-types"
        >
          {exporting ? "Đang xuất…" : `Xuất RFA nhiều type (${types.length})`}
        </button>
        <span className="types-size" data-testid="types-size">
          ≈ {estimate} MB ({types.length} type × {spec.parts.length} form)
        </span>
        {types.length > BIG_FAMILY_TYPES && (
          <span className="types-warning-inline" data-testid="types-size-warning">
            ⚠ Hơn {BIG_FAMILY_TYPES} type: Revit sẽ chậm và file rất lớn.
          </span>
        )}
      </div>
    </div>
  );
}
