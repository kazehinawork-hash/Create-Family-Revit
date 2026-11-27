export type ViewerDisplayMode = "shaded" | "shadedEdges" | "hiddenLine" | "wireframe";

export const DEFAULT_DISPLAY_MODE: ViewerDisplayMode = "shadedEdges";
export const DISPLAY_MODE_KEY = "fa.viewer.displayMode";
export const SILHOUETTES_KEY = "fa.viewer.silhouettes";

export const DISPLAY_MODE_OPTIONS: readonly ViewerDisplayMode[] = [
  "shaded",
  "shadedEdges",
  "hiddenLine",
  "wireframe",
] as const;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storageOrDefault(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function isViewerDisplayMode(value: unknown): value is ViewerDisplayMode {
  return (
    value === "shaded" ||
    value === "shadedEdges" ||
    value === "hiddenLine" ||
    value === "wireframe"
  );
}

export function readDisplayMode(storage?: StorageLike | null): ViewerDisplayMode {
  const target = storageOrDefault(storage);
  if (!target) return DEFAULT_DISPLAY_MODE;
  try {
    const value = target.getItem(DISPLAY_MODE_KEY);
    return isViewerDisplayMode(value) ? value : DEFAULT_DISPLAY_MODE;
  } catch {
    return DEFAULT_DISPLAY_MODE;
  }
}

export function writeDisplayMode(mode: ViewerDisplayMode, storage?: StorageLike | null): void {
  const target = storageOrDefault(storage);
  if (!target) return;
  try {
    target.setItem(DISPLAY_MODE_KEY, mode);
  } catch {
    // Ignore storage quota or private browsing errors.
  }
}

export function readSilhouettes(storage?: StorageLike | null): boolean {
  const target = storageOrDefault(storage);
  if (!target) return true;
  try {
    const value = target.getItem(SILHOUETTES_KEY);
    if (value === "0" || value === "false") return false;
    if (value === "1" || value === "true") return true;
    return true;
  } catch {
    return true;
  }
}

export function writeSilhouettes(enabled: boolean, storage?: StorageLike | null): void {
  const target = storageOrDefault(storage);
  if (!target) return;
  try {
    target.setItem(SILHOUETTES_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage quota or private browsing errors.
  }
}
