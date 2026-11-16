import type { Translation } from "./translation";

/**
 * Copy for the chat pane (agent status, uploads, resolution table, previews).
 * Vietnamese is the source of truth; `en` and `zh` are typed against it so a
 * missing or extra key is a compile error.
 *
 * `vi` is re-exported through `Translation` on purpose: `strings.ts` merges this
 * module into its `Strings` type, and literal types (`as const` alone) would make
 * the `en`/`zh` dictionaries impossible to satisfy there. Widening keeps the key
 * set exact while every value stays a plain `string`.
 */
const viDictionary = {
  // Agent status pill
  chatStatusReady: "Sẵn sàng",
  chatStatusConnecting: "Đang kết nối...",
  chatStatusReadyHint: "Agent đang hoạt động sẵn sàng nhận yêu cầu",
  chatStatusServerOffline: "Mất kết nối server",
  chatStatusServerOfflineHint: "API 127.0.0.1:8787 không phản hồi — đang thử lại…",
  chatStatusNoKey: "Chưa có key",
  chatStatusNoKeyHint: "Dán API key trong khung Cấu hình API",
  chatStatusChecking: "Đang kiểm tra...",
  chatStatusCheckingHint: "Đang kiểm tra API key và quét model",
  chatStatusDisconnected: "Không kết nối",
  chatStatusBadKey: "API Key không hợp lệ",
  chatStatusApiRefreshing: "đang làm mới",
  chatStatusApiReadyHint: (provider: string, count: string) => `${provider} · ${count} model`,
  chatStatusCliMissing: (model: string) =>
    `Không tìm thấy CLI cho model "${model}" trên máy — chọn model từ CLI đang cài hoặc Direct API`,
  chatAgentNotReady: "Agent chưa sẵn sàng",
  chatNotReadyBanner: (hint: string) => `Agent chưa sẵn sàng. ${hint}`,

  // Header controls
  chatModelSelectTitle: "Chọn CLI hoặc Direct API",
  chatUseApiKey: "Dùng API key",
  chatUseApiKeyAria: "Dùng API key trực tiếp",
  chatIncomplete: "Chưa đầy đủ",

  // Session usage
  chatSessionUsage: "Phiên này",
  chatSessionCalls: (count: string) => `${count} lượt gọi model`,

  // Empty state
  chatTrySuggestions: "Thử:",
  chatSuggestionPump: "Bơm ly tâm trục ngang DN80 xả DN65, động cơ 15 kW, bệ đỡ thép hình U",
  chatSuggestionFcu: "FCU giấu trần nối ống gió 800 CFM, 3 hàng coil, hộp hồi kèm lưới lọc G4",
  chatSuggestionFan: "Quạt thông gió gắn tường cánh 350 mm, chớp lật trọng lực, động cơ 1 pha",

  // Message extras
  chatViewImage: (name: string) => `Xem ${name}`,
  chatErrorDetails: "Chi tiết lỗi",
  chatFocusPartHint: "Chọn và zoom tới part này trong 3D",
  chatWorking: "Đang xử lý…",
  chatIssueCount: (count: number) => `Chi tiết · ${count} mục`,

  // Parameter resolution
  chatResolutionTitle: "Thông số đã dùng",
  chatDownloadCsv: "Tải CSV",
  chatCsvFileName: "thong-so-da-dung",
  chatColumnValue: "Giá trị",
  chatColumnSource: "Nguồn",
  chatColumnLevel: "Mức",
  chatWarningsTitle: "Cảnh báo",
  chatAssumptionsTitle: "Giả định Agent đã dùng",

  // Attachments and preview
  chatRemoveAttachment: "Xóa tệp đính kèm",
  chatClosePreview: "Đóng ảnh",
  chatPreviewEmpty: "Ảnh không có URL để hiển thị.",
} as const;

export const vi: Translation<typeof viDictionary> = viDictionary;

export const en: Translation<typeof vi> = {
  chatStatusReady: "Ready",
  chatStatusConnecting: "Connecting…",
  chatStatusReadyHint: "The agent is running and ready for a request",
  chatStatusServerOffline: "Server connection lost",
  chatStatusServerOfflineHint: "API 127.0.0.1:8787 is not responding — retrying…",
  chatStatusNoKey: "No API key yet",
  chatStatusNoKeyHint: "Paste an API key into the API settings box",
  chatStatusChecking: "Checking…",
  chatStatusCheckingHint: "Verifying the API key and listing models",
  chatStatusDisconnected: "Not connected",
  chatStatusBadKey: "Invalid API key",
  chatStatusApiRefreshing: "refreshing",
  chatStatusApiReadyHint: (provider: string, count: string) => `${provider} · ${count} model`,
  chatStatusCliMissing: (model: string) =>
    `No CLI for model "${model}" on this machine — pick a model from an installed CLI or use Direct API`,
  chatAgentNotReady: "Agent not ready",
  chatNotReadyBanner: (hint: string) => `Agent not ready. ${hint}`,

  chatModelSelectTitle: "Choose a CLI or Direct API",
  chatUseApiKey: "Use API key",
  chatUseApiKeyAria: "Use an API key directly",
  chatIncomplete: "Incomplete",

  chatSessionUsage: "This session",
  chatSessionCalls: (count: string) => `${count} model calls`,

  chatTrySuggestions: "Try:",
  chatSuggestionPump:
    "Horizontal centrifugal pump DN80, DN65 discharge, 15 kW motor, U-channel steel base",
  chatSuggestionFcu:
    "Concealed ceiling FCU with duct connection 800 CFM, 3-row coil, G4 return filter",
  chatSuggestionFan: "Wall-mounted exhaust fan 350 mm blade, gravity shutter, single-phase motor",

  chatViewImage: (name: string) => `View ${name}`,
  chatErrorDetails: "Error details",
  chatFocusPartHint: "Select and zoom to this part in 3D",
  chatWorking: "Working…",
  chatIssueCount: (count: number) => `Details · ${count} ${count === 1 ? "item" : "items"}`,

  chatResolutionTitle: "Parameters used",
  chatDownloadCsv: "Download CSV",
  chatCsvFileName: "parameters-used",
  chatColumnValue: "Value",
  chatColumnSource: "Source",
  chatColumnLevel: "Level",
  chatWarningsTitle: "Warnings",
  chatAssumptionsTitle: "Assumptions the agent used",

  chatRemoveAttachment: "Remove attachment",
  chatClosePreview: "Close image",
  chatPreviewEmpty: "This image has no URL to display.",
};

export const zh: Translation<typeof vi> = {
  chatStatusReady: "就绪",
  chatStatusConnecting: "正在连接…",
  chatStatusReadyHint: "Agent 正在运行，随时可以接收请求",
  chatStatusServerOffline: "服务器连接中断",
  chatStatusServerOfflineHint: "API 127.0.0.1:8787 无响应——正在重试…",
  chatStatusNoKey: "尚未设置 API key",
  chatStatusNoKeyHint: "在 API 配置框中粘贴 API key",
  chatStatusChecking: "正在检查…",
  chatStatusCheckingHint: "正在验证 API key 并扫描模型",
  chatStatusDisconnected: "未连接",
  chatStatusBadKey: "API Key 无效",
  chatStatusApiRefreshing: "正在刷新",
  chatStatusApiReadyHint: (provider: string, count: string) => `${provider} · ${count} 个模型`,
  chatStatusCliMissing: (model: string) =>
    `本机未找到 model "${model}" 对应的 CLI——请从已安装的 CLI 中选择模型，或使用 Direct API`,
  chatAgentNotReady: "Agent 尚未就绪",
  chatNotReadyBanner: (hint: string) => `Agent 尚未就绪。${hint}`,

  chatModelSelectTitle: "选择 CLI 或 Direct API",
  chatUseApiKey: "使用 API key",
  chatUseApiKeyAria: "直接使用 API key",
  chatIncomplete: "尚未完整",

  chatSessionUsage: "本次会话",
  chatSessionCalls: (count: string) => `${count} 次模型调用`,

  chatTrySuggestions: "试试：",
  chatSuggestionPump: "卧式离心泵 DN80，出口 DN65，15 kW 电机，U 型钢支架",
  chatSuggestionFcu: "暗装吊顶 FCU 接风管 800 CFM，3 排盘管，回风箱带 G4 过滤网",
  chatSuggestionFan: "壁挂式排风扇 350 mm 扇叶，重力百叶，单相电机",

  chatViewImage: (name: string) => `查看 ${name}`,
  chatErrorDetails: "错误详情",
  chatFocusPartHint: "在 3D 中选择并缩放到此零件",
  chatWorking: "正在处理…",
  chatIssueCount: (count: number) => `详情 · ${count} 项`,

  chatResolutionTitle: "已使用的参数",
  chatDownloadCsv: "下载 CSV",
  chatCsvFileName: "parameters-used",
  chatColumnValue: "值",
  chatColumnSource: "来源",
  chatColumnLevel: "等级",
  chatWarningsTitle: "警告",
  chatAssumptionsTitle: "Agent 使用的假设",

  chatRemoveAttachment: "移除附件",
  chatClosePreview: "关闭图片",
  chatPreviewEmpty: "此图片没有可显示的 URL。",
};
