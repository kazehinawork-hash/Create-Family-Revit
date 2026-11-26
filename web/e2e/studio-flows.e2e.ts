import { expect, test } from "@playwright/test";

const fixtureSpec = {
  schemaVersion: "1.0",
  name: "Studio Flows Fixture",
  category: "Cable Tray Fitting",
  lod: 300,
  units: "mm",
  parameters: [
    { name: "Tray Width", type: "Length", value: 400 },
    { name: "Tray Height", type: "Length", value: 100 },
    { name: "Run Length", type: "Length", value: 800 },
  ],
  parts: [
    {
      id: "tray-bottom",
      name: "Bottom Plate",
      material: "Steel",
      solid: {
        kind: "box",
        origin: { x: 0, y: 0, z: 0 },
        size: { x: "[Run Length]", y: "[Tray Width]", z: 2 },
      },
    },
  ],
  materials: [{ name: "Steel", color: "#9aa3a8", metalness: 0.6, roughness: 0.4 }],
  notes: ["Đã dựng máng cáp mẫu để kiểm tra luồng studio."],
};

const fakeStats = {
  parts: 1,
  parameters: 3,
  instances: 1,
  materials: 1,
  bounds: { x: 800, y: 400, z: 100 },
  attempts: 1,
  elapsedMs: 600,
  model: "agy:gemini-4-hydrogen-low",
  modelCalls: 1,
  calls: [{ model: "agy:gemini-4-hydrogen-low", modelCalls: 1, inChars: 1100, outChars: 520 }],
  complete: true,
  warnings: [],
};

test("chat send, stop (cancel), error and retry flows work end-to-end", async ({ page }) => {
  test.setTimeout(60_000);
  let calls = 0;

  await page.route("**/api/design", async (route) => {
    calls += 1;
    if (calls === 1) {
      // Hold request open briefly so Stop button stays visible, then let client abort cleanly.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.abort().catch(() => {});
      return;
    }
    if (calls === 2) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        body: `data: ${JSON.stringify({
          type: "error",
          kind: "unknown",
          message: "Simulated transient failure",
        })}\n\n`,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body:
        `data: ${JSON.stringify({ type: "job", jobId: "flows-retry-ok" })}\n\n` +
        `data: ${JSON.stringify({
          type: "spec",
          spec: fixtureSpec,
          stats: fakeStats,
          issues: [],
          errors: [],
          outcome: "ok",
        })}\n\n`,
    });
  });

  await page.goto("/");
  const composer = page.locator("textarea").first();

  // 1. Send and immediately Stop/Cancel.
  await composer.fill("Dựng máng cáp để test huỷ.");
  await page.getByTestId("chat-send").click();
  const stopBtn = page.locator(".send.stop");
  await expect(stopBtn).toBeVisible();
  await stopBtn.click();
  await expect(page.locator(".msg-agent").last()).toContainText("Đã dừng.");

  // 2. Send and receive SSE error -> click Retry -> succeed.
  await composer.fill("Dựng máng cáp để test lỗi và retry.");
  await page.getByTestId("chat-send").click();
  const retryBtn = page.getByTestId("chat-retry").last();
  await expect(retryBtn).toBeVisible();
  await retryBtn.click();

  await expect(page.locator('[data-testid="chat-changes"]')).toHaveCount(1);
  await expect(page.locator(".viewer-caption")).toContainText("1 chi tiết");
});

test("model selection, LOD selection, theme toggle, panel resize, and server offline detection", async ({
  page,
}) => {
  test.setTimeout(60_000);
  let capturedDesignPayload: Record<string, unknown> | null = null;
  let pingOffline = false;

  await page.route("**/api/health", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        agent: { ready: true, provider: "commandcode", model: "agy:gemini-4-hydrogen-high", detail: "ok" },
        backends: { commandcode: false, agy: true, codex: false, claude: false, openai: false },
        models: [
          { id: "agy:gemini-4-hydrogen-high", category: "AGY", label: "Hydrogen High" },
          { id: "agy:gemini-4-hydrogen-low", category: "AGY", label: "Hydrogen Low" },
        ],
      },
    });
  });

  await page.route("**/api/ping", async (route) => {
    if (pingOffline) {
      await route.fulfill({ status: 503, json: { ok: false } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });

  await page.route("**/api/design", async (route) => {
    capturedDesignPayload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body:
        `data: ${JSON.stringify({ type: "job", jobId: "flows-opts" })}\n\n` +
        `data: ${JSON.stringify({
          type: "spec",
          spec: { ...fixtureSpec, lod: 400 },
          stats: fakeStats,
          issues: [],
          errors: [],
          outcome: "ok",
        })}\n\n`,
    });
  });

  await page.goto("/");

  // Change model & LOD and confirm outgoing design payload + persistence.
  const modelSelect = page.locator("select.model-select");
  await expect(modelSelect).toBeEnabled();
  await modelSelect.selectOption("agy:gemini-4-hydrogen-low");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("fa.model"))).toBe(
    "agy:gemini-4-hydrogen-low",
  );

  const lodSelect = page.locator("select.lod-select");
  await lodSelect.selectOption("400");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("fa.lod"))).toBe("400");

  await page.locator("textarea").first().fill("Kiểm tra model và LOD.");
  await page.getByTestId("chat-send").click();
  await expect.poll(() => capturedDesignPayload?.model).toBe("agy:gemini-4-hydrogen-low");
  expect(capturedDesignPayload?.lod).toBe(400);

  // Switch theme to dark and verify HTML attribute + reload persistence.
  await page.getByRole("button", { name: "Thao tác khác" }).click();
  await page.locator(".theme-switch button", { hasText: "Tối" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Resize left and right panels and confirm CSS variables + localStorage update.
  const workspace = page.locator(".workspace");
  const initialLeft = await workspace.evaluate((el) => el.getAttribute("style") ?? "");
  const leftResizer = page.locator(".resizer").first();
  const leftBox = (await leftResizer.boundingBox())!;
  await page.mouse.move(leftBox.x + leftBox.width / 2, leftBox.y + leftBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(leftBox.x + 65, leftBox.y + leftBox.height / 2, { steps: 6 });
  await page.mouse.up();
  const afterLeft = await workspace.evaluate((el) => el.getAttribute("style") ?? "");
  expect(afterLeft).not.toBe(initialLeft);
  const storedLeft = await page.evaluate(() => Number(localStorage.getItem("fa.leftWidth")));
  expect(storedLeft).toBeGreaterThan(340);

  const rightResizer = page.locator(".resizer").nth(1);
  const rightBox = (await rightResizer.boundingBox())!;
  await page.mouse.move(rightBox.x + rightBox.width / 2, rightBox.y + rightBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rightBox.x - 55, rightBox.y + rightBox.height / 2, { steps: 6 });
  await page.mouse.up();
  const storedRight = await page.evaluate(() => Number(localStorage.getItem("fa.rightWidth")));
  expect(storedRight).toBeGreaterThan(360);

  // Server offline detection on ping failure (triggered on window focus).
  pingOffline = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".agent-pill.error")).toContainText("Mất kết nối server");
});

test("save, load, and delete family from library UI", async ({ page, request }) => {
  test.setTimeout(60_000);
  const uniqueName = `Library Flow ${Date.now()}`;
  let createdId: string | null = null;

  await page.route("**/api/design", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body:
        `data: ${JSON.stringify({ type: "job", jobId: "flows-lib" })}\n\n` +
        `data: ${JSON.stringify({
          type: "spec",
          spec: { ...fixtureSpec, name: uniqueName },
          stats: fakeStats,
          issues: [],
          errors: [],
          outcome: "ok",
        })}\n\n`,
    });
  });

  page.on("dialog", (dialog) => void dialog.accept());

  try {
    await page.goto("/");
    await page.locator("textarea").first().fill("Tạo family để test lưu/mở/xoá thư viện.");
    await page.getByTestId("chat-send").click();
    await expect(page.locator(".project-name")).toHaveText(uniqueName);

    // 1. Save from TopBar.
    const saveResponse = page.waitForResponse(
      (res) => res.url().includes("/api/models") && res.request().method() === "POST",
    );
    await page.locator("header.topbar button", { hasText: "Lưu" }).first().click();
    const savedJson = (await (await saveResponse).json()) as { id?: string };
    createdId = savedJson.id ?? null;
    expect(createdId).toBeTruthy();

    // 2. Confirm the framed plate fills the viewport (an off-center click hits it),
    //    zoom far out until that point misses, reload from Library, and confirm auto-fit frames it again.
    const canvas = page.locator(".viewer canvas").first();
    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.5;
    const offCenterX = box.x + box.width * 0.6;

    await page.waitForTimeout(450);
    await page.mouse.click(offCenterX, cy);
    await expect(page.locator(".viewer-selected-chip")).toContainText("Bottom Plate");
    await page.keyboard.press("Escape");
    await expect(page.locator(".viewer-selected-chip")).toHaveCount(0);

    await page.mouse.move(cx, cy);
    for (let i = 0; i < 60; i += 1) {
      await page.mouse.wheel(0, 300);
    }
    await page.waitForTimeout(350);
    await page.mouse.click(offCenterX, cy);
    await expect(page.locator(".viewer-selected-chip")).toHaveCount(0);

    await page.locator("header.topbar button", { hasText: "Thư viện" }).first().click();
    const card = page.locator(".saved-model-card", { hasText: uniqueName }).first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.locator(".project-name")).toHaveText(uniqueName);
    await page.waitForTimeout(400);

    await page.mouse.click(offCenterX, cy);
    await expect(page.locator(".viewer-selected-chip")).toContainText("Bottom Plate");

    // 3. Re-open Library and move the model to Trash.
    await page.locator("header.topbar button", { hasText: "Thư viện" }).first().click();
    const cardToDelete = page.locator(".saved-model-card", { hasText: uniqueName }).first();
    await expect(cardToDelete).toBeVisible();
    await cardToDelete.locator(".btn-delete-model").click();
    await expect(page.locator(".saved-model-card", { hasText: uniqueName })).toHaveCount(0);
  } finally {
    if (createdId) {
      await request.delete(`/api/models/${createdId}`).catch(() => {});
      await request.delete(`/api/trash/${createdId}`).catch(() => {});
    }
  }
});

test("Export RFA builds parametric RFA and opens folder when Revit bridge is connected, else falls back to 1-Click .bat with clear notice", async ({
  page,
}) => {
  test.setTimeout(60_000);
  let revitConnected = true;
  let buildHits = 0;
  let openFolderHits = 0;
  let portableHits = 0;

  await page.route("**/api/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        agent: { provider: "agy", model: "agy:gemini-4-hydrogen-low", ready: true, detail: "ok" },
        models: [{ id: "agy:gemini-4-hydrogen-low", label: "Hydrogen Low", via: "cli" }],
        backends: { commandcode: false, agy: true, codex: false, claude: false, openai: false },
        revit: { connected: revitConnected, autoStart: false, exe: null },
        bridge: "http://127.0.0.1:8765",
        outDir: "out",
        queueDir: "queue",
      }),
    });
  });

  await page.route("**/api/design", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body:
        `data: ${JSON.stringify({ type: "job", jobId: "flows-export" })}\n\n` +
        `data: ${JSON.stringify({
          type: "spec",
          spec: fixtureSpec,
          stats: fakeStats,
          issues: [],
          errors: [],
          outcome: "ok",
        })}\n\n`,
    });
  });

  await page.route("**/api/build", async (route) => {
    buildHits += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        mode: "revit",
        path: "C:\\temp\\studio-flows-fixture.rfa",
        revitVersion: "2024",
        warnings: [],
        stats: { driving: ["Tray Width"], locks: 2, totalForms: 1 },
      }),
    });
  });

  await page.route("**/api/download-rfa*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/octet-stream", body: "RFA" });
  });

  await page.route("**/api/open-folder", async (route) => {
    openFolderHits += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });

  await page.route("**/api/export-portable", async (route) => {
    portableHits += 1;
    await route.fulfill({ status: 200, contentType: "application/zip", body: "ZIP" });
  });

  await page.goto("/");
  await page.locator("textarea").first().fill("Tạo máng cáp mẫu để kiểm tra Xuất RFA.");
  await page.getByTestId("chat-send").click();
  await expect(page.locator(".project-name")).toHaveText("Studio Flows Fixture");

  // 1. Bridge ON -> clicks Xuất RFA triggers /api/build + /api/open-folder, not /api/export-portable
  const exportBtn = page.locator("header.topbar button", { hasText: "Xuất RFA" }).first();
  await expect(exportBtn).toHaveAttribute("title", /tham số thật/);
  await exportBtn.click();
  await expect.poll(() => buildHits).toBe(1);
  await expect.poll(() => openFolderHits).toBe(1);
  expect(portableHits).toBe(0);

  // 2. Bridge OFF -> clicks Xuất RFA falls back to 1-Click .bat and explains metadata difference
  revitConnected = false;
  await exportBtn.click();
  await expect.poll(() => portableHits).toBe(1);
  await expect(page.locator(".toast")).toContainText(".bat");
  await expect(page.locator(".toast")).toContainText("metadata");
});
