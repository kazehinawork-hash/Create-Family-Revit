import { describe, expect, it } from "vitest";

import { LANGUAGE_OPTIONS, readLanguage, writeLanguage } from "./i18n";
import { dictionaries } from "./strings";

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("language selection", () => {
  it("defaults to Vietnamese", () => {
    const storage = fakeStorage();
    expect(readLanguage(storage)).toBe("vi");
    expect(readLanguage(null)).toBe("vi");
  });

  it("remembers English and Chinese", () => {
    const storage = fakeStorage();
    writeLanguage("en", storage);
    expect(readLanguage(storage)).toBe("en");
    writeLanguage("zh", storage);
    expect(readLanguage(storage)).toBe("zh");
  });

  it("offers exactly VI / EN / 中文", () => {
    expect(LANGUAGE_OPTIONS.map((option) => option.label)).toEqual(["VI", "EN", "中文"]);
  });

  it("has the same keys in all three dictionaries", () => {
    const viKeys = Object.keys(dictionaries.vi).sort();
    expect(Object.keys(dictionaries.en).sort()).toEqual(viKeys);
    expect(Object.keys(dictionaries.zh).sort()).toEqual(viKeys);
  });

  it("has no empty translation", () => {
    for (const language of ["vi", "en", "zh"] as const) {
      for (const [key, value] of Object.entries(dictionaries[language])) {
        if (typeof value === "function") continue;
        expect(value, `${language}.${key}`).not.toBe("");
      }
    }
  });
});
