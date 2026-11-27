import { expect, test, type Locator, type Page } from "@playwright/test";

const viewerFixtureSpec = {
  schemaVersion: "1.0",
  name: "Viewer Verification Block",
  category: "Mechanical Equipment",
  units: "mm",
  parameters: [
    { name: "Wing Width", type: "Length", value: 420 },
    { name: "Wing Depth", type: "Length", value: 500 },
    { name: "Wing Height", type: "Length", value: 360 },
  ],
  parts: [
    {
      id: "left-wing",
      name: "Left Wing",
      material: "Steel",
      solid: {
        kind: "box",
        origin: { x: -350, y: 0, z: 0 },
        size: { x: "[Wing Width]", y: "[Wing Depth]", z: "[Wing Height]" },
      },
    },
    {
      id: "right-wing",
      name: "Right Wing",
      material: "Copper",
      solid: {
        kind: "box",
        origin: { x: 350, y: 0, z: 0 },
        size: { x: "[Wing Width]", y: "[Wing Depth]", z: "[Wing Height]" },
      },
    },
  ],
  materials: [
    { name: "Steel", color: "#8fa1b3", metalness: 0.5, roughness: 0.4 },
    { name: "Copper", color: "#c27a4d", metalness: 0.6, roughness: 0.35 },
  ],
};

const fakeStats = {
  parts: 2,
  parameters: 3,
  instances: 2,
  materials: 2,
  bounds: { x: 1120, y: 500, z: 360 },
  attempts: 1,
  elapsedMs: 400,
  model: "e2e/viewer-fake",
  modelCalls: 1,
  calls: [{ model: "e2e/viewer-fake", modelCalls: 1, inChars: 900, outChars: 500 }],
  complete: true,
  warnings: [],
};

async function loadFixtureIntoViewer(page: Page) {
  await page.route("**/api/design", async (route) => {
    const event = {
      type: "spec",
      spec: viewerFixtureSpec,
      stats: fakeStats,
      issues: [],
      errors: [],
      outcome: "ok",
    };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body:
        `data: ${JSON.stringify({ type: "job", jobId: "viewer-e2e" })}\n\n` +
        `data: ${JSON.stringify(event)}\n\n`,
    });
  });

  await page.goto("/");
  const composer = page.locator("textarea").first();
  await composer.fill("Load fixed viewer fixture.");
  await page.getByTestId("chat-send").click();
  await expect(page.locator('[data-testid="chat-changes"]')).toHaveCount(1);
  await expect(page.locator(".viewer canvas").first()).toBeVisible();
  await expect(page.locator(".viewer-caption")).toContainText("2 chi tiết");
  // Wait for incremental assembly animation & worker geometry build to settle.
  await page.waitForTimeout(1200);
}

async function scanCanvasForHover(
  page: Page,
  canvas: Locator,
  targetName: string,
): Promise<{ clientX: number; clientY: number; relX: number; relY: number }> {
  const box = (await canvas.boundingBox())!;
  const xs = [0.22, 0.3, 0.38, 0.45, 0.55, 0.62, 0.7, 0.78];
  const ys = [0.42, 0.5, 0.58, 0.34, 0.66];
  const tip = page.locator(".viewer-hover-tip");

  for (const fy of ys) {
    for (const fx of xs) {
      const relX = box.width * fx;
      const relY = box.height * fy;
      const clientX = box.x + relX;
      const clientY = box.y + relY;
      await page.mouse.move(clientX, clientY);
      await page.waitForTimeout(45);
      if (await tip.isVisible().catch(() => false)) {
        const text = (await tip.textContent()) ?? "";
        if (text.includes(targetName)) {
          return { clientX, clientY, relX, relY };
        }
      }
    }
  }
  throw new Error(`Could not find hovered part "${targetName}" on viewer canvas`);
}

async function findEmptyCanvasPoint(
  page: Page,
  canvas: Locator,
): Promise<{ clientX: number; clientY: number }> {
  const box = (await canvas.boundingBox())!;
  const candidates = [
    [0.06, 0.88],
    [0.94, 0.88],
    [0.06, 0.14],
    [0.94, 0.14],
  ];
  const tip = page.locator(".viewer-hover-tip");
  for (const [fx, fy] of candidates) {
    const clientX = box.x + box.width * fx;
    const clientY = box.y + box.height * fy;
    await page.mouse.move(clientX, clientY);
    await page.waitForTimeout(50);
    if (!(await tip.isVisible().catch(() => false))) {
      return { clientX, clientY };
    }
  }
  return { clientX: box.x + 12, clientY: box.y + box.height - 16 };
}

test("viewer interactions: hover, multi-angle & sectioned picking, deselect, context menu, measure, section drag, export PNG", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await loadFixtureIntoViewer(page);

  const canvas = page.locator(".viewer canvas").first();
  const box = (await canvas.boundingBox())!;

  // 1. Hover reveals part names accurately.
  const leftHit = await scanCanvasForHover(page, canvas, "Left Wing");
  await expect(page.locator(".viewer-hover-tip")).toContainText("Left Wing");
  const rightHit = await scanCanvasForHover(page, canvas, "Right Wing");
  await expect(page.locator(".viewer-hover-tip")).toContainText("Right Wing");

  // 2. Left-click selects each part in turn, and clicking empty space deselects.
  await page.mouse.click(leftHit.clientX, leftHit.clientY);
  await expect(page.locator(".viewer-selected-chip")).toContainText("Left Wing");

  await page.mouse.click(rightHit.clientX, rightHit.clientY);
  await expect(page.locator(".viewer-selected-chip")).toContainText("Right Wing");

  const emptyPt = await findEmptyCanvasPoint(page, canvas);
  await page.mouse.click(emptyPt.clientX, emptyPt.clientY);
  await expect(page.locator(".viewer-selected-chip")).toHaveCount(0);

  // 3. Rotate camera via orbit drag to a new angle and verify picking still tracks the right parts.
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.28, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);

  const orbitedRight = await scanCanvasForHover(page, canvas, "Right Wing");
  await page.mouse.click(orbitedRight.clientX, orbitedRight.clientY);
  await expect(page.locator(".viewer-selected-chip")).toContainText("Right Wing");

  const orbitedLeft = await scanCanvasForHover(page, canvas, "Left Wing");
  await page.mouse.click(orbitedLeft.clientX, orbitedLeft.clientY);
  await expect(page.locator(".viewer-selected-chip")).toContainText("Left Wing");

  // 4. Right-click opens the context menu on the clicked part.
  await page.mouse.click(orbitedRight.clientX, orbitedRight.clientY, { button: "right" });
  const menu = page.locator(".viewer-context-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Right Wing");
  await expect(menu.getByRole("button", { name: "Gửi vào chat" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Ghi chú tại đây" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".viewer-selected-chip")).toHaveCount(0);

  // 5. Measure two points on the model and clear.
  await page.locator('.viewer-tools button[title="Đo"]').click();
  await expect(page.locator(".measure-badge")).toContainText("Bấm điểm thứ nhất");
  await page.mouse.click(orbitedLeft.clientX, orbitedLeft.clientY);
  await expect(page.locator(".measure-badge")).toContainText("Điểm 1");
  await page.mouse.click(orbitedRight.clientX, orbitedRight.clientY);
  await expect(page.locator(".measure-badge")).toContainText(/\d[\d.,]*\s*mm/);
  await page.locator('.viewer-tools button[title="Đo"]').click();

  // 6. Reset view cleanly, enable X section at 0 mm (clips Right Wing > 0), pick unclipped Left Wing,
  // verify clipped Right Wing cannot be picked, and drag the 3D section handle.
  await page.locator('.viewer-tools button[title="Vừa khung"]').click();
  await page.waitForTimeout(200);
  const isoLeft = await scanCanvasForHover(page, canvas, "Left Wing");
  const isoRight = await scanCanvasForHover(page, canvas, "Right Wing");

  await page.locator('.viewer-tools button[title="Mặt cắt"]').click();
  const sectionCard = page.locator(".section-card");
  await expect(sectionCard).toBeVisible();

  const sectionInput = sectionCard.locator('input[type="number"]');
  await sectionInput.fill("0");
  await sectionInput.dispatchEvent("change");
  await page.waitForTimeout(150);

  // Unclipped wing picks cleanly while section is active; clipped wing stays unpickable.
  await page.mouse.click(isoLeft.clientX, isoLeft.clientY);
  await expect(page.locator(".viewer-selected-chip")).toContainText("Left Wing");
  await page.mouse.click(isoRight.clientX, isoRight.clientY);
  await expect(page.locator(".viewer-selected-chip")).toHaveCount(0);

  // Locate the 3D section handle via `grab` cursor and drag it to update section position.
  let handlePt: { clientX: number; clientY: number } | null = null;
  for (const fy of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65]) {
    for (const fx of [0.5, 0.46, 0.54, 0.42, 0.58, 0.38, 0.62]) {
      const clientX = box.x + box.width * fx;
      const clientY = box.y + box.height * fy;
      await page.mouse.move(clientX, clientY);
      const cursor = await canvas.evaluate((el) => (el as HTMLElement).style.cursor);
      if (cursor === "grab") {
        handlePt = { clientX, clientY };
        break;
      }
    }
    if (handlePt) break;
  }
  expect(handlePt).not.toBeNull();
  const valueBeforeDrag = Number(await sectionInput.inputValue());
  await page.mouse.move(handlePt!.clientX, handlePt!.clientY);
  await page.mouse.down();
  await page.mouse.move(handlePt!.clientX + 80, handlePt!.clientY - 20, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const valueAfterDrag = Number(await sectionInput.inputValue());
  expect(valueAfterDrag).not.toBe(valueBeforeDrag);

  await page.locator('button[aria-label="Đóng mặt cắt"]').click();
  await expect(sectionCard).toHaveCount(0);

  // 7. Export PNG triggers download with .png extension.
  const downloadPromise = page.waitForEvent("download");
  await page.locator('.viewer-tools button[title="Lưu ảnh PNG"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename().toLowerCase()).toMatch(/\.png$/);
});

test("viewer shaders compile without WebGL shader errors across light, dark, and section clipping", async ({
  page,
}) => {
  const shaderErrors: string[] = [];
  const SHADER_ERROR_RE = /Shader Error|VALIDATE_STATUS|redefinition|THREE\.WebGLProgram/i;
  page.on("console", (msg) => {
    const text = msg.text();
    if (SHADER_ERROR_RE.test(text)) shaderErrors.push(`[console.${msg.type()}] ${text}`);
  });
  page.on("pageerror", (err) => {
    shaderErrors.push(`[pageerror] ${err.message}`);
  });

  await loadFixtureIntoViewer(page);

  // Exercise section clipping shader path (NUM_CLIPPING_PLANES > 0) while model & silhouette render.
  await page.locator('.viewer-tools button[title="Mặt cắt"]').click();
  const sectionCard = page.locator(".section-card");
  await expect(sectionCard).toBeVisible();
  const sectionInput = sectionCard.locator('input[type="number"]');
  await sectionInput.fill("0");
  await sectionInput.dispatchEvent("change");
  await page.waitForTimeout(250);
  await page.locator('button[aria-label="Đóng mặt cắt"]').click();

  // Switch to dark theme and back to light theme so both silhouette palettes render cleanly.
  await page.getByRole("button", { name: "Thao tác khác" }).click();
  await page.locator(".theme-switch button", { hasText: "Tối" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.waitForTimeout(250);

  await page.locator(".theme-switch button", { hasText: "Sáng" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.waitForTimeout(250);

  expect(shaderErrors).toEqual([]);
});

test("display mode switcher and silhouettes toggle persist across reload while PNG export works in any mode", async ({
  page,
}) => {
  const shaderErrors: string[] = [];
  const SHADER_ERROR_RE = /Shader Error|VALIDATE_STATUS|redefinition|THREE\.WebGLProgram/i;
  page.on("console", (msg) => {
    const text = msg.text();
    if (SHADER_ERROR_RE.test(text)) shaderErrors.push(`[console.${msg.type()}] ${text}`);
  });
  page.on("pageerror", (err) => {
    shaderErrors.push(`[pageerror] ${err.message}`);
  });

  await loadFixtureIntoViewer(page);

  const modeBtn = page.getByTestId("viewer-display-mode-btn");
  const silhouettesBtn = page.getByTestId("viewer-silhouettes-btn");
  await expect(modeBtn).toContainText("Tô bóng + cạnh");
  await expect(silhouettesBtn).toHaveAttribute("aria-pressed", "true");

  // Cycle through Shaded -> Hidden Line -> Wireframe and turn Silhouettes OFF.
  await modeBtn.click();
  await page.getByTestId("viewer-display-option-shaded").click();
  await expect(modeBtn).toContainText("Tô bóng");

  await modeBtn.click();
  await page.getByTestId("viewer-display-option-hiddenLine").click();
  await expect(modeBtn).toContainText("Nét ẩn");

  await modeBtn.click();
  await page.getByTestId("viewer-display-option-wireframe").click();
  await expect(modeBtn).toContainText("Khung dây");

  await silhouettesBtn.click();
  await expect(silhouettesBtn).toHaveAttribute("aria-pressed", "false");

  // Export PNG while wireframe + silhouettes OFF are active; must export cleanly & restore state.
  const downloadPromise = page.waitForEvent("download");
  await page.locator('.viewer-tools button[title="Lưu ảnh PNG"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename().toLowerCase()).toMatch(/\.png$/);
  await expect(modeBtn).toContainText("Khung dây");

  // Reload and verify display mode + silhouettes preference survive.
  await page.reload();
  await expect(page.getByTestId("viewer-display-mode-btn")).toContainText("Khung dây");
  await expect(page.getByTestId("viewer-silhouettes-btn")).toHaveAttribute("aria-pressed", "false");

  expect(shaderErrors).toEqual([]);
});

test("CSG-cut and arrayed parts render outer edges cleanly across Wireframe, Hidden Line, themes, and section clipping", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const shaderErrors: string[] = [];
  const SHADER_ERROR_RE = /Shader Error|VALIDATE_STATUS|redefinition|THREE\.WebGLProgram/i;
  page.on("console", (msg) => {
    const text = msg.text();
    if (SHADER_ERROR_RE.test(text)) shaderErrors.push(`[console.${msg.type()}] ${text}`);
  });
  page.on("pageerror", (err) => {
    shaderErrors.push(`[pageerror] ${err.message}`);
  });

  const csgSpec = {
    schemaVersion: "1.0",
    name: "CSG Wireframe Check",
    category: "Generic Model",
    units: "mm",
    parameters: [],
    parts: [
      {
        id: "csg-plate",
        name: "CSG Plate",
        material: "Aluminum",
        solid: {
          kind: "box",
          origin: { x: -250, y: -150, z: 0 },
          size: { x: 500, y: 300, z: 260 },
          cornerRadius: 20,
        },
        cuts: [
          {
            kind: "cylinder",
            axis: "y",
            base: { x: 0, y: -160, z: 130 },
            radius: 45,
            height: 320,
          },
        ],
      },
      {
        id: "pin-array",
        name: "Pin Array",
        material: "Steel",
        solid: {
          kind: "cylinder",
          axis: "z",
          base: { x: -300, y: 0, z: 20 },
          radius: 40,
          height: 220,
        },
        array: { count: 2, axis: "x", spacing: 600 },
      },
    ],
    materials: [
      { name: "Aluminum", color: "#b0b7be", metalness: 0.4, roughness: 0.45 },
      { name: "Steel", color: "#6c7680", metalness: 0.5, roughness: 0.4 },
    ],
  };

  await page.route("**/api/design", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body:
        `data: ${JSON.stringify({ type: "job", jobId: "csg-wf" })}\n\n` +
        `data: ${JSON.stringify({
          type: "spec",
          spec: csgSpec,
          stats: { ...fakeStats, parts: 2, instances: 3, bounds: { x: 640, y: 300, z: 260 } },
          issues: [],
          errors: [],
          outcome: "ok",
        })}\n\n`,
    });
  });

  await page.goto("/");
  await page.locator("textarea").first().fill("Load CSG wireframe fixture.");
  await page.getByTestId("chat-send").click();
  await expect(page.locator(".viewer-caption")).toContainText("2 chi tiết");
  await page.waitForTimeout(1500);
  await page.locator('.viewer-tools button[title="Vừa khung"]').click();
  await page.waitForTimeout(300);

  const countDarkInkPixelsInRegion = async (
    canvasPng: Buffer,
    region: { x0: number; y0: number; x1: number; y1: number },
    darkMode: boolean,
  ) => {
    const b64 = canvasPng.toString("base64");
    return page.evaluate(
      async ({ dataUrl, r, dark }) => {
        const img = new Image();
        img.src = dataUrl;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });
        const off = document.createElement("canvas");
        off.width = img.width;
        off.height = img.height;
        const ctx = off.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const sx = Math.floor(img.width * r.x0);
        const sy = Math.floor(img.height * r.y0);
        const sw = Math.max(1, Math.floor(img.width * (r.x1 - r.x0)));
        const sh = Math.max(1, Math.floor(img.height * (r.y1 - r.y0)));
        const data = ctx.getImageData(sx, sy, sw, sh).data;
        let hits = 0;
        for (let i = 0; i < data.length; i += 4) {
          const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          if (dark ? lum > 175 : lum < 85) hits += 1;
        }
        return hits;
      },
      { dataUrl: `data:image/png;base64,${b64}`, r: region, dark: darkMode },
    );
  };

  // Switch to Wireframe: CSG plate straight outer edges must draw dark ink pixels in the upper half.
  const canvas = page.locator(".viewer canvas").first();
  await page.getByTestId("viewer-display-mode-btn").click();
  await page.getByTestId("viewer-display-option-wireframe").click();
  await page.waitForTimeout(300);

  const wireLightPng = await canvas.screenshot();
  const upperBandLightHits = await countDarkInkPixelsInRegion(
    wireLightPng,
    { x0: 0.3, y0: 0.22, x1: 0.7, y1: 0.42 },
    false,
  );
  expect(upperBandLightHits).toBeGreaterThan(80);

  // Dark theme in Wireframe must draw bright ink edges cleanly.
  await page.getByRole("button", { name: "Thao tác khác" }).click();
  await page.locator(".theme-switch button", { hasText: "Tối" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.waitForTimeout(300);
  const wireDarkPng = await canvas.screenshot();
  const upperBandDarkHits = await countDarkInkPixelsInRegion(
    wireDarkPng,
    { x0: 0.3, y0: 0.22, x1: 0.7, y1: 0.42 },
    true,
  );
  expect(upperBandDarkHits).toBeGreaterThan(80);

  // Section clipping and remaining modes must also run without shader errors.
  await page.locator('.viewer-tools button[title="Mặt cắt"]').click();
  await page.waitForTimeout(250);
  await page.getByTestId("viewer-display-mode-btn").click();
  await page.getByTestId("viewer-display-option-hiddenLine").click();
  await page.waitForTimeout(250);
  await page.getByTestId("viewer-display-mode-btn").click();
  await page.getByTestId("viewer-display-option-shaded").click();
  await page.waitForTimeout(250);
  await page.getByTestId("viewer-display-mode-btn").click();
  await page.getByTestId("viewer-display-option-shadedEdges").click();
  await page.waitForTimeout(250);
  await page.locator('button[aria-label="Đóng mặt cắt"]').click();

  expect(shaderErrors).toEqual([]);
});
