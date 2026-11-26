import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { partBounds } from "../packages/spec-core/dist/index.js";

function isoProject(x, y, z) {
  // Standard isometric angle (30°): X right-down, Y left-down, Z up.
  const cos30 = Math.cos(Math.PI / 6);
  const sin30 = 0.5;
  return {
    u: (x - y) * cos30,
    v: -(z - (x + y) * sin30),
    depth: x + y - z * 0.25,
  };
}

function resolveColor(part, materials) {
  if (part.color) return part.color;
  const mat = (materials ?? []).find(
    (m) => m.name && part.material && m.name.toLowerCase() === part.material.toLowerCase(),
  );
  return mat?.color || "#9aa8b4";
}

function boxFaces(b) {
  const { minX, maxX, minY, maxY, minZ, maxZ } = b;
  const corners = [
    [minX, minY, minZ],
    [maxX, minY, minZ],
    [maxX, maxY, minZ],
    [minX, maxY, minZ],
    [minX, minY, maxZ],
    [maxX, minY, maxZ],
    [maxX, maxY, maxZ],
    [minX, maxY, maxZ],
  ];
  return [
    { pts: [corners[4], corners[5], corners[6], corners[7]], shade: 1.08 }, // top
    { pts: [corners[0], corners[1], corners[5], corners[4]], shade: 0.92 }, // -Y front
    { pts: [corners[1], corners[2], corners[6], corners[5]], shade: 0.8 },  // +X right
    { pts: [corners[3], corners[0], corners[4], corners[7]], shade: 0.86 }, // -X left
  ];
}

function prismFaces(solid) {
  if (solid.plane !== "xy" || !Array.isArray(solid.points) || solid.points.length < 3) return null;
  const from = Math.min(solid.from, solid.to);
  const to = Math.max(solid.from, solid.to);
  const top = solid.points.map(([x, y]) => [x, y, to]);
  const bottom = solid.points.map(([x, y]) => [x, y, from]);
  const faces = [{ pts: top, shade: 1.06 }];
  for (let i = 0; i < solid.points.length; i += 1) {
    const next = (i + 1) % solid.points.length;
    faces.push({
      pts: [bottom[i], bottom[next], top[next], top[i]],
      shade: i % 2 === 0 ? 0.88 : 0.78,
    });
  }
  return faces;
}

function tint(hex, factor) {
  const clean = String(hex || "#9aa8b4").replace("#", "");
  if (clean.length !== 6) return "#9aa8b4";
  const r = Math.min(255, Math.max(0, Math.round(parseInt(clean.slice(0, 2), 16) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(parseInt(clean.slice(2, 4), 16) * factor)));
  const b = Math.min(255, Math.max(0, Math.round(parseInt(clean.slice(4, 6), 16) * factor)));
  return `rgb(${r},${g},${b})`;
}

/**
 * Render an isometric PNG thumbnail directly from a resolved model without a browser.
 */
export function renderPreviewPng(outFile, analysis, meta = {}) {
  const width = 640;
  const height = 400;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, width, height);

  const model = analysis?.model;
  const parts = Array.isArray(model?.parts) ? model.parts : [];
  const rawFaces = [];

  for (const part of parts) {
    const color = resolveColor(part, model?.materials);
    const faces =
      part.solid?.kind === "prism" ? prismFaces(part.solid) : boxFaces(partBounds(part));
    const list = faces ?? boxFaces(partBounds(part));
    for (const face of list) {
      const projected = face.pts.map(([x, y, z]) => isoProject(x, y, z));
      const depth =
        projected.reduce((acc, p) => acc + p.depth, 0) / Math.max(1, projected.length);
      rawFaces.push({ projected, depth, color: tint(color, face.shade) });
    }
  }

  rawFaces.sort((a, b) => a.depth - b.depth);

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const face of rawFaces) {
    for (const p of face.projected) {
      if (p.u < minU) minU = p.u;
      if (p.u > maxU) maxU = p.u;
      if (p.v < minV) minV = p.v;
      if (p.v > maxV) maxV = p.v;
    }
  }

  if (Number.isFinite(minU) && maxU > minU && maxV > minV) {
    const padX = 48;
    const padTop = 36;
    const padBottom = 64;
    const scale = Math.min(
      (width - padX * 2) / (maxU - minU),
      (height - padTop - padBottom) / (maxV - minV),
    );
    const cx = (minU + maxU) / 2;
    const cy = (minV + maxV) / 2;
    const ox = width / 2;
    const oy = (height - padBottom + padTop) / 2;

    for (const face of rawFaces) {
      ctx.beginPath();
      face.projected.forEach((p, idx) => {
        const sx = ox + (p.u - cx) * scale;
        const sy = oy + (p.v - cy) * scale;
        if (idx === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
      ctx.fillStyle = face.color;
      ctx.fill();
      ctx.strokeStyle = "#1e293b";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }

  // Footer HUD
  ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
  ctx.fillRect(0, height - 46, width, 46);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText(String(meta.label || analysis?.spec?.name || "Preview"), 16, height - 24);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "12px monospace";
  const b = model?.bounds?.size;
  const bStr = b ? `${Math.round(b.x)}x${Math.round(b.y)}x${Math.round(b.z)} mm` : "no-bounds";
  ctx.fillText(
    `Score: ${meta.score ?? "-"}/100  |  Parts: ${parts.length}  |  Bounds: ${bStr}`,
    16,
    height - 8,
  );

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, canvas.toBuffer("image/png"));
}
