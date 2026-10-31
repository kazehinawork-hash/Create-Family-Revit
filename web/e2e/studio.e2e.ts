import { expect, test } from "@playwright/test";

test("the studio shell loads and the API is alive", async ({ page, request }) => {
  const ping = await request.get("/api/ping");
  expect(ping.ok()).toBeTruthy();
  expect((await ping.json()).ok).toBe(true);

  await page.goto("/");

  // The chat composer and the Three.js canvas are the two things a user needs
  // before any agent run can start.
  await expect(page.locator("textarea").first()).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
});

test("an empty brief is rejected by the API validation", async ({ request }) => {
  const response = await request.post("/api/design", { data: {} });
  expect(response.status()).toBe(400);
  expect((await response.json()).error).toBe("A prompt is required");
});
