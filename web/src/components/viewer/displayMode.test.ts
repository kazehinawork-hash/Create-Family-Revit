import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY_MODE,
  DISPLAY_MODE_OPTIONS,
  readDisplayMode,
  readSilhouettes,
  writeDisplayMode,
  writeSilhouettes,
} from "./displayMode";

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("viewer display mode preferences", () => {
  it("defaults to shadedEdges and silhouettes enabled when storage is empty or unavailable", () => {
    expect(readDisplayMode(fakeStorage())).toBe(DEFAULT_DISPLAY_MODE);
    expect(readDisplayMode(null)).toBe("shadedEdges");
    expect(readSilhouettes(fakeStorage())).toBe(true);
    expect(readSilhouettes(null)).toBe(true);
  });

  it("remembers each Revit-style display mode and ignores invalid values", () => {
    const storage = fakeStorage();
    for (const mode of DISPLAY_MODE_OPTIONS) {
      writeDisplayMode(mode, storage);
      expect(readDisplayMode(storage)).toBe(mode);
    }
    storage.setItem("fa.viewer.displayMode", "bogus");
    expect(readDisplayMode(storage)).toBe("shadedEdges");
  });

  it("remembers silhouettes toggle state", () => {
    const storage = fakeStorage();
    writeSilhouettes(false, storage);
    expect(readSilhouettes(storage)).toBe(false);
    writeSilhouettes(true, storage);
    expect(readSilhouettes(storage)).toBe(true);
  });
});
