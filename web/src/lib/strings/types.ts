import type { Translation } from "./translation";

/**
 * Types pane labels. Revit vocabulary — Family, Type, LOD, RFA, and every type
 * name, model value or parameter name — stays exactly as authored; only the
 * surrounding interface text is translated.
 *
 * Counts arrive as numbers so each language can pluralise them, measurements
 * arrive pre-formatted by `formatNumber`, and column lists arrive pre-joined.
 */
const viDictionary = {
  // Toolbar and file picker
  typesPrefix: "Tiền tố",
  typesPasteToggle: "Dán danh sách",
  typesImportFile: "Nhập file…",
  typesDownloadTemplate: "Tải file mẫu",
  typesComboToggle: "Tạo tổ hợp",
  typesLoadCatalog: "Lấy từ catalog",
  typesLoadCatalogHint: (count: number) => `Nạp ${count} type từ catalog`,
  typesNoCatalogHint: "Spec không có type catalog",
  typesAddColumn: "+ Cột",
  typesNoDriverParameters: "Không còn tham số dẫn động để thêm.",

  // Paste list
  typesPastePlaceholder: "400x300x100\n500x300x100\nhoặc dán cột từ Excel",
  typesPasteApply: "Nhập danh sách",
  typesPasteNoColumns: "Chưa có cột nào. Bấm “+ Cột” để chọn tham số kích thước trước khi dán.",
  typesPasteNoLines: "Chưa có dòng nào.",
  typesPasteMissingValues: (line: string, count: number) =>
    `Thiếu giá trị: "${line}" cần ${count} số.`,
  typesPasteInvalidValue: (line: string) => `Giá trị không hợp lệ ở dòng: "${line}"`,

  // Combinations
  typesComboNoColumns:
    "Chưa có cột nào. Bấm “+ Cột” để chọn tham số kích thước trước khi tạo tổ hợp.",
  typesComboSmallerOnly: "Chỉ giữ Ladder Width 2 ≤ Ladder Width 1",
  typesComboCount: (count: number) => `Sẽ tạo ${count} type`,
  typesComboTooMany: (limit: number) => `⚠ Hơn ${limit} type: file RFA sẽ rất nặng.`,
  typesComboAdd: (count: number) => `Thêm ${count} type`,

  // Import preview
  typesImportSummary: (rows: number, issues: number) => `${rows} dòng hợp lệ · ${issues} lỗi`,
  typesCancel: "Huỷ",
  typesImportIgnored: (columns: string) => `Bỏ qua cột không khớp: ${columns}`,
  typesImportMissing: (columns: string) => `Thiếu cột, dùng giá trị hiện tại: ${columns}`,
  typesImportIssueLine: (line: number, message: string) => `Dòng ${line}: ${message}`,
  typesImportMoreIssues: (count: number) => `… và ${count} lỗi nữa.`,
  typesImportMoreRows: (count: number) => `… ${count} dòng nữa`,
  typesImportAdd: (count: number) => `Thêm ${count} type`,
  typesImportReplace: "Thay thế danh sách",

  // List toolbar
  typesSelectAll: "Chọn tất cả",
  typesFilterPlaceholder: "Lọc theo tên…",
  typesDeleteSelected: (count: number) => `Xoá các dòng đã chọn (${count})`,

  // Table
  typesRemoveColumn: "Gỡ cột",
  typesEmpty: "Chưa có type nào. Dùng “Dán danh sách”, “Nhập file…” hoặc nhân bản một dòng.",
  typesNoMatches: "Không dòng nào khớp bộ lọc.",
  typesNoColumnsHint: "Bấm “+ Cột” để chọn tham số kích thước cho từng type.",
  typesPreviewRow: "Xem trước 3D",
  typesDuplicateRow: "Nhân bản dòng",
  typesDeleteRow: "Xoá type",

  // Footer
  typesExporting: "Đang xuất…",
  typesExportButton: (count: number) => `Xuất RFA nhiều type (${count})`,
  typesSizeEstimate: (size: string, types: number, parts: number) =>
    `≈ ${size} MB (${types} type × ${parts} form)`,
  typesSizeWarning: (limit: number) => `⚠ Hơn ${limit} type: Revit sẽ chậm và file rất lớn.`,

  // Validation (blocks the export) and warnings (informational)
  typesProblemEmptyName: "Tên type không được để trống.",
  typesProblemNonPositive: (typeName: string, parameter: string) =>
    `${typeName}: ${parameter} ≤ 0.`,
  typesProblemDuplicate: (name: string) => `Trùng tên type: ${name}.`,
  typesWarningDuplicateValues: (first: string, second: string) =>
    `"${first}" và "${second}" trùng toàn bộ giá trị.`,
  typesWarningLadderOrder: (typeName: string, width2: string, width1: string) =>
    `"${typeName}": Ladder Width 2 (${width2}) lớn hơn Ladder Width 1 (${width1}).`,

  // Messages raised by the importer, keyed so they can follow the language
  typesIssueEmptyFile: "File rỗng.",
  typesIssueNoLengthColumn: "Không có cột nào khớp tên tham số Length.",
  typesIssueNotNumber: (parameter: string, raw: string) => `${parameter}: "${raw}" không phải số.`,
  typesIssueNonPositive: (parameter: string, value: string) => `${parameter}: ${value} ≤ 0.`,
  typesIssueXlsOnly: "Chỉ đọc được .xlsx — mở file trong Excel và lưu lại dạng .xlsx.",
} as const;

/**
 * Widened on purpose: `strings.ts` merges this module into its `as const`
 * dictionary, and literal types there would make every `en`/`zh` entry
 * unassignable. The key set still comes from the dictionary above.
 */
export const vi: Translation<typeof viDictionary> = viDictionary;

export const en: Translation<typeof vi> = {
  typesPrefix: "Prefix",
  typesPasteToggle: "Paste list",
  typesImportFile: "Import file…",
  typesDownloadTemplate: "Download template",
  typesComboToggle: "Create combinations",
  typesLoadCatalog: "Load from catalog",
  typesLoadCatalogHint: (count: number) =>
    `Load ${count} type${count === 1 ? "" : "s"} from the catalog`,
  typesNoCatalogHint: "The spec has no type catalog",
  typesAddColumn: "+ Column",
  typesNoDriverParameters: "No driver parameters left to add.",

  typesPastePlaceholder: "400x300x100\n500x300x100\nor paste a column from Excel",
  typesPasteApply: "Add list",
  typesPasteNoColumns:
    "No columns yet. Press “+ Column” to pick the size parameters before pasting.",
  typesPasteNoLines: "No lines yet.",
  typesPasteMissingValues: (line: string, count: number) =>
    `Missing values: "${line}" needs ${count} number${count === 1 ? "" : "s"}.`,
  typesPasteInvalidValue: (line: string) => `Invalid value on line: "${line}"`,

  typesComboNoColumns:
    "No columns yet. Press “+ Column” to pick the size parameters before creating combinations.",
  typesComboSmallerOnly: "Keep only Ladder Width 2 ≤ Ladder Width 1",
  typesComboCount: (count: number) => `Will create ${count} type${count === 1 ? "" : "s"}`,
  typesComboTooMany: (limit: number) =>
    `⚠ More than ${limit} types: the RFA file will be very heavy.`,
  typesComboAdd: (count: number) => `Add ${count} type${count === 1 ? "" : "s"}`,

  typesImportSummary: (rows: number, issues: number) =>
    `${rows} valid row${rows === 1 ? "" : "s"} · ${issues} error${issues === 1 ? "" : "s"}`,
  typesCancel: "Cancel",
  typesImportIgnored: (columns: string) => `Ignored unmatched columns: ${columns}`,
  typesImportMissing: (columns: string) => `Missing columns, using current values: ${columns}`,
  typesImportIssueLine: (line: number, message: string) => `Line ${line}: ${message}`,
  typesImportMoreIssues: (count: number) => `… and ${count} more error${count === 1 ? "" : "s"}.`,
  typesImportMoreRows: (count: number) => `… ${count} more row${count === 1 ? "" : "s"}`,
  typesImportAdd: (count: number) => `Add ${count} type${count === 1 ? "" : "s"}`,
  typesImportReplace: "Replace the list",

  typesSelectAll: "Select all",
  typesFilterPlaceholder: "Filter by name…",
  typesDeleteSelected: (count: number) => `Delete selected rows (${count})`,

  typesRemoveColumn: "Remove column",
  typesEmpty: "No types yet. Use “Paste list”, “Import file…” or duplicate a row.",
  typesNoMatches: "No row matches the filter.",
  typesNoColumnsHint: "Press “+ Column” to pick the size parameters for each type.",
  typesPreviewRow: "Preview in 3D",
  typesDuplicateRow: "Duplicate row",
  typesDeleteRow: "Delete type",

  typesExporting: "Exporting…",
  typesExportButton: (count: number) => `Export multi-type RFA (${count})`,
  typesSizeEstimate: (size: string, types: number, parts: number) =>
    `≈ ${size} MB (${types} type${types === 1 ? "" : "s"} × ${parts} form${parts === 1 ? "" : "s"})`,
  typesSizeWarning: (limit: number) =>
    `⚠ More than ${limit} types: Revit slows down and the file gets very large.`,

  typesProblemEmptyName: "Type name cannot be empty.",
  typesProblemNonPositive: (typeName: string, parameter: string) =>
    `${typeName}: ${parameter} ≤ 0.`,
  typesProblemDuplicate: (name: string) => `Duplicate type name: ${name}.`,
  typesWarningDuplicateValues: (first: string, second: string) =>
    `"${first}" and "${second}" have identical values.`,
  typesWarningLadderOrder: (typeName: string, width2: string, width1: string) =>
    `"${typeName}": Ladder Width 2 (${width2}) is larger than Ladder Width 1 (${width1}).`,

  typesIssueEmptyFile: "The file is empty.",
  typesIssueNoLengthColumn: "No column matches a Length parameter name.",
  typesIssueNotNumber: (parameter: string, raw: string) =>
    `${parameter}: "${raw}" is not a number.`,
  typesIssueNonPositive: (parameter: string, value: string) => `${parameter}: ${value} ≤ 0.`,
  typesIssueXlsOnly: "Only .xlsx can be read — open the file in Excel and save it as .xlsx.",
};

export const zh: Translation<typeof vi> = {
  typesPrefix: "前缀",
  typesPasteToggle: "粘贴列表",
  typesImportFile: "导入文件…",
  typesDownloadTemplate: "下载模板",
  typesComboToggle: "生成组合",
  typesLoadCatalog: "从 catalog 加载",
  typesLoadCatalogHint: (count: number) => `从 catalog 加载 ${count} 个 type`,
  typesNoCatalogHint: "Spec 中没有 type catalog",
  typesAddColumn: "+ 列",
  typesNoDriverParameters: "没有可添加的驱动参数。",

  typesPastePlaceholder: "400x300x100\n500x300x100\n或从 Excel 粘贴一列",
  typesPasteApply: "导入列表",
  typesPasteNoColumns: "还没有列。点击“+ 列”选择尺寸参数后再粘贴。",
  typesPasteNoLines: "还没有任何行。",
  typesPasteMissingValues: (line: string, count: number) =>
    `缺少数值："${line}" 需要 ${count} 个数字。`,
  typesPasteInvalidValue: (line: string) => `该行的数值无效："${line}"`,

  typesComboNoColumns: "还没有列。点击“+ 列”选择尺寸参数后再生成组合。",
  typesComboSmallerOnly: "仅保留 Ladder Width 2 ≤ Ladder Width 1",
  typesComboCount: (count: number) => `将生成 ${count} 个 type`,
  typesComboTooMany: (limit: number) => `⚠ 超过 ${limit} 个 type：RFA 文件会非常大。`,
  typesComboAdd: (count: number) => `添加 ${count} 个 type`,

  typesImportSummary: (rows: number, issues: number) => `${rows} 行有效 · ${issues} 个错误`,
  typesCancel: "取消",
  typesImportIgnored: (columns: string) => `已忽略不匹配的列：${columns}`,
  typesImportMissing: (columns: string) => `缺少列，使用当前值：${columns}`,
  typesImportIssueLine: (line: number, message: string) => `第 ${line} 行：${message}`,
  typesImportMoreIssues: (count: number) => `… 还有 ${count} 个错误。`,
  typesImportMoreRows: (count: number) => `… 还有 ${count} 行`,
  typesImportAdd: (count: number) => `添加 ${count} 个 type`,
  typesImportReplace: "替换列表",

  typesSelectAll: "全选",
  typesFilterPlaceholder: "按名称筛选…",
  typesDeleteSelected: (count: number) => `删除选中的行（${count}）`,

  typesRemoveColumn: "移除列",
  typesEmpty: "还没有 type。使用“粘贴列表”、“导入文件…”或复制一行。",
  typesNoMatches: "没有符合筛选条件的行。",
  typesNoColumnsHint: "点击“+ 列”为每个 type 选择尺寸参数。",
  typesPreviewRow: "3D 预览",
  typesDuplicateRow: "复制行",
  typesDeleteRow: "删除 type",

  typesExporting: "正在导出…",
  typesExportButton: (count: number) => `导出多 type RFA（${count}）`,
  typesSizeEstimate: (size: string, types: number, parts: number) =>
    `≈ ${size} MB（${types} 个 type × ${parts} 个形体）`,
  typesSizeWarning: (limit: number) => `⚠ 超过 ${limit} 个 type：Revit 会变慢，文件会很大。`,

  typesProblemEmptyName: "Type 名称不能为空。",
  typesProblemNonPositive: (typeName: string, parameter: string) =>
    `${typeName}：${parameter} ≤ 0。`,
  typesProblemDuplicate: (name: string) => `Type 名称重复：${name}。`,
  typesWarningDuplicateValues: (first: string, second: string) =>
    `"${first}" 和 "${second}" 的数值完全相同。`,
  typesWarningLadderOrder: (typeName: string, width2: string, width1: string) =>
    `"${typeName}"：Ladder Width 2（${width2}）大于 Ladder Width 1（${width1}）。`,

  typesIssueEmptyFile: "文件为空。",
  typesIssueNoLengthColumn: "没有列匹配 Length 参数名。",
  typesIssueNotNumber: (parameter: string, raw: string) => `${parameter}："${raw}" 不是数字。`,
  typesIssueNonPositive: (parameter: string, value: string) => `${parameter}：${value} ≤ 0。`,
  typesIssueXlsOnly: "只能读取 .xlsx —— 请在 Excel 中打开并另存为 .xlsx。",
};

/**
 * The importer (`lib/types-import.ts`) still raises Vietnamese messages, and a
 * cached job can carry an older build's wording. Known text is mapped to the
 * active language; anything else — including English reader errors — passes through.
 * Parameter names inside the message are Revit data and stay untouched.
 */
export function localizeTypesIssue(message: string, t: Translation<typeof vi>): string {
  const text = String(message ?? "");

  if (/^File rỗng\.$/i.test(text)) return t.typesIssueEmptyFile;
  if (/^Không có cột nào khớp tên tham số Length\.$/i.test(text)) return t.typesIssueNoLengthColumn;
  if (/^Chỉ đọc được \.xlsx/i.test(text)) return t.typesIssueXlsOnly;

  const notNumber = /^(.*?): "(.*)" không phải số\.$/.exec(text);
  if (notNumber) return t.typesIssueNotNumber(notNumber[1], notNumber[2]);

  const nonPositive = /^(.*?): (-?\d+(?:[.,]\d+)?) ≤ 0\.$/.exec(text);
  if (nonPositive) return t.typesIssueNonPositive(nonPositive[1], nonPositive[2]);

  return text;
}
