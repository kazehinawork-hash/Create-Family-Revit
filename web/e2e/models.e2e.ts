import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const saved = JSON.parse(
  fs.readFileSync(
    path.join(
      process.cwd(),
      "saved-models",
      "1794390236816-thinh-phat-cable-ladder-mitered-tee.json",
    ),
    "utf8",
  ),
) as { name: string; spec: Record<string, unknown> };

test("a saved model can be renamed from the library and survives a reload", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);

  const original = `Rename test ${Date.now()}`;
  const renamed = `${original} renamed`;

  const created = await request.post("/api/models", {
    data: { name: original, spec: { ...saved.spec, name: original } },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };

  try {
    await page.goto("/");
    await page.locator("button", { hasText: "Library" }).first().click();

    const card = page.locator(".saved-model-card", { hasText: original }).first();
    await expect(card).toBeVisible();

    await card.getByTestId(`rename-${id}`).click();
    const input = page.getByTestId(`rename-input-${id}`);
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(original);

    await input.fill(renamed);
    await input.press("Enter");

    await expect(
      page.locator(".saved-model-card", { hasText: renamed }).first(),
    ).toBeVisible();

    const models = (await (await request.get("/api/models")).json()) as {
      models: Array<{ id: string; name: string }>;
    };
    expect(models.models.find((model) => model.id === id)?.name).toBe(renamed);

    // Reopening the library must show the stored name, not a cached one.
    await page.reload();
    await page.locator("button", { hasText: "Library" }).first().click();
    await expect(
      page.locator(".saved-model-card", { hasText: renamed }).first(),
    ).toBeVisible();
  } finally {
    await request.delete(`/api/models/${id}`);
  }
});
