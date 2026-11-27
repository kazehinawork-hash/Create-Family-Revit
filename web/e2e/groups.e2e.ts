import { expect, test } from "@playwright/test";

interface GroupSnapshot {
  groups: Array<{ name: string; count: number }>;
  ungrouped: number;
  total: number;
}

async function snapshot(
  request: import("@playwright/test").APIRequestContext,
): Promise<GroupSnapshot> {
  const response = await request.get("/api/library/groups");
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as GroupSnapshot;
}

async function openLibrary(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("button", { hasText: "Thư viện" }).first().click();
  await expect(page.locator(".library-modal")).toBeVisible();
}

test("a group can be renamed in place and the new name survives a reload", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const original = `Group ${Date.now()}`;
  const renamed = `${original} đổi tên`;

  const created = await request.post("/api/library/groups", { data: { name: original } });
  expect(created.ok()).toBeTruthy();

  let activeGroupName = original;
  try {
    await openLibrary(page);

    const row = page.locator(".library-group-row", { hasText: original }).first();
    await expect(row).toBeVisible();
    // The action is discoverable without hovering: visible, faint but present.
    const menuBtn = row.locator(".group-menu-btn");
    await expect(menuBtn).toBeVisible();
    expect(await menuBtn.evaluate((node) => Number(getComputedStyle(node).opacity))).toBeGreaterThan(
      0.2,
    );

    // The sidebar scrolls the row into view on the first click; double-click after that
    // so both clicks land on the same row (a real user sees the row before clicking).
    await row.locator(".library-filter").click();
    await row.locator(".library-filter").dblclick();
    const input = page.locator(`[data-testid="group-rename-input-${original}"]`);
    await expect(input).toBeVisible();
    await input.fill(renamed);
    await input.press("Enter");

    await expect(page.locator(".library-group-row", { hasText: renamed }).first()).toBeVisible();
    activeGroupName = renamed;
    expect((await snapshot(request)).groups.map((group) => group.name)).toContain(renamed);

    await page.reload();
    await page.locator("button", { hasText: "Thư viện" }).first().click();
    await expect(page.locator(".library-group-row", { hasText: renamed }).first()).toBeVisible();
  } finally {
    await request.delete(`/api/library/groups/${encodeURIComponent(activeGroupName)}`).catch(() => {});
  }
});

test("deleting a group moves its families back to Chưa nhóm", async ({ page, request }) => {
  test.setTimeout(90_000);
  const group = `Trash me ${Date.now()}`;
  const family = `${group} family`;

  expect((await request.post("/api/library/groups", { data: { name: group } })).ok()).toBeTruthy();
  const saved = await request.post("/api/models", {
    data: {
      name: family,
      spec: { name: family, category: "Generic Model", units: "mm", parameters: [], parts: [] },
      group,
    },
  });
  const { id } = (await saved.json()) as { id: string };

  try {
    await openLibrary(page);

    const row = page.locator(".library-group-row", { hasText: group }).first();
    await expect(row).toBeVisible();
    await row.locator(".group-menu-btn").click();

    // The menu must be usable even though the group list scrolls: it is a fixed layer.
    const menu = page.getByTestId("group-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Đổi tên nhóm");
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);

    await menu.getByRole("menuitem", { name: "Xoá nhóm" }).click();

    // The confirmation has to say the families move to Chưa nhóm instead of dying.
    const dialog = page.locator(".group-delete-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Chưa nhóm");
    await expect(dialog).toContainText("không bị xoá");

    await page.getByTestId("group-delete-confirm").click();
    await expect(page.locator(".library-group-row", { hasText: group })).toHaveCount(0);

    const body = await snapshot(request);
    expect(body.groups.map((entry) => entry.name)).not.toContain(group);

    const detail = (await (await request.get(`/api/models/${id}`)).json()) as {
      group?: string;
    };
    expect(detail.group ?? "").toBe("");
    await expect(page.locator(".saved-model-card", { hasText: family }).first()).toBeVisible();
  } finally {
    await request.delete(`/api/models/${id}`).catch(() => {});
    await request.delete(`/api/trash/${id}`).catch(() => {});
    await request.delete(`/api/library/groups/${encodeURIComponent(group)}`).catch(() => {});
  }
});

test("right-click opens the same menu, Escape and an outside click close it", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const group = `Right click ${Date.now()}`;
  expect((await request.post("/api/library/groups", { data: { name: group } })).ok()).toBeTruthy();

  try {
    await openLibrary(page);

    const row = page.locator(".library-group-row", { hasText: group }).first();
    await expect(row).toBeVisible();

    // System rows (Tất cả / Chưa nhóm / Thùng rác) offer no group menu: only the
    // named-group rows carry the ⋯ button.
    await expect(page.locator(".library-group-row .group-menu-btn")).toHaveCount(
      await page.locator(".library-group-row").count(),
    );

    await row.locator(".library-filter").click();
    await row.locator(".library-filter").click();
    await row.locator(".library-filter").click({ button: "right" });

    const menu = page.getByTestId("group-menu");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await row.locator(".group-menu-btn").click();
    await expect(menu).toBeVisible();
    await page.locator(".library-main").click({ position: { x: 10, y: 10 } });
    await expect(menu).toHaveCount(0);
  } finally {
    await request.delete(`/api/library/groups/${encodeURIComponent(group)}`);
  }
});

test("a duplicate group name is reported instead of silently merging", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const first = `Alpha ${Date.now()}`;
  const second = `Beta ${Date.now()}`;
  expect((await request.post("/api/library/groups", { data: { name: first } })).ok()).toBeTruthy();
  expect((await request.post("/api/library/groups", { data: { name: second } })).ok()).toBeTruthy();

  try {
    await openLibrary(page);
    const row = page.locator(".library-group-row", { hasText: second }).first();
    await row.locator(".library-filter").click();
    await row.locator(".library-filter").dblclick();
    const input = page.locator(`[data-testid="group-rename-input-${second}"]`);
    await expect(input).toBeVisible();
    await input.fill(first);
    await input.press("Enter");

    await expect(page.locator(".group-name-error")).toContainText(first);
    await input.press("Escape");

    expect((await snapshot(request)).groups.map((group) => group.name)).toEqual(
      expect.arrayContaining([first, second]),
    );
  } finally {
    for (const name of [first, second]) {
      await request.delete(`/api/library/groups/${encodeURIComponent(name)}`).catch(() => {});
    }
  }
});
