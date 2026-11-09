import assert from "node:assert/strict";
import test from "node:test";
import { escapePowerShellString } from "../src/portable.js";

test("escapes characters that break a PowerShell double-quoted string", () => {
  assert.equal(
    escapePowerShellString('DN25 1" Twin Sphere Joint'),
    'DN25 1`" Twin Sphere Joint',
  );
  assert.equal(escapePowerShellString("$env:TEMP"), "`$env:TEMP");
  assert.equal(escapePowerShellString("back`tick"), "back``tick");
  assert.equal(escapePowerShellString("Bình thường"), "Bình thường");
});
