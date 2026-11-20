import { expect, test } from "@playwright/test";

const baseSpec = {
  schemaVersion: "1.0",
  name: "Notes e2e",
  category: "Mechanical Equipment",
  units: "mm",
  parameters: [
    { name: "Length", type: "Length", value: 1200 },
    { name: "Width", type: "Length", value: 800 },
    { name: "Height", type: "Length", value: 300 },
  ],
  parts: [
    {
      id: "plate",
      name: "Steel Plate",
      material: "Steel",
      solid: {
        kind: "box",
        origin: { x: 0, y: 0, z: 0 },
        size: { x: "[Length]", y: "[Width]", z: 20 },
      },
    },
  ],
  materials: [{ name: "Steel", color: "#9aa3a8", metalness: 0.6, roughness: 0.4 }],
};

const stats = {
  parts: 1,
  parameters: 3,
  instances: 1,
  materials: 1,
  bounds: { x: 1200, y: 800, z: 20 },
  attempts: 1,
  elapsedMs: 1200,
  model: "e2e/fake",
  modelCalls: 1,
  calls: [{ model: "e2e/fake", modelCalls: 1, inChars: 1200, outChars: 600 }],
  complete: true,
  warnings: [],
};

test("pins a note, sends it to the agent and marks it resolved", async ({ page }) => {
  test.setTimeout(60_000);
  const dark = process.env.DARK === "1";
  await page.addInitScript((isDark) => {
    try {
      localStorage.setItem("family.theme.v1", isDark ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }, dark);
  let calls = 0;
  let notePayload: Record<string, unknown> | null = null;

  await page.route("**/api/design", async (route) => {
    calls += 1;
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    if (calls > 1) notePayload = payload;
    const spec =
      calls > 1
        ? {
            ...baseSpec,
            parts: [
              {
                ...baseSpec.parts[0],
                solid: { ...baseSpec.parts[0].solid, size: { x: "[Length]", y: "[Width]", z: 12 } },
              },
            ],
            notes: ["Đã sửa Steel Plate theo ghi chú trên mô hình."],
          }
        : baseSpec;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body:
        `data: ${JSON.stringify({ type: "job", jobId: "notes-e2e" })}\n\n` +
        `data: ${JSON.stringify({
          type: "spec",
          spec,
          stats,
          issues: [],
          errors: [],
          outcome: "ok",
        })}\n\n`,
    });
  });

  await page.goto("/");
  const composer = page.locator("textarea").first();
  await composer.fill("Dựng một tấm thép.");
  await page.getByTestId("chat-send").click();
  await expect(page.locator(".viewer canvas").first()).toBeVisible();
  await expect(page.locator('[data-testid="chat-changes"]')).toHaveCount(1);
  await page.waitForTimeout(900);

  const canvas = page.locator(".viewer canvas").first();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const points = [
    [box!.width / 2, box!.height / 2],
    [box!.width * 0.45, box!.height * 0.45],
    [box!.width * 0.55, box!.height * 0.55],
    [box!.width * 0.5, box!.height * 0.4],
    [box!.width * 0.62, box!.height / 2],
    [box!.width * 0.38, box!.height / 2],
  ];
  let menuOpen = false;
  for (const [x, y] of points) {
    await canvas.click({ button: "right", position: { x, y } });
    menuOpen = await page
      .locator(".viewer-context-menu")
      .isVisible()
      .catch(() => false);
    if (menuOpen) break;
    await page.waitForTimeout(100);
  }
  expect(menuOpen).toBeTruthy();

  await page.getByRole("button", { name: "Ghi chú tại đây" }).click();
  const noteInput = page.locator(".viewer-note-composer textarea");
  await noteInput.fill("Vát cạnh trên 45°.");
  await page.getByRole("button", { name: "Lưu ghi chú" }).click();

  await expect(page.locator(".viewer-note-pin")).toHaveCount(1);
  await expect(page.locator(".viewer-note-pin")).toBeVisible();
  await page.getByTestId("tab-notes").click();
  await expect(page.locator('[data-testid="notes-panel"]')).toContainText("Vát cạnh trên 45°.");

  let savedAnnotations: Array<{ text?: string }> | undefined;
  await page.route("**/api/models", async (route) => {
    const payload = route.request().postDataJSON() as {
      annotations?: Array<{ text?: string }>;
    };
    savedAnnotations = payload.annotations;
    await route.fulfill({ json: { ok: true, id: "notes-e2e" } });
  });
  await page.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect.poll(() => savedAnnotations?.[0]?.text).toBe("Vát cạnh trên 45°.");

  await page.screenshot({
    path: dark ? "test-results/notes-panel-dark.png" : "test-results/notes-panel.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Gửi cho Agent" }).click();
  await expect(page.locator('[data-testid="chat-changes"]')).toHaveCount(2);
  expect((notePayload?.targets as Array<{ partId: string; note?: string }>)[0]).toMatchObject({
    partId: "plate",
    note: "Vát cạnh trên 45°.",
  });
  await expect(page.locator(".note-card.resolved")).toHaveCount(1);
  await page.screenshot({
    path: dark ? "test-results/notes-resolved-dark.png" : "test-results/notes-resolved.png",
    fullPage: true,
  });
});
