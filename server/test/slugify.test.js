import assert from "node:assert/strict";
import test from "node:test";
import { slugify } from "../src/bridge.js";

test("slugify produces ASCII-safe file names with Vietnamese diacritics", () => {
  assert.equal(
    slugify("Van Cổng Ty Chìm Mặt Bích Gang Cầu DN100 PN16 - Bu Lông Xuyên M16 Đầu Lục Giác"),
    "Van-Cong-Ty-Chim-Mat-Bich-Gang-Cau-DN100-PN16-Bu-Long-Xuyen-M16-Dau-Luc-Giac",
  );
  assert.match(slugify("Đồ gá"), /^Do-ga$/);
  assert.equal(slugify("  "), "family");
});
