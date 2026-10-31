import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkOutboundUrl,
  createRateLimiter,
  isAllowedHost,
  isAllowedOrigin,
  isInside,
  isSafeUpload,
  safeDownloadPath,
} from "../src/security.js";

test("isInside accepts the root and children but refuses escapes", () => {
  const root = path.join(os.tmpdir(), "family-agent-root");
  assert.equal(isInside(root, path.join(root, "a", "b.json")), true);
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, path.join(root, "..", "elsewhere.json")), false);
  assert.equal(isInside(root, path.join(os.tmpdir(), "other.json")), false);
});

test("isAllowedHost only trusts loopback names", () => {
  assert.equal(isAllowedHost("localhost:8787"), true);
  assert.equal(isAllowedHost("127.0.0.1:8787"), true);
  assert.equal(isAllowedHost("[::1]:8787"), true);
  assert.equal(isAllowedHost("example.com"), false);
  assert.equal(isAllowedHost("192.168.1.20:8787"), false);
  assert.equal(isAllowedHost("192.168.1.20:8787", ["192.168.1.20"]), true);
  assert.equal(isAllowedHost(undefined), false);
});

test("only document/image extensions may be uploaded", () => {
  assert.equal(isSafeUpload("datasheet.pdf"), true);
  assert.equal(isSafeUpload("PHOTO.JPG"), true);
  assert.equal(isSafeUpload("drawing.svg"), false);
  assert.equal(isSafeUpload("payload.html"), false);
  assert.equal(isSafeUpload("script.js"), false);
  assert.equal(isSafeUpload("no-extension"), false);
});

test("safeDownloadPath refuses files outside the allowed roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "family-agent-"));
  const inside = path.join(root, "family.rfa");
  const outside = path.join(os.tmpdir(), `family-agent-outside-${Date.now()}.rfa`);
  fs.writeFileSync(inside, "x");
  fs.writeFileSync(outside, "x");

  try {
    assert.equal(safeDownloadPath(inside, [root]), inside);
    assert.equal(safeDownloadPath(path.join(root, "missing.rfa"), [root]), null);
    assert.equal(safeDownloadPath(outside, [root]), null);
    assert.equal(safeDownloadPath(path.join(root, "..", "escape.rfa"), [root]), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test("the origin guard only trusts the studio", () => {
  assert.equal(isAllowedOrigin(undefined, "127.0.0.1:8787"), true);
  assert.equal(isAllowedOrigin("http://localhost:5173", "127.0.0.1:8787"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:8787", "127.0.0.1:8787"), true);
  assert.equal(isAllowedOrigin("https://evil.example", "127.0.0.1:8787"), false);
  assert.equal(isAllowedOrigin("not a url", "127.0.0.1:8787"), false);
});

test("the rate limiter blocks after the limit and resets per key", () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 2 });

  assert.equal(limiter("a").allowed, true);
  assert.equal(limiter("a").allowed, true);

  const blocked = limiter("a");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);

  // Another client is not affected.
  assert.equal(limiter("b").allowed, true);
});

test("outbound verification URLs are http(s) and not cloud metadata", () => {
  assert.equal(checkOutboundUrl("https://api.openai.com/v1").ok, true);
  assert.equal(checkOutboundUrl("http://localhost:11434/v1").ok, true);
  assert.equal(checkOutboundUrl("file:///etc/passwd").ok, false);
  assert.equal(checkOutboundUrl("gopher://example.com").ok, false);
  assert.equal(checkOutboundUrl("http://169.254.169.254/latest/meta-data").ok, false);
  assert.equal(checkOutboundUrl("not a url").ok, false);
});
