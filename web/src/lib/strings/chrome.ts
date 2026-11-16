/**
 * Chrome strings: the top bar, the direct-API panel and the crash fallback.
 * Keys are prefixed by component (`topbar*`, `api*`, `error*`) so this module can
 * never collide with the core dictionary in `../strings.ts`.
 * Revit terms (Family, Type, LOD, Connector, RFA, category and parameter names)
 * stay in English on purpose.
 */
import type { Translation } from "./translation";

/**
 * Keys are authored `as const` so the literal set is the source of truth, then
 * exported widened: `strings.ts` merges every dictionary with `as const`, which
 * would freeze these values as Vietnamese literals and reject the translations.
 */
const viDictionary = {
  // Top bar
  topbarLodLabel: "Mức chi tiết (LOD)",
  topbarLodFallback: "Mức chi tiết",
  topbarLod200Hint: "LOD 200 · khối bao, 3–10 parts",
  topbarLod300Hint: "LOD 300 · thiết kế thực tế, 5–20 parts",
  topbarLod350Hint: "LOD 350 · phối hợp MEP, 10–40 parts",
  topbarLod400Hint: "LOD 400 · chế tạo, 20–80 parts (phức tạp đến 150)",
  topbarDemoFcu: "FCU giấu trần 080 (Trane)",
  topbarDemoPump: "Bơm ly tâm DN80",
  topbarDemoYStrainer: "Y lọc bích DN80 PN16, nhánh 45°",
  topbarDemoYStrainerTube: "Y lọc nhánh tube 45°",
  topbarDemoElbow: "Cút ren 90° Duct Elbow DN50",

  // Direct API panel
  apiAutoDetect: "Tự động nhận diện",
  apiSuggestedGroup: "⭐ Đề xuất",
  apiOtherGroup: "Khác",
  apiNoModelChosen: "chưa chọn model",
  apiOpenConfig: "Mở cấu hình API",
  apiCloseConfig: "Đóng cấu hình API",
  apiChange: "Đổi",
  apiConfigTitle: "Cấu hình API",
  apiChecking: "Đang kiểm tra…",
  apiConnected: (provider: string, count: number) => `Đã kết nối · ${provider} · ${count} model`,
  apiRefreshing: " · đang làm mới",
  apiRetry: "Thử lại",
  apiKeyPlaceholder: "Dán API key (sk-…, AIza…, user_…)",
  apiShowKey: "Hiện key",
  apiHideKey: "Ẩn key",
  apiPasteClipboard: "Dán key từ clipboard",
  apiPaste: "Dán",
  apiSearchModelPlaceholder: "Tìm model…",
  apiSearchModel: "Tìm model",
  apiChooseModel: "Chọn model",
  apiCollapse: "Thu gọn",
  apiAdvancedShow: "Nâng cao",
  apiAdvancedHide: "Ẩn tuỳ chọn nâng cao",
  apiCliHintLead: "Key ",
  apiCliHintMiddle: " cũng được lưu cho CLI Command Code (không cần ",
  apiCliHintTail: ").",
  apiWhereIsKey: "Key của tôi ở đâu?",
  apiHelpBefore: "Command Code: commandcode.ai → Studio → API keys (dạng ",
  apiHelpAfter:
    "). OpenAI: platform.openai.com → API keys. Google: aistudio.google.com. Anthropic: console.anthropic.com.",
  apiKeyRejected: (provider: string) =>
    `Key không đúng — kiểm tra lại key trên trang của ${provider}`,
  apiKeyInvalid: "Key không hợp lệ",
  apiConnectionFailed: "Không kết nối được — thử lại",

  // Crash fallback
  errorTitle: "Studio gặp lỗi",
  errorReload: "Tải lại studio",
} as const;

export const vi: Translation<typeof viDictionary> = viDictionary;

export const en: Translation<typeof vi> = {
  // Top bar
  topbarLodLabel: "Level of detail (LOD)",
  topbarLodFallback: "Level of detail",
  topbarLod200Hint: "LOD 200 · massing box, 3–10 parts",
  topbarLod300Hint: "LOD 300 · real design, 5–20 parts",
  topbarLod350Hint: "LOD 350 · MEP coordination, 10–40 parts",
  topbarLod400Hint: "LOD 400 · fabrication, 20–80 parts (up to 150 when complex)",
  topbarDemoFcu: "FCU concealed ceiling 080 (Trane)",
  topbarDemoPump: "Centrifugal pump DN80",
  topbarDemoYStrainer: "Y-strainer flanged DN80 PN16, 45° branch",
  topbarDemoYStrainerTube: "Y-strainer tube branch 45°",
  topbarDemoElbow: "Threaded elbow 90° Duct Elbow DN50",

  // Direct API panel
  apiAutoDetect: "Auto-detect",
  apiSuggestedGroup: "⭐ Suggested",
  apiOtherGroup: "Other",
  apiNoModelChosen: "no model selected",
  apiOpenConfig: "Open API settings",
  apiCloseConfig: "Close API settings",
  apiChange: "Change",
  apiConfigTitle: "API settings",
  apiChecking: "Checking…",
  apiConnected: (provider: string, count: number) =>
    `Connected · ${provider} · ${count} model${count === 1 ? "" : "s"}`,
  apiRefreshing: " · refreshing",
  apiRetry: "Try again",
  apiKeyPlaceholder: "Paste an API key (sk-…, AIza…, user_…)",
  apiShowKey: "Show key",
  apiHideKey: "Hide key",
  apiPasteClipboard: "Paste key from clipboard",
  apiPaste: "Paste",
  apiSearchModelPlaceholder: "Search models…",
  apiSearchModel: "Search models",
  apiChooseModel: "Choose a model",
  apiCollapse: "Collapse",
  apiAdvancedShow: "Advanced",
  apiAdvancedHide: "Hide advanced options",
  apiCliHintLead: "A key starting with ",
  apiCliHintMiddle: " is also saved for the Command Code CLI (no ",
  apiCliHintTail: " needed).",
  apiWhereIsKey: "Where do I find my key?",
  apiHelpBefore: "Command Code: commandcode.ai → Studio → API keys (key format ",
  apiHelpAfter:
    "). OpenAI: platform.openai.com → API keys. Google: aistudio.google.com. Anthropic: console.anthropic.com.",
  apiKeyRejected: (provider: string) => `Wrong key — check the key on your ${provider} page`,
  apiKeyInvalid: "Invalid key",
  apiConnectionFailed: "Could not connect — try again",

  // Crash fallback
  errorTitle: "The studio hit an error",
  errorReload: "Reload the studio",
};

export const zh: Translation<typeof vi> = {
  // Top bar
  topbarLodLabel: "详细程度（LOD）",
  topbarLodFallback: "详细程度",
  topbarLod200Hint: "LOD 200 · 体量盒，3–10 个零件",
  topbarLod300Hint: "LOD 300 · 实际设计，5–20 个零件",
  topbarLod350Hint: "LOD 350 · MEP 协调，10–40 个零件",
  topbarLod400Hint: "LOD 400 · 制造，20–80 个零件（复杂时可达 150）",
  topbarDemoFcu: "FCU 吊顶暗装 080（Trane）",
  topbarDemoPump: "离心泵 DN80",
  topbarDemoYStrainer: "Y 型过滤器法兰 DN80 PN16，45° 支管",
  topbarDemoYStrainerTube: "Y 型过滤器管式支管 45°",
  topbarDemoElbow: "螺纹弯头 90° Duct Elbow DN50",

  // Direct API panel
  apiAutoDetect: "自动识别",
  apiSuggestedGroup: "⭐ 推荐",
  apiOtherGroup: "其他",
  apiNoModelChosen: "尚未选择 model",
  apiOpenConfig: "打开 API 配置",
  apiCloseConfig: "关闭 API 配置",
  apiChange: "更改",
  apiConfigTitle: "API 配置",
  apiChecking: "正在检查…",
  apiConnected: (provider: string, count: number) => `已连接 · ${provider} · ${count} 个 model`,
  apiRefreshing: " · 正在刷新",
  apiRetry: "重试",
  apiKeyPlaceholder: "粘贴 API key（sk-…、AIza…、user_…）",
  apiShowKey: "显示 key",
  apiHideKey: "隐藏 key",
  apiPasteClipboard: "从剪贴板粘贴 key",
  apiPaste: "粘贴",
  apiSearchModelPlaceholder: "搜索 model…",
  apiSearchModel: "搜索 model",
  apiChooseModel: "选择 model",
  apiCollapse: "收起",
  apiAdvancedShow: "高级",
  apiAdvancedHide: "隐藏高级选项",
  apiCliHintLead: "以 ",
  apiCliHintMiddle: " 开头的 key 也会保存给 Command Code CLI（无需 ",
  apiCliHintTail: "）。",
  apiWhereIsKey: "我的 key 在哪里？",
  apiHelpBefore: "Command Code：commandcode.ai → Studio → API keys（key 形如 ",
  apiHelpAfter:
    "）。OpenAI：platform.openai.com → API keys。Google：aistudio.google.com。Anthropic：console.anthropic.com。",
  apiKeyRejected: (provider: string) => `Key 不正确——请在你的 ${provider} 页面上重新核对 key`,
  apiKeyInvalid: "Key 无效",
  apiConnectionFailed: "无法连接——请重试",

  // Crash fallback
  errorTitle: "Studio 出错了",
  errorReload: "重新加载 Studio",
};
