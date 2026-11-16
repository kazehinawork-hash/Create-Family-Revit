/**
 * Every user-facing label lives here so the studio speaks one language.
 * Revit terms (LOD, Family, Type, Connector) stay in English on purpose.
 */
export const t = {
  // Top bar
  newFamily: "Family mới",
  newFamilyHint: "Bắt đầu một family mới (xoá màn hình hiện tại)",
  library: "Thư viện",
  libraryHint: "Mở thư viện các family đã lưu",
  save: "Lưu",
  saveHint: "Lưu family này vào thư viện",
  saveAs: "Lưu bản mới",
  saveAsHint: "Lưu thành một bản mới, giữ nguyên bản đang mở",
  exportRfa: "Xuất RFA",
  exportRfaHint: "Tải gói dựng Native Family 1-Click (không cần Add-in)",
  exportingRfa: "Đang nén gói…",
  buildRevit: "Dựng trong Revit",
  buildRevitHint: "Đẩy trực tiếp vào phiên Revit đang mở qua Add-in Bridge",
  building: "Đang dựng…",
  more: "Thêm",
  moreActions: "Thao tác khác",
  demoPresets: "Mẫu thử (offline)",
  demoPresetsHint: "Nạp nhanh mô hình mẫu để thử, không tốn token",
  demoHeader: "Mẫu thử nghiệm · 0 token",
  units: "Đơn vị",
  revitVersion: "Phiên bản Revit",
  undo: "Hoàn tác (Ctrl+Z)",
  redo: "Làm lại (Ctrl+Shift+Z)",
  theme: "Giao diện",
  themeSystem: "Theo hệ thống",
  themeLight: "Sáng",
  themeDark: "Tối",
  draft: "Nháp",
  reviewed: "Đã kiểm tra",
  nativeFamily: "Family Native",
  stageRead: "Đọc yêu cầu",
  stageDesign: "Thiết kế family",
  stageCheck: "Kiểm tra mô hình",
  noFamily: "Family mới",
  noFamilyHint: "Mô tả thiết bị để bắt đầu",

  // Chat
  chatEmptyTitle: "Mô tả family bạn cần",
  chatEmptyBody:
    "Kích thước, cách bố trí, cổng kết nối, vật liệu. Phác thảo hiện ra trong vài giây, chi tiết hoàn thiện sau.",
  chatPlaceholder: "Nhập yêu cầu, hoặc dán ảnh (Ctrl+V)…",
  chatPlaceholderUploading: "Đang tải tài liệu…",
  chatPlaceholderWaiting: "Đang chờ agent…",
  chatSend: "Gửi",
  chatStop: "Dừng agent",
  chatAttach: "Đính kèm bản vẽ, datasheet (PDF, ảnh, Word, Excel)",
  chatSuggestion1: "Thang cáp ngã ba 400×100, 6 bậc, LOD 400",
  chatSuggestion2: "Cút gió chữ nhật 90° 600×300, LOD 350",
  chatSuggestion3: "Bơm ly tâm DN80, mặt bích PN16",

  // Panes
  chatTab: "Chat",
  viewerTab: "3D",
  paramsTab: "Tham số",
  parameters: "Tham số",
  parts: "Chi tiết",
  connectors: "Cổng",
  types: "Type",
  addParameter: "+ Thêm tham số",
  formulaHint: "Giá trị có công thức do tham số khác điều khiển — hãy sửa tham số gốc.",
  alignView: "Bấm vào một mặt để căn hướng nhìn",
  resizePanel: "Kéo để đổi độ rộng · nhấp đúp để đặt lại",
  rotatedBoxWarning:
    "Khối hộp xoay lệch trục 90° vẫn dựng được, nhưng Revit không thể khoá mặt vào mặt phẳng tham chiếu; dùng Rebuild from spec sau khi đổi tham số.",
  parametersEmpty: "Tham số sẽ xuất hiện sau khi family được tạo.",
  filterParameters: "Lọc tham số",
  filterParts: "Lọc chi tiết",
  openParams: "Mở bảng tham số",
  closeParams: "Đóng bảng tham số",

  // Viewer
  viewerEmptyTitle: "Chưa có mô hình",
  viewerEmptyBody: "Nhập mô tả thiết bị trong chat, mô hình 3D sẽ hiện ở đây.",
  viewerTryPrefix: "Thử:",
  fitView: "Vừa khung",
  grid: "Lưới",
  shadows: "Bóng",
  refPlanes: "Mặt phẳng tham chiếu",
  connectorsTooltip: "Cổng kết nối MEP",
  section: "Mặt cắt",
  measure: "Đo",
  coarse: "Đơn giản",
  fine: "Chi tiết",
  turnaround: "Xoay 360°",
  dimOthers: "Làm mờ chi tiết khác",
  sectionFill: "Tô mặt cắt",
  explode: "Tách rời",
  dimensions: "Kích thước",
  saveImage: "Lưu ảnh PNG",
  moreViewerTools: "Thêm công cụ",
  part: "Chi tiết",
  unhideAll: "Hiện lại tất cả",
  assembling: "Đang lắp",

  // Library
  libraryTitle: "Thư viện family",
  allGroups: "Tất cả",
  ungrouped: "Chưa nhóm",
  newGroup: "+ Nhóm mới",
  searchModels: "Tìm theo tên hoặc category…",
  sort: "Sắp xếp",
  sortRecent: "Mới nhất",
  sortName: "Tên A–Z",
  sortCategory: "Category",
  moveToGroup: "Chuyển vào nhóm",
  renameGroup: "Đổi tên nhóm",
  deleteGroup: "Xoá nhóm",
  newGroupOption: "+ Nhóm mới…",
  libraryEmpty: "Chưa có family nào được lưu.",
  libraryEmptyHint: "Bấm Save ở thanh trên cùng để lưu family đang mở vào thư viện.",
  noMatches: "Không có family nào khớp tìm kiếm trong mục này.",
  history: "Lịch sử",
  restore: "Khôi phục",
  close: "Đóng",
  moveGroup: "Chuyển nhóm",
  renameModel: "Đổi tên family",
  deleteModel: "Xoá family",
  trash: "Thùng rác",
  trashMoved: "Đã chuyển vào thùng rác",
  undoTrash: "Hoàn tác",
  deleteForever: "Xoá vĩnh viễn",
  emptyTrash: "Dọn sạch",
  confirmTrash: "Chuyển vào thùng rác?",
  confirmPurge:
    "Xoá vĩnh viễn mô hình này? Thao tác này không thể hoàn tác.",
  confirmEmptyTrash:
    "Dọn sạch thùng rác? Tất cả mô hình trong thùng rác sẽ bị xoá vĩnh viễn.",
  trashEmpty: "Thùng rác trống.",
  trashHint: "Mô hình đã xoá được giữ ở đây 30 ngày và có thể khôi phục.",
  daysLeft: (days: number) => `còn ${days} ngày`,
  trashRestored: "Đã khôi phục mô hình",
  trashPurged: "Đã xoá vĩnh viễn",
  trashEmptied: "Đã dọn sạch thùng rác",
  cachedResult: (time: string) => `Kết quả lặp lại từ lần chạy trước (${time})`,
  runFresh: "Chạy mới",
} as const;

/**
 * Validation messages can arrive from an older server build or a cached job.
 * Known English wording is swapped for the Vietnamese copy here, where the UI
 * already keeps every other label.
 */
export function localizeIssueMessage(message: string): string {
  const text = String(message ?? "");
  if (/rotated off the 90° axes/i.test(text)) return t.rotatedBoxWarning;
  if (/host is offset .* from the spec origin/i.test(text)) {
    return text
      .replace(/Connector ("[^"]*") host is offset /i, "Cổng $1 lệch ")
      .replace(/ mm from the spec origin/i, " mm so với gốc spec");
  }
  return text;
}
