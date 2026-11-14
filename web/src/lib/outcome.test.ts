import { describe, expect, it } from "vitest";

import { describeOutcome, designOutcomeOf, errorAdvice, splitErrorMessage } from "./outcome";

const spec = { name: "Ngã tư thang cáp" };

describe("describeOutcome", () => {
  it("words a clean run as created or updated", () => {
    expect(describeOutcome({ stats: { complete: true }, analysis: { ok: true, spec } })).toEqual({
      outcome: "ok",
      tone: "normal",
      title: "Đã tạo Ngã tư thang cáp.",
      items: [],
    });

    expect(
      describeOutcome({ stats: { complete: true }, analysis: { ok: true, spec } }, { updated: true })
        .title,
    ).toBe("Đã cập nhật Ngã tư thang cáp.");
  });

  it("lists the missing groups when the result is incomplete", () => {
    const copy = describeOutcome({
      stats: { complete: false, missing: ["6 bậc thang"] },
      analysis: { ok: true, spec },
    });

    expect(copy.outcome).toBe("incomplete");
    expect(copy.tone).toBe("warning");
    expect(copy.title).toBe("⚠ Chưa đầy đủ — Ngã tư thang cáp");
    expect(copy.items).toEqual(["6 bậc thang"]);
  });

  it("counts the errors when the spec has errors", () => {
    const copy = describeOutcome({
      stats: { complete: true },
      analysis: { ok: false, spec, errors: [{ message: "part outside bounds" }, { message: "bad cut" }] },
    });

    expect(copy.outcome).toBe("has-errors");
    expect(copy.title).toBe("⚠ Đã dựng Ngã tư thang cáp nhưng còn 2 lỗi");
    // The list itself is rendered from the clickable issues, not repeated in the text.
    expect(copy.items).toEqual([]);
  });

  it("never reads a kept old spec as an update", () => {
    const copy = describeOutcome({
      stats: { unchanged: true, warnings: ["Chưa áp dụng được thay đổi: timeout"] },
      analysis: { ok: true, spec },
    });

    expect(copy.outcome).toBe("unchanged");
    expect(copy.title).toBe("⚠ Chưa áp dụng được thay đổi — giữ nguyên mô hình");
    expect(copy.title).not.toMatch(/Đã cập nhật/);
  });

  it("uses the server outcome flag when the stats are silent", () => {
    expect(designOutcomeOf({ stats: {}, analysis: { ok: true, spec } })).toBe("ok");
  });
});

describe("errorAdvice", () => {
  it("points an auth failure at the key settings", () => {
    expect(errorAdvice("auth")).toEqual({ hint: "Kiểm tra lại API key.", action: "open-api" });
  });

  it("offers a retry for overloaded and network failures", () => {
    expect(errorAdvice("overloaded").action).toBe("retry");
    expect(errorAdvice("network").action).toBe("retry");
  });

  it("suggests a faster model for timeouts and output limits", () => {
    expect(errorAdvice("timeout").hint).toMatch(/model nhanh hơn|chia nhỏ/);
    expect(errorAdvice("output-limit").hint).toMatch(/chia nhỏ/);
    expect(errorAdvice("timeout").action).toBe("retry");
  });

  it("offers no retry for an invalid request", () => {
    expect(errorAdvice("invalid-request").action).toBeNull();
  });

  it("falls back to a retry for an unknown kind", () => {
    expect(errorAdvice(undefined).action).toBe("retry");
    expect(errorAdvice("something-new").action).toBe("retry");
  });
});

describe("splitErrorMessage", () => {
  it("keeps a short message whole", () => {
    expect(splitErrorMessage("Không kết nối được")).toEqual({ text: "Không kết nối được" });
  });

  it("summarises a long provider dump and keeps the rest as details", () => {
    const long = `${"Chi tiết nhà cung cấp. ".repeat(30)}`;
    const result = splitErrorMessage(long);

    expect(result.text.length).toBeLessThanOrEqual(200);
    expect(result.details).toBe(long.trim());
  });
});
