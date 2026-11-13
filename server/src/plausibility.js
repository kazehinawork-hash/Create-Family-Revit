import { analyzeSpec } from "@family/spec-core";

/**
 * Deterministic mechanical sanity checks. They run after every model turn and the
 * concrete list is what the single self-repair pass is asked to fix.
 *
 * Everything is checked on the RESOLVED geometry (analyzeSpec), so a spec that uses
 * formulas and parameters is validated the same way as a hand-written one.
 */

const THICKNESS_NAME = /(thickness|day|dày|wall|sheet)/i;

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resolvedParts(analysis, spec) {
  const modelParts = analysis?.model?.parts ?? [];
  if (modelParts.length === 0) return [];

  return modelParts.map((part) => {
    const source = (spec?.parts ?? []).find((candidate) => candidate?.id === part.id) ?? {};
    const cuts = (part.cuts ?? source.cuts ?? []).filter(
      (cut) => cut?.kind === "box" && cut.origin && cut.size,
    );

    return {
      id: part.id,
      name: part.name ?? source.name,
      material: part.material ?? source.material,
      count: Math.max(1, Number(part.array?.count ?? source.array?.count ?? 1)),
      solid: part.solid,
      cuts,
    };
  });
}

function boxOf(solid) {
  if (!solid || solid.kind !== "box") return null;
  const origin = ["x", "y", "z"].map((axis) => numeric(solid.origin?.[axis]));
  const size = ["x", "y", "z"].map((axis) => numeric(solid.size?.[axis]));
  if (origin.some((value) => value === null) || size.some((value) => value === null)) return null;
  return {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    size: { x: size[0], y: size[1], z: size[2] },
  };
}

export function checkPlausibility(spec, { evidence = null, bounds = null, analysis = null } = {}) {
  const issues = [];
  const resolved = analysis ?? (spec ? analyzeSpec(spec) : null);
  const size = bounds ?? resolved?.model?.bounds?.size ?? null;
  const parts = resolvedParts(resolved, spec);

  // 1. Thin sheets are not buildable in Revit (short curve tolerance).
  for (const parameter of spec?.parameters ?? []) {
    if (!THICKNESS_NAME.test(parameter?.name ?? "")) continue;
    const value = numeric(parameter.value);
    if (value !== null && value < 1) {
      issues.push({
        code: "thickness-too-thin",
        severity: "error",
        path: `parameters.${parameter.name}`,
        message: `Chiều dày ${parameter.name} = ${value} mm < 1 mm`,
      });
    }
  }

  // 2. Hole edge distance, measured on the solved geometry.
  for (const part of parts) {
    const box = boxOf(part.solid);
    if (!box) continue;

    for (const cut of part.cuts) {
      const cutSize = {
        x: numeric(cut.size.x),
        y: numeric(cut.size.y),
        z: numeric(cut.size.z),
      };
      const cutOrigin = {
        x: numeric(cut.origin.x),
        y: numeric(cut.origin.y),
        z: numeric(cut.origin.z),
      };

      const axes = ["x", "y", "z"].filter(
        (axis) => cutSize[axis] !== null && cutOrigin[axis] !== null,
      );
      if (axes.length < 2) continue;

      // The thinnest axis is the drilling direction; edge distance is measured on
      // the other two so a through-hole is not mistaken for an edge cut.
      const sorted = [...axes].sort((a, b) => cutSize[a] - cutSize[b]);
      const inPlane = sorted.slice(1);
      const d = Math.max(...inPlane.map((axis) => cutSize[axis] ?? 0));
      if (!d) continue;

      for (const axis of inPlane) {
        const half = box.size[axis] / 2;
        const center = box.origin[axis];
        const cutCenter = cutOrigin[axis];
        const cutHalf = cutSize[axis] / 2;

        const distance = Math.min(
          Math.abs(center + half - (cutCenter + cutHalf)),
          Math.abs(cutCenter - cutHalf - (center - half)),
        );

        if (distance >= 0 && distance < 1.5 * d) {
          issues.push({
            code: "hole-close-to-edge",
            severity: "error",
            path: `parts.${part.id}`,
            message: `Lỗ trên ${part.name ?? part.id} cách mép ${distance.toFixed(1)} mm < 1.5d (${(1.5 * d).toFixed(1)} mm)`,
          });
          break;
        }
      }
    }
  }

  // 3. Connectors must sit on an outer face and point outwards.
  const center = { x: 0, y: 0, z: (size?.z ?? 0) / 2 };

  for (const connector of spec?.connectors ?? []) {
    const direction = connector?.directionVector;
    const origin = connector?.origin;
    if (!direction || !origin) continue;

    const ox = numeric(origin.x);
    const oy = numeric(origin.y);
    const dx = numeric(direction.x) ?? 0;
    const dy = numeric(direction.y) ?? 0;
    if (ox === null || oy === null) continue;

    const outwardX = ox - center.x;
    const outwardY = oy - center.y;
    const dot = outwardX * dx + outwardY * dy;

    if ((Math.abs(outwardX) > 1 || Math.abs(outwardY) > 1) && dot < 0) {
      issues.push({
        code: "connector-inward",
        severity: "error",
        path: `connectors.${connector.id}`,
        message: `Connector ${connector.id} quay vào trong thay vì hướng ra ngoài`,
      });
    }
  }

  // 4. Overall size must stay close to the evidence (the real product).
  const overall = evidence?.overall;
  if (overall && size) {
    const expected = [overall.x, overall.y, overall.z].map(Number);
    const actual = [size.x, size.y, size.z];
    expected.forEach((value, index) => {
      if (!Number.isFinite(value) || value <= 0) return;
      const deviation = Math.abs(actual[index] - value) / value;
      if (deviation > 0.05) {
        issues.push({
          code: "bounds-deviation",
          severity: "warning",
          path: "$.bounds",
          message:
            `Kích thước ${"XYZ"[index]} = ${Math.round(actual[index])} mm lệch ` +
            `${Math.round(deviation * 100)}% so với hồ sơ (${Math.round(value)} mm)`,
        });
      }
    });
  }

  // 5. Every part needs a material that exists in the palette.
  const materials = new Set((spec?.materials ?? []).map((material) => material?.name));
  for (const part of parts) {
    if (!part.material) {
      issues.push({
        code: "part-without-material",
        severity: "error",
        path: `parts.${part.id}`,
        message: `Part ${part.name ?? part.id} chưa có vật liệu`,
      });
    } else if (materials.size > 0 && !materials.has(part.material)) {
      issues.push({
        code: "material-not-declared",
        severity: "error",
        path: `parts.${part.id}`,
        message: `Part ${part.name ?? part.id} dùng vật liệu ${part.material} chưa khai báo`,
      });
    }
  }

  // 6. Repeated details must match the evidence count (array.count included).
  for (const component of evidence?.components ?? []) {
    const expected = Number(component?.count);
    if (!Number.isFinite(expected) || expected <= 0) continue;

    const needle = String(component.kind ?? "").toLowerCase().replace(/-/g, " ");
    if (!needle) continue;

    const actual = parts
      .filter((part) =>
        String(`${part.name ?? ""} ${part.id ?? ""}`)
          .toLowerCase()
          .includes(needle.split(" ")[0]),
      )
      .reduce((total, part) => total + part.count, 0);

    if (actual > 0 && actual !== expected) {
      issues.push({
        code: "component-count",
        severity: "warning",
        path: `$.parts`,
        message: `Hồ sơ ghi ${expected} ${component.kind}, mô hình có ${actual}`,
      });
    }
  }

  return issues;
}

/** Compact block for the self-repair prompt. */
export function describeIssues(issues) {
  return (issues ?? [])
    .slice(0, 15)
    .map((issue) => `- ${issue.path}: ${issue.message}`)
    .join("\n");
}
