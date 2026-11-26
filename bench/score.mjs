/**
 * Objective scoring rubric for family specs against benchmark criteria.
 * Scores 0..100 across 4 categories:
 *   - validity & completeness (30 pts)
 *   - overall bounding box within tolerance (25 pts)
 *   - required parameters & parametric drive (20 pts)
 *   - required parts & sheet-metal features: holes/slots, miter/chamfer, folded flanges (25 pts)
 */

function hasMatch(list, pattern) {
  const regex = new RegExp(pattern, "i");
  return list.some((item) => regex.test(String(item ?? "")));
}

function hasCutOrHole(spec) {
  const parts = Array.isArray(spec?.parts) ? spec.parts : [];
  return parts.some(
    (part) =>
      (Array.isArray(part?.cuts) && part.cuts.length > 0) ||
      (part?.solid?.kind === "prism" &&
        Array.isArray(part.solid.holes) &&
        part.solid.holes.length > 0) ||
      /\b(hole|slot|lỗ|rãnh)\b/i.test(`${part?.id ?? ""} ${part?.name ?? ""}`),
  );
}

function hasMiterOrChamfer(spec, analysis) {
  const parts = Array.isArray(analysis?.model?.parts) ? analysis.model.parts : [];
  for (const part of parts) {
    if (part.solid?.kind === "prism" && Array.isArray(part.solid.points)) {
      const pts = part.solid.points;
      for (let i = 0; i < pts.length; i += 1) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const dx = Math.abs(b[0] - a[0]);
        const dy = Math.abs(b[1] - a[1]);
        // Any non-axis-aligned segment indicates a chamfered / mitred edge.
        if (dx > 0.5 && dy > 0.5) return true;
      }
    }
    if (/miter|chamfer|vát|corner/i.test(`${part.id} ${part.name}`)) return true;
  }
  return Boolean(spec?.macros?.some((m) => Array.isArray(m?.segments) && m.segments.some((s) => s.kind === "bend")));
}

function hasFoldedFlange(spec) {
  const parts = Array.isArray(spec?.parts) ? spec.parts : [];
  const params = Array.isArray(spec?.parameters) ? spec.parameters : [];
  const partMatch = parts.some((p) => /flange|lip|mép|gập|uốn|hem/i.test(`${p?.id ?? ""} ${p?.name ?? ""}`));
  const paramMatch = params.some((p) => /flange|lip|mép|gập/i.test(String(p?.name ?? "")));
  return partMatch || paramMatch;
}

function axisWithin(actual, [min, max], tol) {
  if (!Number.isFinite(actual)) return { ok: false, delta: Infinity };
  if (actual >= min && actual <= max) return { ok: true, delta: 0 };
  const delta = actual < min ? min - actual : actual - max;
  return { ok: delta <= tol, delta: Math.round(delta * 10) / 10 };
}

export function scoreBenchmarkCase(testCase, analysis, meta = {}) {
  const spec = analysis?.spec ?? {};
  const criteria = testCase.criteria ?? {};
  const parts = Array.isArray(spec.parts) ? spec.parts : [];
  const params = Array.isArray(spec.parameters) ? spec.parameters : [];
  const connectors = Array.isArray(spec.connectors) ? spec.connectors : [];

  // 1. Validity & completeness (30 pts)
  let validPts = 0;
  const parseOk = Boolean(analysis?.ok && (analysis?.errors?.length ?? 0) === 0);
  if (parseOk) validPts += 18;
  const minPartsOk = parts.length >= (criteria.minParts ?? 1);
  if (minPartsOk) validPts += 6;
  const minConnOk = connectors.length >= (criteria.minConnectors ?? 0);
  if (minConnOk) validPts += 6;

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
    axisResults[axis] = { actual: size ? Math.round(size[axis] * 10) / 10 : null, expected: boundsSpec[axis], ...check };
    if (check.ok) axesPassed += 1;
    if (Number.isFinite(check.delta)) maxDeltaMm = Math.max(maxDeltaMm, check.delta);
  }
  const boundsPts = axes.length > 0 ? Math.round((25 * axesPassed) / axes.length) : 25;

  // 3. Required parameters & parametric drive (20 pts)
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
    Math.round(12 * paramCoverage + 8 * driveRatio - Math.min(4, unusedWarnings)),
  );

  // 4. Required parts & sheet-metal features (25 pts)
  const partLabels = parts.map((p) => `${p?.id ?? ""} ${p?.name ?? ""}`);
  const reqParts = criteria.requiredParts ?? [];
  const partHits = reqParts.filter((pat) => hasMatch(partLabels, pat)).length;
  const partCoverage = reqParts.length > 0 ? partHits / reqParts.length : 1;

  const features = criteria.features ?? {};
  const featureChecks = [];
  if (features.foldedFlange !== undefined) {
    const got = hasFoldedFlange(spec);
    featureChecks.push({ name: "foldedFlange", expected: features.foldedFlange, actual: got, ok: got === features.foldedFlange });
  }
  if (features.miteredOrChamfer !== undefined) {
    const got = hasMiterOrChamfer(spec, analysis);
    featureChecks.push({ name: "miteredOrChamfer", expected: features.miteredOrChamfer, actual: got, ok: got === features.miteredOrChamfer });
  }
  if (features.holesOrSlots !== undefined) {
    const got = hasCutOrHole(spec);
    featureChecks.push({ name: "holesOrSlots", expected: features.holesOrSlots, actual: got, ok: got === features.holesOrSlots });
  }
  const featurePassRatio =
    featureChecks.length > 0
      ? featureChecks.filter((c) => c.ok).length / featureChecks.length
      : 1;
  const featuresPts = Math.round(13 * partCoverage + 12 * featurePassRatio);

  const totalScore = Math.min(100, validPts + boundsPts + paramPts + featuresPts);
  const usedMacro = Array.isArray(spec.macros) && spec.macros.length > 0;

  return {
    id: testCase.id,
    group: testCase.group,
    supportsMacro: Boolean(testCase.supportsMacro),
    usedMacro,
    ok: parseOk && minPartsOk && minConnOk && axesPassed === axes.length,
    totalScore,
    breakdown: {
      valid: validPts,
      bounds: boundsPts,
      params: paramPts,
      features: featuresPts,
    },
    counts: {
      parts: parts.length,
      resolvedParts: analysis?.model?.parts?.length ?? 0,
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
    promptChars: meta.promptChars ?? 0,
    modelCalls: meta.modelCalls ?? 0,
  };
}
