import { expect, test } from "@playwright/test";

const makeSpec = (railThickness: number) => ({
  schemaVersion: "1.0",
  name: "Target e2e",
  category: "Mechanical Equipment",
  units: "mm",
  parameters: [
    { name: "Length", type: "Length", value: 1200 },
    { name: "Width", type: "Length", value: 800 },
    { name: "Height", type: "Length", value: 300 },
  ],
  parts: [
    {
      id: "rail",
      name: "Side Rail",
      material: "Steel",
      solid: {
        kind: "box",
        origin: { x: 0, y: 0, z: 0 },
        size: { x: "[Length]", y: "[Width]", z: railThickness },
      },
    },
  ],
  materials: [{ name: "Steel", color: "#9aa3a8", metalness: 0.6, roughness: 0.4 }],
});

const spec = makeSpec(20);
const updatedSpec = {
  ...spec,
  parts: [
    {
      ...spec.parts[0],
      solid: { ...spec.parts[0].solid, size: { x: "[Length]", y: "[Width]", z: 8 } },
    },
  ],
  notes: ["Đã vát cạnh Side Rail.", "Giả định: Rail Thickness = 8 mm (theo yêu cầu trên mô hình)."],
};

const stats = (parts: number) => ({
  parts,
  parameters: 3,
  instances: parts,
  materials: 1,
  bounds: { x: 1200, y: 800, z: 20 },
  attempts: 1,
  elapsedMs: 1200,
  model: "e2e/fake",
  modelCalls: 1,
  calls: [{ model: "e2e/fake", modelCalls: 1, inChars: 1200, outChars: 600 }],
  complete: true,
  warnings: [],
});

test("right-click sends a part target and the agent edits that part", async ({ page }) => {
  test.setTimeout(60_000);

  let calls = 0;
  let secondPayload: Record<string, unknown> | null = null;

  await page.route("**/api/design", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    calls += 1;
    const current = calls === 1 ? spec : updatedSpec;
    if (calls > 1) secondPayload = payload;
    const event = {
      type: "spec",
      spec: current,
      stats: stats(current.parts.length),
      issues: [],
      errors: [],
      outcome: "ok",
    };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body:
        `data: ${JSON.stringify({ type: "job", jobId: "target-e2e" })}\n\n` +
        `data: ${JSON.stringify(event)}\n\n`,
    });
  });

  await page.goto("/");
  const composer = page.locator("textarea").first();
  await composer.fill("Dựng một tấm thép để thử chọn part.");
  await page.getByTestId("chat-send").click();
  await expect(page.locator('[data-testid="chat-changes"]')).toHaveCount(1);
  await expect(page.locator(".viewer canvas").first()).toBeVisible();
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
  for (const [x, y] of points) {
    await canvas.click({ button: "right", position: { x, y } });
    if (
      await page
        .locator(".viewer-context-menu")
        .isVisible()
        .catch(() => false)
    )
      break;
    await page.waitForTimeout(100);
  }

  await expect(page.getByRole("button", { name: "Gửi vào chat" })).toBeVisible();
  await page.getByRole("button", { name: "Gửi vào chat" }).click();
  await expect(page.getByTestId("composer-targets")).toContainText("Side Rail");
  await page.screenshot({ path: "test-results/target-composer.png", fullPage: true });

  await composer.fill("Vát cạnh part Side Rail theo ghi chú.");
  await page.getByTestId("chat-send").click();

  await expect(page.locator('[data-testid="chat-changes"]')).toHaveCount(2);
  await expect(page.locator(".msg-user-target").last()).toContainText("Side Rail");
  expect(secondPayload?.targets).toEqual(
    expect.arrayContaining([expect.objectContaining({ partId: "rail" })]),
  );
  await expect(page.locator('[data-testid="chat-changes"]').last()).toContainText("Side Rail");
  await page.screenshot({ path: "test-results/target-result.png", fullPage: true });
});
