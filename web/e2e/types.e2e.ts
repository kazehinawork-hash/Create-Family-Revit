import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const saved = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "web", "e2e", "fixtures", "mitered-tee.json"),
    "utf8",
  ),
) as { id: string; name: string; spec: Record<string, unknown> };

async function loadMiteredTee(page: Page) {
  // The library is the only path that loads a saved spec; stub it with the mitered tee.
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        ok: true,
        models: [
          {
            id: "mitered",
            name: saved.name,
            category: (saved.spec as { category?: string }).category ?? "Electrical Equipment",
            savedAt: Date.now(),
            parts: 31,
            parameters: 34,
          },
        ],
      },
    }),
  );
  await page.route("**/api/models/mitered", (route) =>
    route.fulfill({ json: { id: "mitered", name: saved.name, spec: saved.spec, entries: [] } }),
  );

  await page.goto("/");
  await page.locator("button", { hasText: "Library" }).first().click();
  await page.locator(".saved-model-card").first().click();
  await page.getByTestId("tab-types").click();
  await expect(page.getByTestId("types-panel")).toBeVisible();
}

async function addColumn(page: Page, name: string) {
  await page.getByTestId("add-column").click();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByTestId(`sort-${name}`)).toBeVisible();
}

async function paste(page: Page, text: string) {
  await page.getByTestId("paste-toggle").click();
  await page.getByTestId("paste-input").fill(text);
  await page.getByTestId("paste-apply").click();
}

test("the table starts with only the type column and data columns are opt-in", async ({ page }) => {
  test.setTimeout(60_000);
  await loadMiteredTee(page);

  await expect(page.getByTestId("no-columns-hint")).toBeVisible();
  await expect(page.getByTestId("add-current")).toHaveCount(0);
  await expect(page.locator("thead th")).toHaveCount(2);
  await expect(page.getByTestId("sort-Ladder Width 1")).toHaveCount(0);

  await addColumn(page, "Ladder Width 1");
  await expect(page.locator("thead th")).toHaveCount(3);
  await expect(page.getByTestId("no-columns-hint")).toHaveCount(0);

  // One row keeps its values set; removing the last column leaves the row but no data.
  await paste(page, "400");
  await expect(page.getByLabel("Type 1 Ladder Width 1", { exact: true })).toHaveValue("400");
  await page.getByRole("button", { name: "Remove Ladder Width 1 column" }).click();
  await expect(page.getByTestId("no-columns-hint")).toBeVisible();
  await expect(page.getByTestId("type-row-0")).toBeVisible();
  await expect(page.locator("thead th")).toHaveCount(2);

  // With no columns the auto name falls back to "prefix N".
  await page.getByLabel("Type prefix").fill("Bracket");
  await expect(page.getByLabel("Type name 1", { exact: true })).toHaveValue("Bracket 1");
});

test("pasting without a column asks to pick one first", async ({ page }) => {
  test.setTimeout(60_000);
  await loadMiteredTee(page);

  await paste(page, "400x300x100");
  await expect(page.getByText(/Chưa có cột nào/)).toBeVisible();
  await expect(page.getByTestId("type-row-0")).toHaveCount(0);
});

test("auto names, keyboard rename, preview, duplicate, warnings and export", async ({ page }) => {
  test.setTimeout(120_000);

  let exportedTypes = 0;
  await page.route("**/api/export-multi-type", async (route) => {
    const body = route.request().postDataJSON() as { spec?: { types?: unknown[] } };
    exportedTypes = body?.spec?.types?.length ?? 0;
    await route.fulfill({ json: { ok: true, path: "C:\\stub\\mitered-tee.rfa", types: exportedTypes } });
  });

  await loadMiteredTee(page);
  for (const column of ["Ladder Width 1", "Ladder Width 2", "Ladder Height"]) {
    await addColumn(page, column);
  }

  await paste(page, "400x300x100");
  await expect(page.getByLabel("Type name 1", { exact: true })).toHaveValue("TP-CLT-MT 400x300x100");

  // An auto-generated name follows the values it claims.
  await page.getByLabel("Type 1 Ladder Width 2", { exact: true }).fill("350");
  await expect(page.getByLabel("Type name 1", { exact: true })).toHaveValue("TP-CLT-MT 400x350x100");

  await paste(page, "500x300x100");
  await paste(page, "600\t300\t100");
  await expect(page.getByTestId("type-row-2")).toBeVisible();
  await expect(page.getByLabel("Type name 3", { exact: true })).toHaveValue("TP-CLT-MT 600x300x100");

  // Typing a name key by key must keep focus.
  const nameInput = page.getByLabel("Type name 3", { exact: true });
  await nameInput.click();
  await nameInput.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("TP-CLT-MT 600 custom");
  await expect(nameInput).toHaveValue("TP-CLT-MT 600 custom");
  await expect(nameInput).toBeFocused();

  // A hand-written name is never overwritten by the values.
  await page.getByLabel("Type 3 Ladder Width 1", { exact: true }).fill("650");
  await expect(nameInput).toHaveValue("TP-CLT-MT 600 custom");

  for (const index of [0, 1, 2]) {
    const row = page.getByTestId(`type-row-${index}`);
    await row.getByRole("button", { name: /Preview/ }).click();
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(row).toHaveClass(/previewing/);
  }

  // Duplicate a row: values copied, name suffixed.
  await page.getByRole("button", { name: /Duplicate/ }).first().click();
  await expect(page.getByTestId("type-row-3")).toBeVisible();
  await expect(page.getByLabel("Type name 2", { exact: true })).toHaveValue(
    "TP-CLT-MT 400x350x100 copy",
  );

  // Warnings are informational: W2 > W1 flags the row but the export still runs.
  await page.getByLabel("Type 1 Ladder Width 2", { exact: true }).fill("999");
  await expect(page.getByTestId("types-warnings")).toContainText("Ladder Width 2");
  await expect(page.getByTestId("export-types")).toBeEnabled();
  await page.getByLabel("Type 1 Ladder Width 2", { exact: true }).fill("350");

  // Validation: a zero width blocks the export.
  await page.getByLabel("Type 2 Ladder Width 2", { exact: true }).fill("0");
  await expect(page.getByTestId("types-problems")).toBeVisible();
  await expect(page.getByTestId("export-types")).toBeDisabled();
  await page.getByLabel("Type 2 Ladder Width 2", { exact: true }).fill("300");
  await expect(page.getByTestId("export-types")).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByTestId("export-types").click(),
  ]);

  expect(exportedTypes).toBe(4);
  expect(download.url()).toContain("/api/download-rfa?path=");
  expect(download.suggestedFilename()).toMatch(/\.rfa$/i);
});

test("importing a CSV creates the columns it matches", async ({ page }) => {
  test.setTimeout(90_000);
  await loadMiteredTee(page);
  await expect(page.getByTestId("no-columns-hint")).toBeVisible();

  const rows = [
    "Type Name,Ladder Width 1,Ladder Width 2,Ladder Height",
    "S1,100,100,100",
    "S2,100,200,100",
    "S3,200,200,100",
    "S4,200,300,100",
    "S5,300,300,100",
    "S6,300,400,100",
    "S7,400,400,100",
    "S8,400,500,100",
    "S9,500,500,100",
    "S10,500,600,100",
    "S11,600,600,100",
    "S12,600,abc,100",
  ].join("\n");

  const csvPath = test.info().outputPath("types.csv");
  fs.writeFileSync(csvPath, rows, "utf8");

  await page.getByTestId("import-input").setInputFiles(csvPath);
  await expect(page.getByTestId("import-preview")).toBeVisible();
  await expect(page.getByTestId("import-summary")).toHaveText("11 dòng hợp lệ · 1 lỗi");
  await expect(page.getByTestId("import-issue").first()).toContainText("Dòng 13");

  await page.getByTestId("import-add").click();
  await expect(page.getByTestId("type-row-10")).toBeVisible();
  await expect(page.getByTestId("type-row-11")).toHaveCount(0);
  await expect(page.getByLabel("Type name 1", { exact: true })).toHaveValue("S1");

  // The imported headers turned into columns without pressing "+ Cột".
  await expect(page.getByTestId("sort-Ladder Width 1")).toBeVisible();
  await expect(page.getByTestId("sort-Ladder Height")).toBeVisible();
  await expect(page.getByTestId("no-columns-hint")).toHaveCount(0);
});

test("combinations, filter, sort, bulk delete and the CSV template", async ({ page }) => {
  test.setTimeout(90_000);
  await loadMiteredTee(page);
  for (const column of ["Ladder Width 1", "Ladder Width 2"]) {
    await addColumn(page, column);
  }

  await page.getByTestId("combo-toggle").click();
  await page.getByLabel("Combo Ladder Width 1").fill("200,300,400,600");
  await page.getByLabel("Combo Ladder Width 2").fill("200,300,400,600");
  await expect(page.getByTestId("combo-count")).toHaveText("Sẽ tạo 10 type");
  await page.getByTestId("combo-apply").click();
  await expect(page.getByTestId("type-row-9")).toBeVisible();
  await expect(page.getByTestId("type-row-10")).toHaveCount(0);

  await page.getByTestId("types-filter").fill("400x");
  const filtered = await page.locator("tbody tr").count();
  expect(filtered).toBeLessThan(10);
  await expect(page.getByTestId("type-row-9")).toHaveCount(0);
  await page.getByTestId("types-filter").fill("");

  await page.getByTestId("sort-Ladder Width 2").click();
  const firstValue = await page.locator("tbody tr").first().getByLabel(/Ladder Width 2$/).inputValue();
  const lastValue = await page.locator("tbody tr").last().getByLabel(/Ladder Width 2$/).inputValue();
  expect(Number(firstValue)).toBeLessThanOrEqual(Number(lastValue));

  // force: the checkbox sits in a listbar that Playwright never sees as stable.
  await page.getByTestId("select-all").check({ force: true });
  await expect(page.getByTestId("delete-selected")).toContainText("(10)");
  await page.getByTestId("delete-selected").click();
  await expect(page.getByTestId("type-row-0")).toHaveCount(0);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    page.getByTestId("download-template").click(),
  ]);
  expect(download.suggestedFilename()).toBe("types-template.csv");
});

test("pasting a row with fewer values than columns is rejected", async ({ page }) => {
  test.setTimeout(60_000);
  await loadMiteredTee(page);
  await addColumn(page, "Ladder Width 1");
  await addColumn(page, "Ladder Width 2");
  await addColumn(page, "Ladder Height");

  await paste(page, "400x300");
  await expect(page.getByText(/Thiếu giá trị/)).toBeVisible();
  await expect(page.getByTestId("type-row-0")).toHaveCount(0);
});
