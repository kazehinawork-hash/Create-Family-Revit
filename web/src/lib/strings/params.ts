import type { Translation } from "./translation";

/**
 * Parameter pane (right sidebar): tabs, parameter groups, parts list and
 * connector cards. Revit terms (Family, Type, LOD, Connector, RFA) and every
 * parameter, part or connector name stay in English — only the chrome around
 * them is translated. Counts arrive pre-formatted by `formatNumber`.
 *
 * Like `chrome.ts`, this dictionary is intentionally not `as const`: `strings.ts`
 * merges the modules with `as const`, which would freeze these values as literal
 * types and stop `en` / `zh` from being assignable to `Strings`.
 */
export const vi = {
  // Selected part strip
  paramsSelectedPartCount: (count: number) => `${count} tham số`,
  paramsClearPartSelection: "Bỏ chọn part",
  paramsPartNoParameters: "Part này không tham chiếu parameter trực tiếp.",

  // Parameter rows
  paramsImpactTitle: (parameters: number, parts: number) =>
    `${parameters} tham số phụ thuộc · ${parts} part bị ảnh hưởng`,
  paramsImpactBadge: (parameters: number, parts: number) => `↳ ${parameters} param · ${parts} part`,
  paramsYesNoToggle: (name: string) => `Bật/Tắt ${name}`,
  paramsYes: "Có",
  paramsNo: "Không",
  paramsDecrease: "Giảm giá trị",
  paramsIncrease: "Tăng giá trị",

  // Parameters tab
  paramsEditingType: "Đang sửa Type",
  paramsNoFilterMatch: "Không có tham số nào khớp bộ lọc.",
  paramsNewNamePlaceholder: "Tên tham số",
  paramsAdd: "Thêm",

  // Parts tab
  paramsRiskFilter: "Rủi ro",
  paramsRiskFilterHint: "Chỉ hiện part sẽ khác preview hoặc mất native form",
  paramsInfoFilter: "Info",
  paramsInfoFilterHint: "Hiện gợi ý info: mặt khít nhau, part bị chôn",
  paramsHighlightHint: "Bấm để làm nổi bật trong khung 3D",
  paramsParityNative: "Part giữ native form trong Revit",
  paramsIssueDotHint: "Cảnh báo bố trí",
  paramsIsolateHint: "Chỉ hiện part này (Isolate)",
  paramsMakeTransparent: "Làm mờ (Ghost / Translucent)",
  paramsMakeOpaque: "Làm đặc lại (Opaque)",
  paramsHidePart: "Ẩn part",
  paramsUnhidePart: "Hiện part",
  paramsParityWarning: (risky: string, total: string) =>
    `${risky}/${total} part sẽ khác preview hoặc mất native form trong .rfa. Bật “Rủi ro” để lọc.`,
  paramsModelSummary: (solids: string, native: string, total: string, materials: string) =>
    `${solids} khối · ${native}/${total} native · ${materials} vật liệu`,

  // Connectors tab
  paramsNoConnectors: "Chưa có MEP Connector nào trong mô hình này.",
  paramsReferencePlane: "Mặt phẳng tham chiếu",
  paramsSolidFace: "Mặt solid",
  paramsHostToggleHint: "Đổi kiểu host của connector",
  paramsFlow: "Lưu lượng",
  paramsOrphanConnector: "Cổng kết nối đang bị lơ lửng, không chạm bề mặt chi tiết nào!",
  paramsConnectorsConfigured: (count: string) => `${count} MEP connector đã cấu hình`,
};

export const en: Translation<typeof vi> = {
  paramsSelectedPartCount: (count) => `${count} parameter${count === 1 ? "" : "s"}`,
  paramsClearPartSelection: "Clear part selection",
  paramsPartNoParameters: "This part does not reference any parameter directly.",

  paramsImpactTitle: (parameters, parts) =>
    `${parameters} dependent parameter${parameters === 1 ? "" : "s"} · ${parts} affected part${
      parts === 1 ? "" : "s"
    }`,
  paramsImpactBadge: (parameters, parts) => `↳ ${parameters} param · ${parts} part`,
  paramsYesNoToggle: (name) => `Toggle ${name}`,
  paramsYes: "Yes",
  paramsNo: "No",
  paramsDecrease: "Decrease value",
  paramsIncrease: "Increase value",

  paramsEditingType: "Editing Type",
  paramsNoFilterMatch: "No parameter matches the filter.",
  paramsNewNamePlaceholder: "Parameter name",
  paramsAdd: "Add",

  paramsRiskFilter: "Risks",
  paramsRiskFilterHint:
    "Show only parts that will differ from the preview or lose their native form",
  paramsInfoFilter: "Info",
  paramsInfoFilterHint: "Show info hints: mating faces and buried parts",
  paramsHighlightHint: "Click to highlight in the 3D viewer",
  paramsParityNative: "Part keeps its native form in Revit",
  paramsIssueDotHint: "Layout warning",
  paramsIsolateHint: "Show only this part (Isolate)",
  paramsMakeTransparent: "Make translucent (Ghost / Translucent)",
  paramsMakeOpaque: "Make opaque",
  paramsHidePart: "Hide part",
  paramsUnhidePart: "Unhide part",
  paramsParityWarning: (risky, total) =>
    `${risky}/${total} parts will differ from the preview or lose their native form in the .rfa. ` +
    `Turn on “Risks” to filter.`,
  paramsModelSummary: (solids, native, total, materials) =>
    `${solids} solids · ${native}/${total} native · ${materials} materials`,

  paramsNoConnectors: "This model has no MEP connector yet.",
  paramsReferencePlane: "Reference plane",
  paramsSolidFace: "Solid face",
  paramsHostToggleHint: "Change the connector host type",
  paramsFlow: "Flow",
  paramsOrphanConnector: "This connector is floating — it does not touch any part face!",
  paramsConnectorsConfigured: (count) => `${count} MEP connectors configured`,
};

export const zh: Translation<typeof vi> = {
  paramsSelectedPartCount: (count) => `${count} 个参数`,
  paramsClearPartSelection: "取消选择零件",
  paramsPartNoParameters: "该零件不直接引用任何参数。",

  paramsImpactTitle: (parameters, parts) => `${parameters} 个依赖参数 · ${parts} 个受影响零件`,
  paramsImpactBadge: (parameters, parts) => `↳ ${parameters} 参数 · ${parts} 零件`,
  paramsYesNoToggle: (name) => `切换 ${name}`,
  paramsYes: "是",
  paramsNo: "否",
  paramsDecrease: "减小数值",
  paramsIncrease: "增大数值",

  paramsEditingType: "正在编辑 Type",
  paramsNoFilterMatch: "没有参数匹配筛选条件。",
  paramsNewNamePlaceholder: "参数名称",
  paramsAdd: "添加",

  paramsRiskFilter: "风险",
  paramsRiskFilterHint: "仅显示与预览不同或失去原生形状的零件",
  paramsInfoFilter: "提示",
  paramsInfoFilterHint: "显示提示：贴合面与被埋住的零件",
  paramsHighlightHint: "点击在 3D 视图中高亮",
  paramsParityNative: "零件在 Revit 中保持原生形状",
  paramsIssueDotHint: "布置警告",
  paramsIsolateHint: "仅显示该零件（Isolate）",
  paramsMakeTransparent: "半透明（Ghost / Translucent）",
  paramsMakeOpaque: "不透明（Opaque）",
  paramsHidePart: "隐藏零件",
  paramsUnhidePart: "显示零件",
  paramsParityWarning: (risky, total) =>
    `${risky}/${total} 个零件将与预览不同或在 .rfa 中失去原生形状。开启“风险”以筛选。`,
  paramsModelSummary: (solids, native, total, materials) =>
    `${solids} 个实体 · ${native}/${total} 原生 · ${materials} 种材质`,

  paramsNoConnectors: "此模型中还没有 MEP 连接口。",
  paramsReferencePlane: "参照平面",
  paramsSolidFace: "实体面",
  paramsHostToggleHint: "切换连接口宿主类型",
  paramsFlow: "流量",
  paramsOrphanConnector: "该连接口悬空，没有接触任何零件表面！",
  paramsConnectorsConfigured: (count) => `已配置 ${count} 个 MEP 连接口`,
};
