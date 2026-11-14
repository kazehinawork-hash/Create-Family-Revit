import { describe, expect, it } from "vitest";

import {
  ALL_GROUPS,
  UNGROUPED,
  buildSections,
  filterModels,
  groupCounts,
  groupOf,
  readLibraryState,
  selectionLabel,
  sidebarGroups,
  sortModels,
  visibleModels,
  writeLibraryState,
} from "./library";
import type { SavedModelMeta } from "./api";

function model(partial: Partial<SavedModelMeta> & { id: string }): SavedModelMeta {
  return {
    name: partial.id,
    category: "Mechanical Equipment",
    updatedAt: 1,
    partsCount: 1,
    paramsCount: 1,
    group: "",
    ...partial,
  } as SavedModelMeta;
}

const models: SavedModelMeta[] = [
  model({ id: "a", name: "Bơm ly tâm", category: "Mechanical Equipment", group: "Bơm", updatedAt: 300 }),
  model({ id: "b", name: "Thang cáp", category: "Electrical Equipment", group: "Điện", updatedAt: 200 }),
  model({ id: "c", name: "Quạt hút", category: "Mechanical Equipment", group: "", updatedAt: 100 }),
  model({ id: "d", name: "Bơm chữa cháy", category: "Mechanical Equipment", group: "Bơm", updatedAt: 400 }),
];

describe("library model helpers", () => {
  it("treats a missing group as Chưa nhóm", () => {
    expect(groupOf(model({ id: "x" }))).toBe(UNGROUPED);
    expect(groupOf({ ...models[0], group: undefined })).toBe(UNGROUPED);
  });

  it("filters by name, category and type name", () => {
    expect(filterModels(models, "bơm").map((entry) => entry.id)).toEqual(["a", "d"]);
    expect(filterModels(models, "ELECTRICAL").map((entry) => entry.id)).toEqual(["b"]);
    expect(filterModels(models, "  ")).toHaveLength(4);
  });

  it("sorts by newest, name and category", () => {
    expect(sortModels(models, "recent").map((entry) => entry.id)).toEqual(["d", "a", "b", "c"]);
    expect(sortModels(models, "name").map((entry) => entry.id)).toEqual(["d", "a", "c", "b"]);
    expect(sortModels(models, "category").map((entry) => entry.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("counts groups and keeps stored order", () => {
    expect(groupCounts(models)).toEqual({ "": 1, bơm: 2, điện: 1 });

    const sidebar = sidebarGroups(models, [{ name: "Bơm" }, { name: "Mới" }]);
    expect(sidebar).toEqual([
      { name: "Bơm", count: 2 },
      { name: "Mới", count: 0 },
      { name: "Điện", count: 1 },
    ]);
  });

  it("does not duplicate a group that differs only by case", () => {
    const sidebar = sidebarGroups(models, [{ name: "BƠM" }]);
    expect(sidebar.map((group) => group.name)).toEqual(["BƠM", "Điện"]);
  });

  it("groups the Tất cả view and puts Chưa nhóm last", () => {
    const sections = buildSections(models, [{ name: "Bơm" }, { name: "Điện" }], "recent");

    expect(sections.map((section) => section.label)).toEqual(["Bơm", "Điện", "Chưa nhóm"]);
    expect(sections[0].models.map((entry) => entry.id)).toEqual(["d", "a"]);
    expect(sections[2].models.map((entry) => entry.id)).toEqual(["c"]);
  });

  it("limits the visible list to the selected group", () => {
    const base = { query: "", sort: "recent" as const };
    expect(visibleModels(models, { ...base, group: ALL_GROUPS })).toHaveLength(4);
    expect(visibleModels(models, { ...base, group: "Bơm" }).map((entry) => entry.id)).toEqual(["d", "a"]);
    expect(visibleModels(models, { ...base, group: UNGROUPED }).map((entry) => entry.id)).toEqual(["c"]);
    expect(visibleModels(models, { ...base, group: "Bơm", query: "chữa" }).map((entry) => entry.id)).toEqual(["d"]);
  });

  it("labels the selection", () => {
    expect(selectionLabel(ALL_GROUPS)).toBe("Tất cả");
    expect(selectionLabel(UNGROUPED)).toBe("Chưa nhóm");
    expect(selectionLabel("Điện")).toBe("Điện");
  });
});

describe("library view state", () => {
  function memoryStorage(initial: string | null = null) {
    let value = initial;
    return {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
      },
      read: () => value,
    };
  }

  it("defaults to Tất cả with nothing collapsed", () => {
    expect(readLibraryState(memoryStorage())).toEqual({
      group: ALL_GROUPS,
      collapsed: [],
      sort: "recent",
    });
  });

  it("round-trips the selected group, collapsed sections and sort", () => {
    const storage = memoryStorage();
    writeLibraryState({ group: "Bơm", collapsed: ["Điện"], sort: "name" }, storage);

    expect(readLibraryState(storage)).toEqual({
      group: "Bơm",
      collapsed: ["Điện"],
      sort: "name",
    });
  });

  it("ignores corrupted storage instead of throwing", () => {
    expect(readLibraryState(memoryStorage("{not json"))).toEqual({
      group: ALL_GROUPS,
      collapsed: [],
      sort: "recent",
    });

    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLibraryState(broken).group).toBe(ALL_GROUPS);
    expect(() => writeLibraryState({ group: "X" }, broken)).not.toThrow();
  });
});
