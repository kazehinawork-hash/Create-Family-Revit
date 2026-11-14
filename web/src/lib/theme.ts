export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "family.theme.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storageOrDefault(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readTheme(storage?: StorageLike | null): ThemeMode {
  const target = storageOrDefault(storage);
  if (!target) return "system";
  try {
    const value = target.getItem(THEME_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

export function writeTheme(mode: ThemeMode, storage?: StorageLike | null): void {
  const target = storageOrDefault(storage);
  if (!target) return;
  try {
    target.setItem(THEME_KEY, mode);
  } catch {
    // Private mode / full quota: the theme still applies for this session.
  }
}

/** Which palette a mode shows; `system` follows the OS preference. */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === "light" || mode === "dark") return mode;
  return systemPrefersDark ? "dark" : "light";
}

/** Applies the palette to <html data-theme>, which every CSS token reads. */
export function applyTheme(resolved: ResolvedTheme, root?: HTMLElement | null): void {
  try {
    const target = root ?? (typeof document !== "undefined" ? document.documentElement : null);
    if (!target) return;
    target.dataset.theme = resolved;
    target.style.colorScheme = resolved;
  } catch {
    // Never let a theme switch break the studio.
  }
}

export function systemPrefersDark(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  } catch {
    return false;
  }
}
