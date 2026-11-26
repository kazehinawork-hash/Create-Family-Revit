import { useEffect, useState } from "react";
import {
  applyTheme,
  readTheme,
  resolveTheme,
  systemPrefersDark,
  writeTheme,
  type ThemeMode,
} from "../lib/theme";

/** Manages studio theme mode, OS dark-mode tracking, and <html data-theme> persistence. */
export function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readTheme());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const resolvedTheme = resolveTheme(themeMode, systemDark);

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    writeTheme(themeMode);
  }, [themeMode]);

  useEffect(() => {
    try {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    } catch {
      return undefined;
    }
  }, []);

  return { themeMode, setThemeMode, resolvedTheme };
}
