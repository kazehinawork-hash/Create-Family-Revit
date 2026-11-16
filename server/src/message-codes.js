/**
 * Machine-readable codes for user-visible server messages. The Vietnamese message
 * stays on the event as a fallback; clients that know a code translate it themselves.
 */
const STAGE_RULES = [
  [/^Đang đọc tài liệu đính kèm…$/, "stage.readingAttachments", () => ({})],
  [/^Đang đọc yêu cầu…$/, "stage.readingRequest", () => ({})],
  [/^Đang đọc tài liệu…$/, "stage.readingDocuments", () => ({})],
  [/^Đang phân tích yêu cầu…$/, "stage.analyzing", () => ({})],
  [/^Đang dựng…$/, "stage.building", () => ({})],
  [/^Đang dựng… (\d+)s$/, "stage.buildingElapsed", (m) => ({ seconds: Number(m[1]) })],
  [/^Đang tự kiểm tra…$/, "stage.checking", () => ({})],
  [/^Đang kiểm tra…$/, "stage.checking", () => ({})],
  [/^Sửa (\d+) lỗi hình học$/, "stage.repairGeometry", (m) => ({ count: Number(m[1]) })],
  [/^Sửa (\d+) lỗi mô hình$/, "stage.repairModel", (m) => ({ count: Number(m[1]) })],
  [
    /^Nối hoặc bỏ (\d+) tham số không dùng$/,
    "stage.repairParameters",
    (m) => ({ count: Number(m[1]) }),
  ],
  [
    /^Hết thời gian lượt (\d+) — thử lại với yêu cầu gọn hơn$/,
    "stage.retryTimeout",
    (m) => ({ attempt: Number(m[1]) }),
  ],
  [/^Model hết lượt của CLI — thử lại với thêm 1 lượt$/, "stage.retryMaxTurns", () => ({})],
  [
    /^Nhà cung cấp model đang quá tải — tự thử lại sau (\d+)s \(lần (\d+)\/(\d+)\)$/,
    "stage.retryProvider",
    (m) => ({ seconds: Number(m[1]), attempt: Number(m[2]), total: Number(m[3]) }),
  ],
  [
    /^Model (.+) đang quá tải, đã chuyển sang (.+)$/,
    "stage.fallbackOverloaded",
    (m) => ({ from: m[1], to: m[2] }),
  ],
  [
    /^Model (.+) lỗi, đã chuyển sang (.+)$/,
    "stage.fallbackError",
    (m) => ({ from: m[1], to: m[2] }),
  ],
  [
    /^Dựng từ khuôn (.+) — không cần gọi model$/,
    "stage.template",
    (m) => ({ family: m[1] }),
  ],
  [/^Còn (\d+) lỗi trong mô hình$/, "stage.needsWork", (m) => ({ count: Number(m[1]) })],
  [/^Đang làm mới (.+)$/, "stage.refreshing", (m) => ({ name: m[1] })],
  [/^Đang dựng lại (.+)$/, "stage.rebuilding", (m) => ({ name: m[1] })],
];

function matchStage(message) {
  const text = String(message ?? "").trim();
  for (const [pattern, code, params] of STAGE_RULES) {
    const match = pattern.exec(text);
    if (match) return { code, params: params(match) };
  }
  return null;
}

export function enrichIssue(issue) {
  if (!issue || typeof issue !== "object") return issue;

  const text = String(issue.message ?? "");
  const next = { ...issue };

  if (/rotated off the 90° axes/i.test(text)) {
    return { ...next, code: "issue.rotatedBox", params: {} };
  }

  const offset = /host is offset (\d+(?:\.\d+)?) mm from the spec origin/i.exec(text);
  if (offset || /lệch \d+(?:\.\d+)? mm so với gốc spec/i.test(text)) {
    const name = /Connector "([^"]*)"/i.exec(text)?.[1] ?? "";
    const mm = Number(offset?.[1] ?? /lệch (\d+(?:\.\d+)?)/i.exec(text)?.[1] ?? 0);
    return { ...next, code: "issue.connectorOffset", params: { name, mm } };
  }

  if (/không điều khiển hình nào|never used by a formula/i.test(text)) {
    const name = String(issue.path ?? "").replace(/^parameters\./, "");
    return { ...next, code: "issue.unusedParameter", params: { name } };
  }

  return issue;
}

/** Attach codes to every event that the studio renders. */
export function enrichEvent(event) {
  if (!event || typeof event !== "object") return event;
  const next = { ...event };

  if (event.type === "stage") {
    const hit = matchStage(event.message);
    if (hit) {
      next.code = hit.code;
      next.params = hit.params;
    }
  }

  if (event.type === "error") {
    next.code = `error.${event.kind || "unknown"}`;
    next.params = {};
  }

  if (Array.isArray(event.issues)) next.issues = event.issues.map(enrichIssue);
  if (Array.isArray(event.errors)) next.errors = event.errors.map(enrichIssue);
  return next;
}
