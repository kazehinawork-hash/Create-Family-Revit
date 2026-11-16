/**
 * Server events carry a machine code plus params. This table renders them in the
 * active language; unknown codes fall back to the server's original message.
 */
import type { Language } from "./strings";

type Params = Record<string, unknown>;
type Builder = (params: Params) => string;

const num = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const text = (value: unknown): string => String(value ?? "");

const vi: Record<string, Builder> = {
  "stage.readingAttachments": () => "Đang đọc tài liệu đính kèm…",
  "stage.readingRequest": () => "Đang đọc yêu cầu…",
  "stage.readingDocuments": () => "Đang đọc tài liệu…",
  "stage.analyzing": () => "Đang phân tích yêu cầu…",
  "stage.building": () => "Đang dựng…",
  "stage.buildingElapsed": (p) => `Đang dựng… ${num(p.seconds)}s`,
  "stage.checking": () => "Đang tự kiểm tra…",
  "stage.repairGeometry": (p) => `Sửa ${num(p.count)} lỗi hình học`,
  "stage.repairModel": (p) => `Sửa ${num(p.count)} lỗi mô hình`,
  "stage.repairParameters": (p) => `Nối hoặc bỏ ${num(p.count)} tham số không dùng`,
  "stage.retryTimeout": (p) =>
    `Hết thời gian lượt ${num(p.attempt)} — thử lại với yêu cầu gọn hơn`,
  "stage.retryMaxTurns": () => "Model hết lượt của CLI — thử lại với thêm 1 lượt",
  "stage.retryProvider": (p) =>
    `Nhà cung cấp model đang quá tải — tự thử lại sau ${num(p.seconds)}s ` +
    `(lần ${num(p.attempt)}/${num(p.total)})`,
  "stage.fallbackOverloaded": (p) =>
    `Model ${text(p.from)} đang quá tải, đã chuyển sang ${text(p.to)}`,
  "stage.fallbackError": (p) => `Model ${text(p.from)} lỗi, đã chuyển sang ${text(p.to)}`,
  "stage.template": (p) => `Dựng từ khuôn ${text(p.family)} — không cần gọi model`,
  "stage.needsWork": (p) => `Còn ${num(p.count)} lỗi trong mô hình`,
  "stage.refreshing": (p) => `Đang làm mới ${text(p.name)}`,
  "stage.rebuilding": (p) => `Đang dựng lại ${text(p.name)}`,

  "error.auth": () => "Kiểm tra lại API key.",
  "error.overloaded": () => "Nhà cung cấp đang quá tải — đợi vài giây rồi thử lại.",
  "error.network": () => "Mất kết nối tới model — kiểm tra mạng rồi thử lại.",
  "error.timeout": () => "Agent chạy quá thời gian cho phép — thử lại hoặc chia nhỏ yêu cầu.",
  "error.output-limit": () => "Câu trả lời dài quá giới hạn — chia nhỏ yêu cầu rồi thử lại.",
  "error.invalid-request": () => "Yêu cầu không hợp lệ — kiểm tra lại nội dung đã gửi.",
  "error.unknown": () => "Agent gặp lỗi không xác định — thử gửi lại.",

  "issue.rotatedBox":
    () => "Khối hộp xoay lệch trục 90° — dùng Rebuild from spec sau khi đổi tham số.",
  "issue.connectorOffset": (p) =>
    `Cổng "${text(p.name)}" lệch ${num(p.mm)} mm so với gốc spec`,
  "issue.unusedParameter": (p) =>
    `Kích thước "${text(p.name)}" không điều khiển hình nào — nối vào hình hoặc bỏ đi.`,
};

const en: Record<string, Builder> = {
  "stage.readingAttachments": () => "Reading attached documents…",
  "stage.readingRequest": () => "Reading the request…",
  "stage.readingDocuments": () => "Reading documents…",
  "stage.analyzing": () => "Analyzing the request…",
  "stage.building": () => "Building…",
  "stage.buildingElapsed": (p) => `Building… ${num(p.seconds)}s`,
  "stage.checking": () => "Checking the model…",
  "stage.repairGeometry": (p) => `Fixing ${num(p.count)} geometry error(s)`,
  "stage.repairModel": (p) => `Fixing ${num(p.count)} model error(s)`,
  "stage.repairParameters": (p) => `Wiring or removing ${num(p.count)} unused parameter(s)`,
  "stage.retryTimeout": (p) => `Turn ${num(p.attempt)} timed out — retrying with a smaller request`,
  "stage.retryMaxTurns": () => "The CLI ran out of turns — retrying with one more turn",
  "stage.retryProvider": (p) =>
    `Provider overloaded — retrying in ${num(p.seconds)}s (${num(p.attempt)}/${num(p.total)})`,
  "stage.fallbackOverloaded": (p) =>
    `Model ${text(p.from)} is overloaded; switched to ${text(p.to)}`,
  "stage.fallbackError": (p) => `Model ${text(p.from)} failed; switched to ${text(p.to)}`,
  "stage.template": (p) => `Built from the ${text(p.family)} template — no model call needed`,
  "stage.needsWork": (p) => `${num(p.count)} error(s) remain in the model`,
  "stage.refreshing": (p) => `Refreshing ${text(p.name)}`,
  "stage.rebuilding": (p) => `Rebuilding ${text(p.name)}`,

  "error.auth": () => "Check the API key.",
  "error.overloaded": () => "The provider is overloaded — wait a moment and retry.",
  "error.network": () => "Lost the connection to the model — check the network and retry.",
  "error.timeout": () => "The agent timed out — retry or split the request.",
  "error.output-limit": () => "The answer exceeded the limit — split the request and retry.",
  "error.invalid-request": () => "Invalid request — check what was sent.",
  "error.unknown": () => "The agent hit an unknown error — try sending again.",

  "issue.rotatedBox":
    () => "A box rotated off the 90° axes — use Rebuild from spec after changing parameters.",
  "issue.connectorOffset": (p) =>
    `Connector "${text(p.name)}" host is offset ${num(p.mm)} mm from the spec origin`,
  "issue.unusedParameter": (p) =>
    `Dimension "${text(p.name)}" drives no geometry — wire it to a part or remove it.`,
};

const zh: Record<string, Builder> = {
  "stage.readingAttachments": () => "正在读取附件…",
  "stage.readingRequest": () => "正在读取需求…",
  "stage.readingDocuments": () => "正在读取文档…",
  "stage.analyzing": () => "正在分析需求…",
  "stage.building": () => "正在构建…",
  "stage.buildingElapsed": (p) => `正在构建… ${num(p.seconds)} 秒`,
  "stage.checking": () => "正在检查模型…",
  "stage.repairGeometry": (p) => `正在修复 ${num(p.count)} 个几何错误`,
  "stage.repairModel": (p) => `正在修复 ${num(p.count)} 个模型错误`,
  "stage.repairParameters": (p) => `正在连接或删除 ${num(p.count)} 个未使用参数`,
  "stage.retryTimeout": (p) => `第 ${num(p.attempt)} 轮超时——正在用更精简的请求重试`,
  "stage.retryMaxTurns": () => "CLI 已用完轮次——增加一轮后重试",
  "stage.retryProvider": (p) =>
    `模型提供商过载——${num(p.seconds)} 秒后重试（第 ${num(p.attempt)}/${num(p.total)} 次）`,
  "stage.fallbackOverloaded": (p) =>
    `模型 ${text(p.from)} 过载，已切换到 ${text(p.to)}`,
  "stage.fallbackError": (p) => `模型 ${text(p.from)} 出错，已切换到 ${text(p.to)}`,
  "stage.template": (p) => `已从 ${text(p.family)} 模板构建——无需调用模型`,
  "stage.needsWork": (p) => `模型中仍有 ${num(p.count)} 个错误`,
  "stage.refreshing": (p) => `正在刷新 ${text(p.name)}`,
  "stage.rebuilding": (p) => `正在重建 ${text(p.name)}`,

  "error.auth": () => "请检查 API key。",
  "error.overloaded": () => "模型提供商过载——请稍候重试。",
  "error.network": () => "与模型的连接中断——请检查网络后重试。",
  "error.timeout": () => "Agent 超时——请重试或拆分需求。",
  "error.output-limit": () => "回答超出长度限制——请拆分需求后重试。",
  "error.invalid-request": () => "请求无效——请检查发送的内容。",
  "error.unknown": () => "Agent 遇到未知错误——请重新发送。",

  "issue.rotatedBox": () => "盒体偏离 90° 轴线——修改参数后请使用 Rebuild from spec。",
  "issue.connectorOffset": (p) =>
    `连接口 "${text(p.name)}" 相对 spec 原点偏移 ${num(p.mm)} mm`,
  "issue.unusedParameter": (p) => `尺寸 "${text(p.name)}" 不驱动任何几何——请连接或删除。`,
};

const tables: Record<Language, Record<string, Builder>> = { vi, en, zh };

export function translateServerMessage(
  language: Language,
  code: string | undefined,
  params: Params | undefined,
  fallback: string,
): string {
  if (!code) return fallback;
  const builder = tables[language][code];
  if (!builder) return fallback;
  try {
    return builder(params ?? {});
  } catch {
    return fallback;
  }
}
