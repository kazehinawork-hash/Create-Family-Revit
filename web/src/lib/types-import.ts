import * as XLSX from "xlsx";
import type { FamilyParameter, FamilyTypeEntry } from "@family/spec-core";

export interface ImportColumn {
  /** Spreadsheet column index. */
  index: number;
  /** Length parameter this column feeds. */
  parameter: string;
}

export interface ImportIssue {
  line: number;
  message: string;
}

export interface ImportResult {
  rows: FamilyTypeEntry[];
  issues: ImportIssue[];
  /** Headers that matched no Length parameter. */
  ignoredColumns: string[];
  /** Table columns the file did not provide; they fall back to the current values. */
  missingColumns: string[];
}

export interface ComboEntry {
  column: string;
  values: number[];
}

const TYPE_NAME_HEADERS = ["type name", "name", "type"];

export function normalizeHeader(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Length parameters without a formula can be driven from a spreadsheet. */
export function driverParameters(parameters: FamilyParameter[]): string[] {
  return parameters
    .filter((parameter) => parameter.type === "Length" && !parameter.formula)
    .map((parameter) => parameter.name);
}

export function matchColumns(headers: unknown[], drivers: string[]): {
  columns: ImportColumn[];
  nameColumn: number | null;
  ignoredColumns: string[];
} {
  const byName = new Map(drivers.map((name) => [name.trim().toLowerCase(), name]));
  const columns: ImportColumn[] = [];
  const ignoredColumns: string[] = [];
  let nameColumn: number | null = null;

  headers.forEach((header, index) => {
    const key = normalizeHeader(header);
    if (!key) return;

    if (nameColumn === null && TYPE_NAME_HEADERS.includes(key)) {
      nameColumn = index;
      return;
    }

    const parameter = byName.get(key);
    if (parameter) columns.push({ index, parameter });
    else ignoredColumns.push(String(header).trim());
  });

  return { columns, nameColumn, ignoredColumns };
}

/** Minimal RFC 4180 reader: quotes, escaped quotes, CRLF and a trailing newline. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === "," || char === ";") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0));
}

/** Reads .csv/.txt as text and .xlsx/.xls through SheetJS, always as a cell grid. */
export async function readTable(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    return parseCsv(await file.text());
  }

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" });
  return rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))));
}

function numberFromCell(value: string): number | null {
  const cleaned = value.replace(/\s/g, "").replace(/mm$/i, "").replace(",", ".");
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

export function mapImport(
  table: string[][],
  drivers: string[],
  options: {
    /** Columns the table shows; missing file columns fall back to these values. */
    columns: string[];
    defaults: Record<string, number>;
    prefix: string;
    buildName: (values: Record<string, number>, columns: string[]) => string;
  },
): ImportResult {
  const issues: ImportIssue[] = [];
  const rows: FamilyTypeEntry[] = [];

  if (table.length === 0) {
    return { rows, issues: [{ line: 1, message: "File rỗng." }], ignoredColumns: [], missingColumns: [] };
  }

  const { columns, nameColumn, ignoredColumns } = matchColumns(table[0], drivers);

  if (columns.length === 0) {
    return {
      rows,
      issues: [{ line: 1, message: "Không có cột nào khớp tên tham số Length." }],
      ignoredColumns,
      missingColumns: [],
    };
  }

  const provided = new Set(columns.map((column) => column.parameter));
  const missingColumns = options.columns.filter((column) => !provided.has(column));
  const matchedColumns = columns.map((column) => column.parameter);
  const takenNames = new Set<string>();

  for (let index = 1; index < table.length; index += 1) {
    const cells = table[index];
    const line = index + 1;
    const values: Record<string, number> = { ...options.defaults };
    let failed = false;

    for (const column of columns) {
      const raw = cells[column.index] ?? "";
      const number = numberFromCell(raw);
      if (number === null) {
        issues.push({ line, message: `${column.parameter}: "${raw}" không phải số.` });
        failed = true;
        continue;
      }
      if (number <= 0) {
        issues.push({ line, message: `${column.parameter}: ${number} ≤ 0.` });
        failed = true;
        continue;
      }
      values[column.parameter] = number;
    }

    if (failed) continue;

    const explicitName = nameColumn === null ? "" : String(cells[nameColumn] ?? "").trim();
    let name = explicitName || options.buildName(values, matchedColumns);
    let suffix = 2;
    while (takenNames.has(name.trim().toLowerCase())) {
      name = `${explicitName || options.buildName(values, matchedColumns)} ${suffix}`;
      suffix += 1;
    }
    takenNames.add(name.trim().toLowerCase());

    rows.push({
      name,
      values,
      autoName: explicitName.length === 0,
    });
  }

  return { rows, issues, ignoredColumns, missingColumns };
}

/** Cartesian product of the per-column value lists, in column order. */
export function combinations(entries: ComboEntry[]): Record<string, number>[] {
  let result: Record<string, number>[] = [{}];

  for (const entry of entries) {
    const next: Record<string, number>[] = [];
    for (const partial of result) {
      for (const value of entry.values) next.push({ ...partial, [entry.column]: value });
    }
    result = next;
  }

  return result;
}

/** Very rough RFA size: a baked set per type, one form at a time. */
export const BYTES_PER_FORM = 45 * 1024;

export function estimateSizeMb(typeCount: number, forms: number): number {
  const bytes = typeCount * Math.max(1, forms) * BYTES_PER_FORM;
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

export function toCsv(headers: string[], rows: Array<Array<string | number>>): string {
  const escape = (value: string | number): string => {
    const text = String(value ?? "");
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
}
