import type { Translation } from "./translation";

/**
 * Strings used only by the saved-model library pane (`LibraryPanel`).
 * Core library labels (libraryTitle, allGroups, ungrouped, newGroup, searchModels,
 * sort*, moveToGroup, renameGroup, deleteGroup, newGroupOption, libraryEmpty,
 * libraryEmptyHint, noMatches, history, restore, close, moveGroup, renameModel,
 * deleteModel, trash*, daysLeft, historyKeep) already live in `strings.ts`;
 * only the wording specific to this pane is added here.
 * Revit terms (Family, Type, Category, LOD, Save, RFA) stay in English on purpose,
 * and model, group, category and type names are never translated.
 * Functions take raw values or already-translated labels so the dictionary stays
 * free of Intl; the caller owns the active locale.
 */
export const vi = {
  /* Sidebar / toolbar accessibility labels */
  libGroupsAria: "Nhóm mô hình",
  libSearchAria: "Tìm mô hình",
  libSortAria: "Sắp xếp danh sách mô hình",

  /* Card actions */
  libMoveModelTo: (name: string) => `Chuyển ${name} sang nhóm khác`,
  libHistoryTooltip: "Xem lịch sử các bản lưu",
  libRenameModelAria: (name: string) => `Tên mới cho ${name}`,

  /* Group actions */
  libRenameGroupAria: (name: string) => `Tên mới cho nhóm ${name}`,
  libGroupOptionsAria: (name: string) => `Tùy chọn cho nhóm ${name}`,
  libConfirmDeleteGroup: (name: string, ungrouped: string) =>
    `Xoá nhóm "${name}"? Các family trong nhóm sẽ chuyển về "${ungrouped}" và không bị xoá.`,
  libDeleteGroupTitle: (name: string) => `Xoá nhóm "${name}"?`,
  libDeleteGroupCount: (count: number, ungrouped: string) =>
    `${count} family sẽ chuyển về "${ungrouped}", không có family nào bị xoá.`,
  libGroupNameTaken: (name: string) =>
    `Đã có nhóm "${name}" — chọn tên khác hoặc gộp hai nhóm thủ công.`,
  libGroupRowHint: (name: string) =>
    `Bấm để lọc · nhấp đúp hoặc chuột phải để đổi tên/xoá nhóm ${name}`,
  libNewGroupPrompt: "Tên nhóm mới:",
  libMoveNewGroupPrompt: "Chuyển family vào nhóm mới:",

  /* Revision history */
  libHistoryFor: (name: string) => `Lịch sử: ${name}`,
  libHistoryLoading: "Đang tải lịch sử…",
  libHistoryEmpty: "Chưa có bản cũ. Lịch sử bắt đầu ghi từ lần Save tiếp theo của mô hình này.",

  /* Loading and model stats */
  libLibraryLoading: "Đang tải thư viện…",
  libPartsCount: (count: number) => `${count} chi tiết`,
  libParamsCount: (count: number) => `${count} tham số`,
  libUsability: (parameters: number, driving: number, dead: number) =>
    `${parameters} tham số · ${driving} điều khiển hình${dead > 0 ? ` · ${dead} kích thước chết` : ""}`,
} as const;

export const en: Translation<typeof vi> = {
  libGroupsAria: "Model groups",
  libSearchAria: "Search models",
  libSortAria: "Sort the model list",

  libMoveModelTo: (name) => `Move ${name} to another group`,
  libHistoryTooltip: "View the saved revision history",
  libRenameModelAria: (name) => `New name for ${name}`,

  libRenameGroupAria: (name) => `New name for group ${name}`,
  libGroupOptionsAria: (name) => `Options for group ${name}`,
  libConfirmDeleteGroup: (name, ungrouped) =>
    `Delete group "${name}"? Its families move to "${ungrouped}" and are not deleted.`,
  libDeleteGroupTitle: (name) => `Delete group "${name}"?`,
  libDeleteGroupCount: (count, ungrouped) =>
    `${count} ${count === 1 ? "family" : "families"} will move to "${ungrouped}"; nothing is deleted.`,
  libGroupNameTaken: (name) =>
    `A group named "${name}" already exists — pick another name or merge them by hand.`,
  libGroupRowHint: (name) =>
    `Click to filter · double-click or right-click to rename/delete ${name}`,
  libNewGroupPrompt: "New group name:",
  libMoveNewGroupPrompt: "Move the family into a new group:",

  libHistoryFor: (name) => `History: ${name}`,
  libHistoryLoading: "Loading history…",
  libHistoryEmpty:
    "No earlier revisions yet. History starts recording from the next Save of this model.",

  libLibraryLoading: "Loading the library…",
  libPartsCount: (count) => `${count} part${count === 1 ? "" : "s"}`,
  libParamsCount: (count) => `${count} parameter${count === 1 ? "" : "s"}`,
  libUsability: (parameters, driving, dead) =>
    `${parameters} parameters · ${driving} driving dimensions${
      dead > 0 ? ` · ${dead} dead dimensions` : ""
    }`,
};

export const zh: Translation<typeof vi> = {
  libGroupsAria: "模型分组",
  libSearchAria: "搜索模型",
  libSortAria: "排序模型列表",

  libMoveModelTo: (name) => `将 ${name} 移到其他分组`,
  libHistoryTooltip: "查看已保存版本的历史记录",
  libRenameModelAria: (name) => `${name} 的新名称`,

  libRenameGroupAria: (name) => `分组 ${name} 的新名称`,
  libGroupOptionsAria: (name) => `分组 ${name} 的选项`,
  libConfirmDeleteGroup: (name, ungrouped) =>
    `删除分组“${name}”？组内的 family 将移到“${ungrouped}”，不会被删除。`,
  libDeleteGroupTitle: (name) => `删除分组“${name}”？`,
  libDeleteGroupCount: (count, ungrouped) =>
    `${count} 个 family 将移到“${ungrouped}”，不会删除任何 family。`,
  libGroupNameTaken: (name) => `已存在分组“${name}” — 请换一个名称或手动合并。`,
  libGroupRowHint: (name) => `单击筛选 · 双击或右键重命名/删除分组 ${name}`,
  libNewGroupPrompt: "新分组名称：",
  libMoveNewGroupPrompt: "将 family 移到新分组：",

  libHistoryFor: (name) => `历史：${name}`,
  libHistoryLoading: "正在加载历史记录…",
  libHistoryEmpty: "还没有旧版本。此模型下次 Save 后将开始记录历史。",

  libLibraryLoading: "正在加载图库…",
  libPartsCount: (count) => `${count} 个零件`,
  libParamsCount: (count) => `${count} 个参数`,
  libUsability: (parameters, driving, dead) =>
    `${parameters} 个参数 · ${driving} 个驱动尺寸${dead > 0 ? ` · ${dead} 个死尺寸` : ""}`,
};
