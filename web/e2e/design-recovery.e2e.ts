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
) as { spec: Record<string, unknown> };

async function sendBrief(page: import("@playwright/test").Page, text: string) {
  await page.goto("/");
  const composer = page.locator("textarea").first();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("a dropped design stream is recovered from the job", async ({ page }) => {
  test.setTimeout(60_000);

  const recovered = { ...saved.spec, name: "Recovered from job" };
  let polls = 0;

  // The stream announces the job and closes without a spec — the failure the user hit.
  await page.route("**/api/design", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body:
        'data: {"type":"job","jobId":"djs_e2e"}\n\n' +
        'data: {"type":"stage","stage":"working","message":"Writing the spec"}\n\n',
    }),
  );

  await page.route("**/api/design/jobs/djs_e2e", (route) => {
    polls += 1;
    if (polls < 2) {
      return route.fulfill({ json: { ok: true, job: { job_id: "djs_e2e", status: "running", spec: null } } });
    }
    return route.fulfill({
      json: {
        ok: true,
        job: {
          job_id: "djs_e2e",
          status: "done",
          spec: recovered,
          issues: [],
          errors: [],
          warnings: [],
          stats: { parameters: 34, parts: 31, instances: 31, materials: 3, bounds: null, attempts: 1, elapsedMs: 42 },
        },
      },
    });
  });

  await sendBrief(page, "Tạo cable ladder mitered tee có 3 connector");

  // The web says it is reconnecting instead of asking the user to send again.
  await expect(page.getByText(/Mất kết nối, đang lấy lại kết quả/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Đã lấy lại kết quả sau khi mất kết nối/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("tab-types")).toBeVisible();
  expect(polls).toBeGreaterThanOrEqual(2);
});

test("a job lost with the server restart offers a retry button", async ({ page }) => {
  test.setTimeout(60_000);

  await page.route("**/api/design", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: 'data: {"type":"job","jobId":"djs_gone"}\n\n',
    }),
  );
  await page.route("**/api/design/jobs/djs_gone", (route) =>
    route.fulfill({ status: 404, json: { ok: false, error: "Không tìm thấy job thiết kế" } }),
  );

  await sendBrief(page, "Tạo một family rất dài với nhiều connector và bảng màu");

  await expect(page.getByText(/Server đã restart và không còn job này/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("chat-retry")).toBeVisible();
});
