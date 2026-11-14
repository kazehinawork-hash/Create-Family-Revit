import { describe, expect, it } from "vitest";

import { THEME_KEY, applyTheme, readTheme, resolveTheme, writeTheme } from "./theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    read: () => data,
  };
}

describe("theme preference", () => {
  it("defaults to system", () => {
    expect(readTheme(memoryStorage())).toBe("system");
  });

  it("round-trips a stored mode", () => {
    const storage = memoryStorage();
    writeTheme("dark", storage);
    expect(storage.read()[THEME_KEY]).toBe("dark");
    expect(readTheme(storage)).toBe("dark");
  });

  it("ignores an unknown stored value", () => {
    expect(readTheme(memoryStorage({ [THEME_KEY]: "neon" }))).toBe("system");
  });

  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readTheme(broken)).toBe("system");
    expect(() => writeTheme("light", broken)).not.toThrow();
  });

  it("resolves system against the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("writes the palette to the root element", () => {
    const attributes: Record<string, string> = {};
    const root = {
      dataset: attributes,
      style: {} as CSSStyleDeclaration,
    } as unknown as HTMLElement;

    applyTheme("dark", root);
    expect(attributes.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });
});
