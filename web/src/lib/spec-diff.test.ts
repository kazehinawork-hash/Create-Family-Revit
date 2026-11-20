import { describe, expect, it } from "vitest";
import type { FamilySpec } from "@family/spec-core";
import { diffNotes, diffSpecs } from "./spec-diff";

const base = (): FamilySpec => ({
  schemaVersion: "1.0",
  name: "Tray",
  category: "Cable Tray Fitting",
  units: "mm",
  parameters: [
    { name: "Width", type: "Length", value: 400 },
    { name: "Height", type: "Length", value: 100 },
    { name: "Half Width", type: "Length", formula: "[Width] / 2" },
  ],
  parts: [
    {
      id: "rail",
      name: "Side Rail",
      solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[Width]", y: 10, z: 2 } },
    },
    {
      id: "rung",
      name: "Rung",
      solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[Width]", y: 10, z: 2 } },
    },
  ],
  notes: ["Giả định: Height = 100 mm (chiều cao tiêu chuẩn)."],
});

describe("spec diff", () => {
  it("reports added, changed and removed parts without treating reordered keys as edits", () => {
    const previous = base();
    const next = base();
    next.parts[0] = { ...next.parts[0], cuts: [] };
    next.parts.push({
      id: "cover",
      name: "Cover",
      solid: { kind: "box", origin: { x: 0, y: 0, z: 2 }, size: { x: 400, y: 100, z: 2 } },
    });
    next.parts = next.parts.filter((part) => part.id !== "rung");

    const diff = diffSpecs(previous, next);
    expect(diff.parts.map((part) => `${part.kind}:${part.id}`).sort()).toEqual([
      "added:cover",
      "removed:rung",
      "updated:rail",
    ]);
    expect(diff.changedPartIds.sort()).toEqual(["cover", "rail"]);
  });

  it("reports parameter value and formula changes with readable old/new text", () => {
    const previous = base();
    const next = base();
    next.parameters[0] = { ...next.parameters[0], value: 500 };
    next.parameters[1] = { ...next.parameters[1], formula: "[Width] * 0.3" };
    next.parameters[2] = { ...next.parameters[2], formula: "[Width] / 3" };

    const diff = diffSpecs(previous, next);
    const byName = new Map(diff.parameters.map((parameter) => [parameter.name, parameter]));
    expect(byName.get("Width")).toMatchObject({ kind: "updated", from: "400", to: "500" });
    expect(byName.get("Height")).toMatchObject({
      kind: "updated",
      from: "100",
      to: "= [Width] * 0.3",
    });
    expect(byName.get("Half Width")?.from).toBe("= [Width] / 2");
    expect(diff.changedPartIds).toEqual(expect.arrayContaining(["rail", "rung"]));
  });

  it("keeps only new assumptions as fresh notes", () => {
    const notes = diffNotes(
      [
        "Đã vát góc giao.",
        "Giả định: Height = 100 mm (tiêu chuẩn).",
      ],
      [
        "Đã vát góc giao.",
        "Đã tăng bán kính góc.",
        "Giả định: Height = 100 mm (tiêu chuẩn).",
        "Giả định: Fillet = 10 mm (theo bản vẽ).",
      ],
    );
    expect(notes.answer).toBe("Đã tăng bán kính góc.");
    expect(notes.fresh).toEqual(["Giả định: Fillet = 10 mm (theo bản vẽ)."]);
    expect(notes.old).toEqual(["Giả định: Height = 100 mm (tiêu chuẩn)."]);
  });

  it("does not repeat an old answer on a turn without a new note", () => {
    expect(diffNotes(["Đã vát góc giao."], ["Đã vát góc giao."]).answer).toBeUndefined();
    expect(diffNotes([], ["Width = 400 — datasheet"]).answer).toBeUndefined();
  });

  it("treats a reworded assumption with the same parameter and value as old", () => {
    const notes = diffNotes(
      ["Giả định: Rung Pitch = 300 mm (cũ)."],
      ["Giả định: Rung Pitch = 300 mm (diễn đạt mới)."],
    );
    expect(notes.fresh).toEqual([]);
    expect(notes.old).toEqual(["Giả định: Rung Pitch = 300 mm (diễn đạt mới)."]);
  });

  it("keeps consecutive turns from repeating answers while carrying old assumptions", () => {
    const turn1 = ["Đã vát góc giao.", "Giả định: Rung Pitch = 300 mm (tiêu chuẩn)."];
    const turn2 = [
      ...turn1,
      "Đã tăng bán kính góc.",
      "Giả định: Fillet = 10 mm (bản vẽ).",
    ];
    const turn3 = [
      "Đã vát góc giao.",
      "Đã tăng bán kính góc.",
      "Đã hạ chiều cao máng.",
      "Giả định: Rung Pitch = 300 mm (tiêu chuẩn).",
      "Giả định: Fillet = 10 mm (bản vẽ).",
      "Giả định: Height = 90 mm (yêu cầu mới).",
    ];
    expect(diffNotes(turn1, turn2).answer).toBe("Đã tăng bán kính góc.");
    const third = diffNotes(turn2, turn3);
    expect(third.answer).toBe("Đã hạ chiều cao máng.");
    expect(third.fresh).toEqual(["Giả định: Height = 90 mm (yêu cầu mới)."]);
    expect(third.old).toHaveLength(2);
  });
});
