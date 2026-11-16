import { describe, expect, it } from "vitest";

import { translateServerMessage } from "./server-messages";

describe("server message codes", () => {
  it("translates a stage with params into all three languages", () => {
    expect(translateServerMessage("vi", "stage.buildingElapsed", { seconds: 12 }, "x")).toContain(
      "12s",
    );
    expect(translateServerMessage("en", "stage.buildingElapsed", { seconds: 12 }, "x")).toContain(
      "12s",
    );
    expect(translateServerMessage("zh", "stage.buildingElapsed", { seconds: 12 }, "x")).toContain(
      "12 秒",
    );
  });

  it("translates errors and issues without touching names", () => {
    expect(translateServerMessage("en", "error.overloaded", {}, "raw")).toMatch(/overloaded/i);
    expect(
      translateServerMessage(
        "zh",
        "issue.connectorOffset",
        { name: "conn-1", mm: 12.5 },
        "raw",
      ),
    ).toContain('"conn-1"');
  });

  it("falls back to the server text for unknown codes", () => {
    expect(translateServerMessage("en", "stage.not-known", {}, "Nguyên văn")).toBe("Nguyên văn");
    expect(translateServerMessage("en", undefined, {}, "Nguyên văn")).toBe("Nguyên văn");
  });
});
