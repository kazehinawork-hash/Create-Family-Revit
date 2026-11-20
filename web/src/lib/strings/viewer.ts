import type { Translation } from "./translation";

/**
 * Viewer-pane strings. Core viewer labels (fitView, grid, shadows, section,
 * measure, part, assembling, …) already live in `strings.ts`; only the wording
 * that is specific to this pane is added here. Revit terms (Family, Type, LOD,
 * Connector, RFA, MEP) stay in English on purpose.
 * Functions take pre-formatted values (see `formatNumber`) so the dictionary
 * stays free of Intl and the caller owns the active locale.
 *
 * `vi` is re-exported through `Translation` on purpose: `strings.ts` merges this
 * module into its `Strings` type, and literal types (`as const` alone) would make
 * the `en`/`zh` dictionaries impossible to satisfy there. Widening keeps the key
 * set exact while every value stays a plain `string`.
 */
const viDictionary = {
  /* Toolbar */
  viewerToFine: "Chuyển sang chế độ Chi tiết (hiện mọi chi tiết nhỏ)",
  viewerToCoarse: "Chuyển sang chế độ Đơn giản (ẩn chi tiết nhỏ và vùng clearance)",
  viewerTurntableHint: "Bật/Tắt hiệu ứng xoay tròn 360° tự động như bàn xoay trưng bày (Turntable)",
  viewerUnhideAllHint: "Hiện lại tất cả các cấu kiện đang ẩn",
  viewerUnhideCount: (count: string) => `Hiện lại tất cả (${count})`,

  /* Empty state */
  viewerTrySample: "thang cáp ngã ba 400×100",

  /* Section panel */
  viewerCloseSection: "Đóng mặt cắt",
  viewerPickSection: "Chọn mặt phẳng cắt bằng cách bấm vào một mặt của mô hình",
  viewerSectionFillDisabled: "Tô mặt cắt tắt cho family từ 200 chi tiết để giữ tốc độ",
  viewerPickSectionHint: "Bấm vào một mặt của mô hình để đặt mặt cắt…",
  viewerFlipSection: "Đảo chiều mặt cắt",
  viewerSectionPosition: "Vị trí mặt cắt (mm)",
  viewerSectionTip: "Kéo tay nắm trên mô hình hoặc nhập số để dịch mặt cắt",
  viewerSectionFace: (value: string) => `Mặt · ${value} mm`,

  /* Measure tool */
  viewerMeasureHint: "Bấm điểm thứ nhất trên mô hình · Esc để huỷ",
  viewerMeasureFirstPoint: (snap: string) => `Điểm 1 (bắt ${snap}) · bấm điểm thứ hai (Esc để huỷ)`,
  viewerMeasurePreview: (mm: string, axis: string) => `${axis ? `Trục ${axis} · ` : ""}${mm} mm`,
  viewerMeasureResult: (mm: string, snap: string, axis: string) =>
    `${mm} mm · bắt ${snap}${axis ? ` · trục ${axis}` : ""}`,
  viewerClearMeasurements: (count: string) => `Xoá ${count} phép đo`,
  viewerSnapFace: "Mặt",
  viewerSnapEdge: "Cạnh",
  viewerSnapCorner: "Góc",

  /* Part context menu */
  viewerSendToChat: "Gửi vào chat",
  viewerAddNoteHere: "Ghi chú tại đây",
  viewerSelectedParts: (count: string) => `Đã chọn ${count} chi tiết`,
  viewerNotePlaceholder: "Ghi chú ngắn cho Agent…",
  viewerNoteSave: "Lưu ghi chú",
  viewerNoteCancel: "Huỷ",
  viewerNoteChanged: "đã thay đổi",
  viewerHidePart: "Ẩn cấu kiện (Hide)",
  viewerUnhidePart: "Hiện cấu kiện (Unhide)",
  viewerMakeSolid: "Làm đặc lại (Solid / Opaque)",
  viewerMakeGhost: "Làm mờ (Ghost / Translucent)",
  viewerIsolate: "Cô lập cấu kiện (Isolate)",
  viewerSectionThroughPart: "Cắt mặt cắt ngay qua cấu kiện này",
  viewerSectionFromPart: "Section từ cấu kiện này",
  viewerResetTransparency: "Khôi phục độ mờ tất cả",

  /* Selected part chip */
  viewerHidePartHint: "Ẩn cấu kiện này",
  viewerHideShort: "Ẩn",
  viewerDeselect: "Bỏ chọn",

  /* Model caption */
  viewerModelCaption: (parts: string, instances: string) => `${parts} chi tiết · ${instances} khối`,
} as const;

export const vi: Translation<typeof viDictionary> = viDictionary;

export const en: Translation<typeof vi> = {
  viewerToFine: "Switch to Fine detail (show every small part)",
  viewerToCoarse: "Switch to Coarse detail (hide small parts and clearance zones)",
  viewerTurntableHint: "Turn the automatic 360° exhibition turntable on or off",
  viewerUnhideAllHint: "Show every hidden part again",
  viewerUnhideCount: (count: string) => `Show all again (${count})`,

  viewerTrySample: "cable ladder tee 400×100",

  viewerCloseSection: "Close section",
  viewerPickSection: "Pick a cutting plane by clicking a face on the model",
  viewerSectionFillDisabled:
    "Section fill is off for families with 200 or more parts, to keep the view fast",
  viewerPickSectionHint: "Click a face on the model to place the section…",
  viewerFlipSection: "Flip section direction",
  viewerSectionPosition: "Section position in millimetres",
  viewerSectionTip: "Drag the handle on the model or type a value to move the section",
  viewerSectionFace: (value: string) => `Face · ${value} mm`,

  viewerMeasureHint: "Click the first point on the model · Esc to cancel",
  viewerMeasureFirstPoint: (snap: string) =>
    `Point 1 (snap: ${snap}) · click the second point (Esc to cancel)`,
  viewerMeasurePreview: (mm: string, axis: string) => `${axis ? `Axis ${axis} · ` : ""}${mm} mm`,
  viewerMeasureResult: (mm: string, snap: string, axis: string) =>
    `${mm} mm · snap ${snap}${axis ? ` · axis ${axis}` : ""}`,
  viewerClearMeasurements: (count: string) =>
    `Clear ${count} measurement${count === "1" ? "" : "s"}`,
  viewerSnapFace: "Face",
  viewerSnapEdge: "Edge",
  viewerSnapCorner: "Corner",

  viewerSendToChat: "Send to chat",
  viewerAddNoteHere: "Add note here",
  viewerSelectedParts: (count: string) => `${count} parts selected`,
  viewerNotePlaceholder: "Short note for the agent…",
  viewerNoteSave: "Save note",
  viewerNoteCancel: "Cancel",
  viewerNoteChanged: "changed",
  viewerHidePart: "Hide part",
  viewerUnhidePart: "Unhide part",
  viewerMakeSolid: "Make solid (opaque)",
  viewerMakeGhost: "Make translucent (ghost)",
  viewerIsolate: "Isolate part",
  viewerSectionThroughPart: "Cut a section right through this part",
  viewerSectionFromPart: "Section from this part",
  viewerResetTransparency: "Reset all transparency",

  viewerHidePartHint: "Hide this part",
  viewerHideShort: "Hide",
  viewerDeselect: "Deselect",

  viewerModelCaption: (parts: string, instances: string) => `${parts} parts · ${instances} solids`,
};

export const zh: Translation<typeof vi> = {
  viewerToFine: "切换到精细模式（显示所有细小零件）",
  viewerToCoarse: "切换到简单模式（隐藏细小零件和 clearance 区域）",
  viewerTurntableHint: "开启或关闭自动 360° 旋转展示台",
  viewerUnhideAllHint: "重新显示所有已隐藏的零件",
  viewerUnhideCount: (count: string) => `全部显示（${count}）`,

  viewerTrySample: "电缆桥架三通 400×100",

  viewerCloseSection: "关闭剖切",
  viewerPickSection: "点击模型上的面来选取剖切平面",
  viewerSectionFillDisabled: "零件数达到 200 及以上的 family 已关闭截面填充，以保证速度",
  viewerPickSectionHint: "点击模型上的面以放置剖切…",
  viewerFlipSection: "翻转剖切方向",
  viewerSectionPosition: "剖切位置（毫米）",
  viewerSectionTip: "拖动模型上的手柄或输入数值来移动剖切",
  viewerSectionFace: (value: string) => `面 · ${value} mm`,

  viewerMeasureHint: "点击模型上的第一个点 · Esc 取消",
  viewerMeasureFirstPoint: (snap: string) => `第 1 点（吸附：${snap}）· 点击第二点（Esc 取消）`,
  viewerMeasurePreview: (mm: string, axis: string) => `${axis ? `${axis} 轴 · ` : ""}${mm} mm`,
  viewerMeasureResult: (mm: string, snap: string, axis: string) =>
    `${mm} mm · 吸附 ${snap}${axis ? ` · ${axis} 轴` : ""}`,
  viewerClearMeasurements: (count: string) => `清除 ${count} 个测量`,
  viewerSnapFace: "面",
  viewerSnapEdge: "边",
  viewerSnapCorner: "角",

  viewerSendToChat: "发送到聊天",
  viewerAddNoteHere: "在此添加备注",
  viewerSelectedParts: (count: string) => `已选择 ${count} 个零件`,
  viewerNotePlaceholder: "给 Agent 的简短备注…",
  viewerNoteSave: "保存备注",
  viewerNoteCancel: "取消",
  viewerNoteChanged: "已更改",
  viewerHidePart: "隐藏零件",
  viewerUnhidePart: "显示零件",
  viewerMakeSolid: "恢复为实体（不透明）",
  viewerMakeGhost: "设为半透明",
  viewerIsolate: "隔离零件",
  viewerSectionThroughPart: "直接穿过此零件剖切",
  viewerSectionFromPart: "从此零件创建剖切",
  viewerResetTransparency: "恢复所有透明度",

  viewerHidePartHint: "隐藏此零件",
  viewerHideShort: "隐藏",
  viewerDeselect: "取消选择",

  viewerModelCaption: (parts: string, instances: string) => `${parts} 个零件 · ${instances} 个实体`,
};
