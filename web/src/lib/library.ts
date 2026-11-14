import type { SavedModelMeta } from "./api";

/** Sentinel for the "Tất cả" filter; `""` always means "Chưa nhóm". */
export const ALL_GROUPS = "*";
export const UNGROUPED = "";
export const LIBRARY_STORAGE_KEY = "family.library.v1";

export type LibrarySort = "recent" | "name" | "category";

export const SORT_LABELS: Record<LibrarySort, string> = {
  recent: "Mới nhất",
  name: "Tên A–Z",
  category: "Category",
};

export interface LibraryGroupInfo {
  name: string;
  count?: number;
}

export interface LibrarySection {
  key: string;
  label: string;
  models: SavedModelMeta[];
}

export interface LibraryState {
  group: string;
  collapsed: string[];
  sort: LibrarySort;
}

export function groupOf(model: SavedModelMeta): string {
  return (model.group ?? "").trim();
}

export function isUngrouped(model: SavedModelMeta): boolean {
  return groupOf(model) === UNGROUPED;
}

export function groupKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Search matches the name, category and type name, case-insensitively. */
export function filterModels(models: SavedModelMeta[], query: string): SavedModelMeta[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;

  return models.filter((model) =>
    [model.name, model.category, model.typeName ?? ""].some((value) =>
      String(value ?? "").toLowerCase().includes(needle),
    ),
  );
}

const collator = new Intl.Collator("vi", { sensitivity: "base", numeric: true });

export function sortModels(models: SavedModelMeta[], sort: LibrarySort): SavedModelMeta[] {
  const out = [...models];
  if (sort === "name") {
    out.sort((a, b) => collator.compare(a.name, b.name));
  } else if (sort === "category") {
    out.sort(
      (a, b) =>
        collator.compare(a.category, b.category) || collator.compare(a.name, b.name),
    );
  } else {
    out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return out;
}

/** Count per group key (`""` for Chưa nhóm). */
export function groupCounts(models: SavedModelMeta[]): Record<string, number> {
  const counts: Record<string, number> = { [UNGROUPED]: 0 };
  for (const model of models) {
    const key = groupKey(groupOf(model));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Sidebar groups in stored order, plus any group that only exists on a model (older
 * data or a group created by an import) so no family becomes unreachable.
 */
export function sidebarGroups(
  models: SavedModelMeta[],
  groups: LibraryGroupInfo[],
): Array<{ name: string; count: number }> {
  const counts = groupCounts(models);
  const seen = new Set<string>();
  const out: Array<{ name: string; count: number }> = [];

  for (const group of groups) {
    const name = group.name.trim();
    if (!name) continue;
    const key = groupKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, count: counts[key] ?? 0 });
  }

  for (const model of models) {
    const name = groupOf(model);
    if (!name) continue;
    const key = groupKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, count: counts[key] ?? 0 });
  }

  return out;
}

/** The "Tất cả" view: one collapsible section per group, Chưa nhóm last. */
export function buildSections(
  models: SavedModelMeta[],
  groups: LibraryGroupInfo[],
  sort: LibrarySort,
): LibrarySection[] {
  const byGroup = new Map<string, SavedModelMeta[]>();
  for (const model of models) {
    const name = groupOf(model);
    const list = byGroup.get(name) ?? [];
    list.push(model);
    byGroup.set(name, list);
  }

  const sections: LibrarySection[] = [];
  for (const group of sidebarGroups(models, groups)) {
    const list = byGroup.get(group.name) ?? [];
    if (list.length === 0) continue;
    sections.push({ key: group.name, label: group.name, models: sortModels(list, sort) });
  }

  const ungrouped = byGroup.get(UNGROUPED) ?? [];
  if (ungrouped.length > 0) {
    sections.push({
      key: UNGROUPED,
      label: "Chưa nhóm",
      models: sortModels(ungrouped, sort),
    });
  }

  return sections;
}

/** Models visible for one sidebar selection, already filtered and sorted. */
export function visibleModels(
  models: SavedModelMeta[],
  { group, query, sort }: { group: string; query: string; sort: LibrarySort },
): SavedModelMeta[] {
  const scoped =
    group === ALL_GROUPS
      ? models
      : models.filter((model) => {
          const name = groupOf(model);
          return group === UNGROUPED ? name === UNGROUPED : name === group;
        });

  return sortModels(filterModels(scoped, query), sort);
}

export function isAllGroups(group: string): boolean {
  return group === ALL_GROUPS;
}

/** Sidebar label for the current selection ("Tất cả", "Chưa nhóm" or the group). */
export function selectionLabel(group: string): string {
  if (isAllGroups(group)) return "Tất cả";
  if (group === UNGROUPED) return "Chưa nhóm";
  return group;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storageOrDefault(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Collapsed groups and the selected group survive a reload; broken storage never throws. */
export function readLibraryState(storage?: StorageLike | null): LibraryState {
  const empty: LibraryState = { group: ALL_GROUPS, collapsed: [], sort: "recent" };
  const target = storageOrDefault(storage);
  if (!target) return empty;

  try {
    const raw = JSON.parse(target.getItem(LIBRARY_STORAGE_KEY) ?? "{}");
    const group = typeof raw?.group === "string" && raw.group ? raw.group : ALL_GROUPS;
    const collapsed = Array.isArray(raw?.collapsed)
      ? raw.collapsed.filter((entry: unknown): entry is string => typeof entry === "string")
      : [];
    const sort: LibrarySort =
      raw?.sort === "name" || raw?.sort === "category" || raw?.sort === "recent"
        ? raw.sort
        : "recent";
    return { group, collapsed, sort };
  } catch {
    return empty;
  }
}

export function writeLibraryState(state: Partial<LibraryState>, storage?: StorageLike | null): void {
  const target = storageOrDefault(storage);
  if (!target) return;

  try {
    const current = readLibraryState(target);
    target.setItem(
      LIBRARY_STORAGE_KEY,
      JSON.stringify({
        group: state.group ?? current.group,
        collapsed: state.collapsed ?? current.collapsed,
        sort: state.sort ?? current.sort,
      }),
    );
  } catch {
    // Quota or privacy mode: the library still works, it just forgets the view.
  }
}
