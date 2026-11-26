import type { FamilySpec } from "@family/spec-core";
import { describe, expect, it } from "vitest";
import { createInitialStudioState, studioReducer } from "./StudioContext";

const makeSpec = (name: string, lod?: 200 | 300 | 350 | 400): FamilySpec => ({
  schemaVersion: "1.0",
  name,
  category: "Cable Tray Fitting",
  units: "mm",
  ...(lod ? { lod } : {}),
  parameters: [{ name: "Width", type: "Length", value: 400 }],
  parts: [
    {
      id: "part-a",
      name: "Part A",
      material: "Steel",
      solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: 500, y: "[Width]", z: 2 } },
    },
    {
      id: "part-b",
      name: "Part B",
      material: "Steel",
      solid: { kind: "box", origin: { x: 0, y: 0, z: 50 }, size: { x: 500, y: "[Width]", z: 2 } },
    },
  ],
  materials: [{ name: "Steel" }],
});

describe("studioReducer", () => {
  it("tracks undo/redo history and clears highlightPartIds on APPLY_SPEC", () => {
    const s0 = createInitialStudioState("hello", { highlightPartIds: ["part-a"] });
    const spec1 = makeSpec("First");
    const spec2 = makeSpec("Second");

    const s1 = studioReducer(s0, { type: "APPLY_SPEC", spec: spec1, now: 1000 });
    expect(s1.spec?.name).toBe("First");
    expect(s1.highlightPartIds).toEqual([]);
    expect(s1.past).toEqual([]);

    const s2 = studioReducer(s1, { type: "APPLY_SPEC", spec: spec2, native: false, now: 2000 });
    expect(s2.spec?.name).toBe("Second");
    expect(s2.past).toHaveLength(1);
    expect(s2.future).toEqual([]);

    const undone = studioReducer(s2, { type: "UNDO_SPEC" });
    expect(undone.spec?.name).toBe("First");
    expect(undone.future).toHaveLength(1);

    const redone = studioReducer(undone, { type: "REDO_SPEC" });
    expect(redone.spec?.name).toBe("Second");
    expect(redone.past).toHaveLength(1);
  });

  it("loads a family atomically via LOAD_FAMILY and resets transient viewer/chat state", () => {
    const dirty = createInitialStudioState("hello", {
      spec: makeSpec("Old"),
      currentModelId: "old-id",
      selectedPartId: "part-a",
      hiddenPartIds: ["part-b"],
      transparentPartIds: ["part-a"],
      chatTargets: [{ partId: "part-a", partName: "Part A" }],
      native: true,
    });
    const loadedSpec = makeSpec("Loaded", 400);
    const loaded = studioReducer(dirty, {
      type: "LOAD_FAMILY",
      spec: loadedSpec,
      modelId: "new-id",
      annotations: [
        {
          id: "n1",
          partId: "part-b",
          partName: "Part B",
          point: { x: 0, y: 0, z: 10 },
          text: "Check weld",
          status: "open",
          createdAt: 100,
        },
      ],
      entries: [{ id: "e1", role: "agent", text: "Opened" }],
    });

    expect(loaded.spec?.name).toBe("Loaded");
    expect(loaded.currentModelId).toBe("new-id");
    expect(loaded.lod).toBe(400);
    expect(loaded.native).toBe(false);
    expect(loaded.selectedPartId).toBeNull();
    expect(loaded.hiddenPartIds).toEqual([]);
    expect(loaded.transparentPartIds).toEqual([]);
    expect(loaded.chatTargets).toEqual([]);
    expect(loaded.modelNotes).toHaveLength(1);
    expect(loaded.entries).toEqual([{ id: "e1", role: "agent", text: "Opened" }]);
  });

  it("applies design result, appends entry, and resolves targeted notes via APPLY_DESIGN_RESULT", () => {
    const initial = createInitialStudioState("hello", {
      spec: makeSpec("V1"),
      modelNotes: [
        {
          id: "note-1",
          partId: "part-a",
          partName: "Part A",
          point: { x: 0, y: 0, z: 0 },
          text: "Fix thickness",
          status: "open",
          createdAt: 50,
        },
      ],
    });
    const next = studioReducer(initial, {
      type: "APPLY_DESIGN_RESULT",
      spec: makeSpec("V2"),
      resolvedNoteIds: ["note-1"],
      entry: { role: "agent", text: "Done" },
      now: 5000,
    });

    expect(next.spec?.name).toBe("V2");
    expect(next.native).toBe(false);
    expect(next.past).toHaveLength(1);
    expect(next.modelNotes[0]).toMatchObject({ status: "resolved", resolvedAt: 5000 });
    expect(next.entries[next.entries.length - 1]).toMatchObject({ role: "agent", text: "Done" });
  });

  it("resets whole studio session cleanly via RESET_SESSION", () => {
    const busy = createInitialStudioState("seed", {
      spec: makeSpec("Busy"),
      currentModelId: "m1",
      selectedPartId: "part-a",
      hiddenPartIds: ["part-b"],
      chatTargets: [{ partId: "part-a", partName: "Part A" }],
      native: true,
    });
    const reset = studioReducer(busy, {
      type: "RESET_SESSION",
      greetingEntry: { id: "seed", role: "agent", text: "Welcome" },
    });
    expect(reset.spec).toBeNull();
    expect(reset.currentModelId).toBeNull();
    expect(reset.selectedPartId).toBeNull();
    expect(reset.hiddenPartIds).toEqual([]);
    expect(reset.chatTargets).toEqual([]);
    expect(reset.native).toBe(false);
    expect(reset.entries).toEqual([{ id: "seed", role: "agent", text: "Welcome" }]);
  });

  it("deduplicates targets and syncs default model safely", () => {
    const s1 = studioReducer(createInitialStudioState(), {
      type: "ADD_CHAT_TARGETS",
      targets: [
        { partId: "a", partName: "A" },
        { partId: "b", partName: "B" },
      ],
    });
    const s2 = studioReducer(s1, {
      type: "ADD_CHAT_TARGETS",
      targets: [
        { partId: "b", partName: "B" },
        { partId: "c", partName: "C" },
      ],
    });
    expect(s2.chatTargets.map((x) => x.partId)).toEqual(["a", "b", "c"]);
    expect(s2.chatFocusSignal).toBe(2);

    const synced = studioReducer(s2, {
      type: "SYNC_DEFAULT_MODEL",
      availableIds: ["m1", "m2"],
      serverDefaultModel: "m2",
    });
    expect(synced.model).toBe("m2");
  });
});
