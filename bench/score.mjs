import { partBounds } from "../packages/spec-core/dist/index.js";

/**
 * Pure-geometry benchmark rubric (0..100).
 * Inspects only the resolved 3D solids (`analysis.model.parts`) and validation/health checks —
 * never inspects `spec.macros` or part names to infer holes/miters/flanges, so `before` and
 * `after` modes are scored identically on geometry.
 */

function hasMatch(list, pattern) {
  const regex = new RegExp(pattern, "i");
  return list.some((item) => regex.test(String(item ?? "")));
}

function axisWithin(actual, [min, max], tol) {
  if (!Number.isFinite(actual)) return { ok: false, delta: Infinity };
  if (actual >= min && actual <= max) return { ok: true, delta: 0 };
  const delta = actual < min ? min - actual : actual - max;
  return { ok: delta <= tol, delta: Math.round(delta * 10) / 10 };
}

function pointInPolygonStrict(pt, poly) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const onSegment =
      Math.abs((xj - xi) * (y - yi) - (yj - yi) * (x - xi)) < 1e-3 &&
      x >= Math.min(xi, xj) - 1e-3 &&
      x <= Math.max(xi, xj) + 1e-3 &&
      y >= Math.min(yi, yj) - 1e-3 &&
      y <= Math.max(yi, yj) + 1e-3;
    if (onSegment) return false;
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function segmentsProperlyCross(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return (
    ((d1 > 0.25 && d2 < -0.25) || (d1 < -0.25 && d2 > 0.25)) &&
    ((d3 > 0.25 && d4 < -0.25) || (d3 < -0.25 && d4 > 0.25))
  );
}

function shrinkPointToward(pt, centroid, insetMm = 0.4) {
  const dx = centroid[0] - pt[0];
  const dy = centroid[1] - pt[1];
  const len = Math.hypot(dx, dy);
  if (len <= insetMm * 2) return [centroid[0], centroid[1]];
  return [pt[0] + (dx / len) * insetMm, pt[1] + (dy / len) * insetMm];
}

function polygonCentroid(pts) {
  const n = Math.max(1, pts.length);
  return [
    pts.reduce((s, p) => s + p[0], 0) / n,
    pts.reduce((s, p) => s + p[1], 0) / n,
  ];
}

/** True when two 2D XY polygons overlap in interior area rather than just sharing a mitred seam. */
function xyPolygonsInteriorOverlap(ptsA, ptsB) {
  if (ptsA.length < 3 || ptsB.length < 3) return true;

  for (let i = 0; i < ptsA.length; i += 1) {
    const a1 = ptsA[i];
    const a2 = ptsA[(i + 1) % ptsA.length];
    for (let j = 0; j < ptsB.length; j += 1) {
      const b1 = ptsB[j];
      const b2 = ptsB[(j + 1) % ptsB.length];
      if (segmentsProperlyCross(a1, a2, b1, b2)) return true;
    }
  }

  const cA = polygonCentroid(ptsA);
  const cB = polygonCentroid(ptsB);
  if (pointInPolygonStrict(cA, ptsB) || pointInPolygonStrict(cB, ptsA)) return true;

  for (let i = 0; i < ptsA.length; i += 1) {
    const mid = [(ptsA[i][0] + ptsA[(i + 1) % ptsA.length][0]) / 2, (ptsA[i][1] + ptsA[(i + 1) % ptsA.length][1]) / 2];
    if (pointInPolygonStrict(shrinkPointToward(ptsA[i], cA, 0.5), ptsB)) return true;
    if (pointInPolygonStrict(shrinkPointToward(mid, cA, 0.5), ptsB)) return true;
  }
  for (let j = 0; j < ptsB.length; j += 1) {
    const mid = [(ptsB[j][0] + ptsB[(j + 1) % ptsB.length][0]) / 2, (ptsB[j][1] + ptsB[(j + 1) % ptsB.length][1]) / 2];
    if (pointInPolygonStrict(shrinkPointToward(ptsB[j], cB, 0.5), ptsA)) return true;
    if (pointInPolygonStrict(shrinkPointToward(mid, cB, 0.5), ptsA)) return true;
  }
  return false;
}

function expandPartInstances(model) {
  const parts = Array.isArray(model?.parts) ? model.parts : [];
  const items = [];
  for (const part of parts) {
    if (/clearance/i.test(`${part.id ?? ""} ${part.name ?? ""}`)) continue;
    const base = partBounds({ ...part, array: { count: 1, axis: "x", spacing: 0 } });
    const count = Math.max(1, part.array?.count ?? 1);
    const axis = part.array?.axis ?? "x";
    const spacing = part.array?.spacing ?? 0;

    for (let i = 0; i < count; i += 1) {
      const dx = axis === "x" ? spacing * i : 0;
      const dy = axis === "y" ? spacing * i : 0;
      const dz = axis === "z" ? spacing * i : 0;
      const bounds = {
        minX: base.min.x + dx,
        maxX: base.max.x + dx,
        minY: base.min.y + dy,
        maxY: base.max.y + dy,
        minZ: base.min.z + dz,
        maxZ: base.max.z + dz,
      };
      const vol =
        Math.max(0.1, bounds.maxX - bounds.minX) *
        Math.max(0.1, bounds.maxY - bounds.minY) *
        Math.max(0.1, bounds.maxZ - bounds.minZ);
      items.push({ part, bounds, vol, index: i });
    }
  }
  return items;
}

function boundsGap(a, b) {
  const gx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const gy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  const gz = Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ);
  return Math.hypot(gx, gy, gz);
}

/** Purely geometric health: overlap & connectivity checks across resolved instances. */
function evaluateGeometryQuality(analysis) {
  const items = expandPartInstances(analysis?.model);
  let severeOverlaps = 0;

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      const ox = Math.min(a.bounds.maxX, b.bounds.maxX) - Math.max(a.bounds.minX, b.bounds.minX);
      const oy = Math.min(a.bounds.maxY, b.bounds.maxY) - Math.max(a.bounds.minY, b.bounds.minY);
      const oz = Math.min(a.bounds.maxZ, b.bounds.maxZ) - Math.max(a.bounds.minZ, b.bounds.minZ);
      if (ox <= 0.2 || oy <= 0.2 || oz <= 0.2) continue;

      // Exact 2D check when both parts are XY-extruded prisms (prevents false positives on mitred 45° corners).
      if (
        a.part.solid?.kind === "prism" &&
        a.part.solid.plane === "xy" &&
        b.part.solid?.kind === "prism" &&
        b.part.solid.plane === "xy" &&
        a.index === 0 &&
        b.index === 0 &&
        !xyPolygonsInteriorOverlap(a.part.solid.points, b.part.solid.points)
      ) {
        continue;
      }

      const overlapVol = ox * oy * oz;
      const minVol = Math.min(a.vol, b.vol);
      const maxVol = Math.max(a.vol, b.vol);
      // Enclosure containment (e.g. coil/fan housed strictly inside an AHU casing) is not a collision.
      if (maxVol >= minVol * 3 && overlapVol / minVol >= 0.85) continue;
      // Tubular pipe/duct unions (coaxial flange collar on pipe, Y/T branch junction) unless duplicate solid.
      const tubular = (k) => k === "cylinder" || k === "tube";
      if (tubular(a.part.solid?.kind) && tubular(b.part.solid?.kind)) {
        const isDuplicateSolid = overlapVol / minVol > 0.9 && maxVol / minVol < 1.2;
        if (!isDuplicateSolid) continue;
      }
      if (Math.min(ox, oy, oz) > 2.5 && overlapVol > 200 && overlapVol / minVol > 0.12) {
        severeOverlaps += 1;
      }
    }
  }

  let components = items.length === 0 ? 0 : 1;
  if (items.length > 1) {
    const visited = new Uint8Array(items.length);
    components = 0;
    for (let start = 0; start < items.length; start += 1) {
      if (visited[start]) continue;
      components += 1;
      const queue = [start];
      visited[start] = 1;
      while (queue.length > 0) {
        const cur = queue.shift();
        for (let next = 0; next < items.length; next += 1) {
          if (visited[next]) continue;
          if (boundsGap(items[cur].bounds, items[next].bounds) <= 4.0) {
            visited[next] = 1;
            queue.push(next);
          }
        }
      }
    }
  }

  const geomWarnings = (analysis?.issues ?? []).filter(
    (issue) => issue.path.startsWith("logic.geometry.") || issue.severity === "warning" && issue.path.startsWith("logic."),
  ).length;

  const overlapPts = Math.max(0, 8 - severeOverlaps * 4);
  const connectedPts = components <= 1 ? 7 : Math.max(0, Math.round(7 - (components - 1) * 3.5));
  const healthPts = Math.max(0, 5 - geomWarnings * 2);

  return {
    severeOverlaps,
    components,
    geomWarnings,
    score: overlapPts + connectedPts + healthPts,
  };
}

function hasCutOrHoleGeometry(spec, analysis) {
  const specParts = Array.isArray(spec?.parts) ? spec.parts : [];
  const modelParts = Array.isArray(analysis?.model?.parts) ? analysis.model.parts : [];
  return [...specParts, ...modelParts].some(
    (part) =>
      (Array.isArray(part?.cuts) && part.cuts.length > 0) ||
      (part?.solid?.kind === "prism" && Array.isArray(part.solid.holes) && part.solid.holes.length > 0),
  );
}

function hasMiterOrChamferGeometry(analysis) {
  const parts = Array.isArray(analysis?.model?.parts) ? analysis.model.parts : [];
  for (const part of parts) {
    if (part.solid?.kind === "prism" && Array.isArray(part.solid.points)) {
      const pts = part.solid.points;
      for (let i = 0; i < pts.length; i += 1) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if (Math.abs(b[0] - a[0]) > 0.5 && Math.abs(b[1] - a[1]) > 0.5) return true;
      }
    }
    if (part.solid?.kind === "loft" && Array.isArray(part.solid.sections)) {
      for (const section of part.solid.sections) {
        const pts = section.points ?? [];
        for (let i = 0; i < pts.length; i += 1) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          if (Math.abs(b[0] - a[0]) > 0.5 && Math.abs(b[1] - a[1]) > 0.5) return true;
        }
      }
    }
    if (part.solid?.kind === "bend") return true;
  }
  return false;
}

function xyPolygonArea(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function hasFoldedFlangeGeometry(analysis) {
  const model = analysis?.model;
  const parts = Array.isArray(model?.parts) ? model.parts : [];
  const modelBounds = model?.bounds;
  if (!modelBounds || parts.length === 0) return false;

  const modelMaxZ = modelBounds.max.z;
  const modelSizeZ = Math.max(1, modelBounds.size.z);

  let topThinHorizPlates = 0;
  for (const part of parts) {
    if (part.solid?.kind === "prism" && part.solid.plane !== "xy" && (part.solid.points?.length ?? 0) >= 6) {
      return true;
    }
    const b = partBounds(part);
    const sz = b.max.z - b.min.z;
    const sx = b.max.x - b.min.x;
    const sy = b.max.y - b.min.y;
    const horizSpan = Math.max(sx, sy);
    const minHoriz = Math.min(sx, sy);
    const isLShapedPerimeterStrip =
      part.solid?.kind === "prism" &&
      part.solid.plane === "xy" &&
      (part.solid.points?.length ?? 0) >= 6 &&
      xyPolygonArea(part.solid.points) < Math.max(1, sx * sy) * 0.45;
    const isThinPlateZ =
      sz > 0.4 && sz <= 8 && horizSpan > sz * 2 && (minHoriz <= 60 || isLShapedPerimeterStrip);
    const nearTop = b.max.z >= modelMaxZ - Math.max(12, modelSizeZ * 0.2);
    const notFullWidthLid =
      isLShapedPerimeterStrip ||
      minHoriz < Math.min(modelBounds.size.x, modelBounds.size.y) * 0.45 ||
      parts.length <= 2;

    if (isThinPlateZ && nearTop && notFullWidthLid) {
      topThinHorizPlates += 1;
    }
  }
  return parts.length <= 3 ? topThinHorizPlates >= 1 : topThinHorizPlates >= 2;
}

export function scoreBenchmarkCase(testCase, analysis, meta = {}) {
  const spec = analysis?.spec ?? {};
  const criteria = testCase.criteria ?? {};
  const parts = Array.isArray(spec.parts) ? spec.parts : [];
  const modelParts = Array.isArray(analysis?.model?.parts) ? analysis.model.parts : [];
  const params = Array.isArray(spec.parameters) ? spec.parameters : [];
  const connectors = Array.isArray(spec.connectors) ? spec.connectors : [];

  // 1. Validity & completeness (25 pts)
  let validPts = 0;
  const parseOk = Boolean(analysis?.ok && (analysis?.errors?.length ?? 0) === 0);
  if (parseOk) validPts += 15;
  const minPartsOk = modelParts.length >= (criteria.minParts ?? 1);
  if (minPartsOk) validPts += 5;
  const minConnOk = connectors.length >= (criteria.minConnectors ?? 0);
  if (minConnOk) validPts += 5;

  // 2. Bounds accuracy (25 pts)
  const size = analysis?.model?.bounds?.size ?? null;
  const boundsSpec = criteria.bounds ?? {};
  const tol = boundsSpec.toleranceMm ?? 20;
  const axes = ["x", "y", "z"].filter((axis) => Array.isArray(boundsSpec[axis]));
  const axisResults = {};
  let axesPassed = 0;
  let maxDeltaMm = 0;
  for (const axis of axes) {
    const check = axisWithin(size?.[axis], boundsSpec[axis], tol);
    axisResults[axis] = {
      actual: size ? Math.round(size[axis] * 10) / 10 : null,
      expected: boundsSpec[axis],
      ...check,
    };
    if (check.ok) axesPassed += 1;
    if (Number.isFinite(check.delta)) maxDeltaMm = Math.max(maxDeltaMm, check.delta);
  }
  const boundsPts = axes.length > 0 ? Math.round((25 * axesPassed) / axes.length) : 25;

  // 3. Required parameters & parametric drive (15 pts)
  const paramNames = params.map((p) => p?.name ?? "");
  const reqParams = criteria.requiredParams ?? [];
  const paramHits = reqParams.filter((pat) => hasMatch(paramNames, pat)).length;
  const paramCoverage = reqParams.length > 0 ? paramHits / reqParams.length : 1;
  const parametricParts = parts.filter((p) => /\[[^\]]+\]/.test(JSON.stringify(p))).length;
  const driveRatio = parts.length > 0 ? parametricParts / parts.length : 0;
  const unusedWarnings = (analysis?.issues ?? []).filter(
    (issue) => issue.path.startsWith("parameters.") && issue.message.includes("không điều khiển"),
  ).length;
  const paramPts = Math.max(
    0,
    Math.round(9 * paramCoverage + 6 * driveRatio - Math.min(3, unusedWarnings)),
  );

  // 4. Geometry integrity (20 pts): overlap, connected seams, no geometry health issues
  const geomQuality = evaluateGeometryQuality(analysis);

  // 5. Required parts & pure-geometry sheet-metal features (15 pts)
  const partLabels = [...parts, ...modelParts].map((p) => `${p?.id ?? ""} ${p?.name ?? ""}`);
  const reqParts = criteria.requiredParts ?? [];
  const partHits = reqParts.filter((pat) => hasMatch(partLabels, pat)).length;
  const partCoverage = reqParts.length > 0 ? partHits / reqParts.length : 1;

  const features = criteria.features ?? {};
  const featureChecks = [];
  if (features.foldedFlange !== undefined) {
    const got = hasFoldedFlangeGeometry(analysis);
    featureChecks.push({ name: "foldedFlange", expected: features.foldedFlange, actual: got, ok: got === features.foldedFlange });
  }
  if (features.miteredOrChamfer !== undefined) {
    const got = hasMiterOrChamferGeometry(analysis);
    featureChecks.push({ name: "miteredOrChamfer", expected: features.miteredOrChamfer, actual: got, ok: got === features.miteredOrChamfer });
  }
  if (features.holesOrSlots !== undefined) {
    const got = hasCutOrHoleGeometry(spec, analysis);
    featureChecks.push({ name: "holesOrSlots", expected: features.holesOrSlots, actual: got, ok: got === features.holesOrSlots });
  }
  const featurePassRatio =
    featureChecks.length > 0
      ? featureChecks.filter((c) => c.ok).length / featureChecks.length
      : 1;
  const featuresPts = Math.round(6 * partCoverage + 9 * featurePassRatio);

  const totalScore = Math.min(
    100,
    validPts + boundsPts + paramPts + geomQuality.score + featuresPts,
  );
  const usedMacro = Array.isArray(spec.macros) && spec.macros.length > 0;

  return {
    id: testCase.id,
    group: testCase.group,
    supportsMacro: Boolean(testCase.supportsMacro),
    usedMacro,
    ok:
      parseOk &&
      minPartsOk &&
      minConnOk &&
      axesPassed === axes.length &&
      geomQuality.severeOverlaps === 0 &&
      geomQuality.components <= 1,
    totalScore,
    breakdown: {
      valid: validPts,
      bounds: boundsPts,
      params: paramPts,
      geometry: geomQuality.score,
      features: featuresPts,
    },
    geometryQuality: geomQuality,
    counts: {
      parts: parts.length,
      resolvedParts: modelParts.length,
      parameters: params.length,
      connectors: connectors.length,
      errors: analysis?.errors?.length ?? 0,
      warnings: (analysis?.issues?.length ?? 0) - (analysis?.errors?.length ?? 0),
    },
    bounds: size
      ? [Math.round(size.x * 10) / 10, Math.round(size.y * 10) / 10, Math.round(size.z * 10) / 10]
      : null,
    axisResults,
    maxDeltaMm,
    featureChecks,
    elapsedMs: meta.elapsedMs ?? 0,
    inChars: meta.inChars ?? meta.promptChars ?? 0,
    outChars: meta.outChars ?? 0,
    modelCalls: meta.modelCalls ?? 0,
    repairs: meta.repairs ?? 0,
    model: meta.model ?? null,
  };
}
