/**
 * Post-build QA: compare what Revit actually built with the resolved spec.
 *
 * The bridge already returns build stats, but the studio previously showed them
 * without checking them. This module turns those numbers into explicit checks so
 * a mismatch is reported immediately instead of being found in Revit later.
 */

const BOUNDS_TOLERANCE_MM = 2;

function round(value) {
  return Math.round(Number(value) || 0);
}

function check(checks, warnings, id, ok, message) {
  checks.push({ id, ok, message });
  if (!ok) warnings.push(message);
}

export function auditBuild(analysis, result) {
  const checks = [];
  const warnings = [];
  const stats = result?.stats ?? {};
  const model = analysis?.model;

  if (!model) {
    return { ok: true, warnings, checks, rebuildRequired: false, parityRisks: 0 };
  }

  const expectedParts = model.parts.length;
  const expectedInstances = model.instances;
  const expectedConnectors = model.connectors.length;
  const expectedParameters = analysis.parameters?.parameters?.length ?? 0;
  const parityRisks = Array.isArray(analysis.parity) ? analysis.parity.length : 0;

  if (typeof stats.parts === "number") {
    check(
      checks,
      warnings,
      "parts",
      stats.parts === expectedParts,
      `QA: Revit dựng ${stats.parts}/${expectedParts} part.`,
    );
  }

  if (typeof stats.instances === "number") {
    check(
      checks,
      warnings,
      "instances",
      stats.instances === expectedInstances,
      `QA: Revit dựng ${stats.instances}/${expectedInstances} instance (array).`,
    );
  }

  if (typeof stats.totalForms === "number") {
    check(
      checks,
      warnings,
      "forms",
      stats.totalForms >= expectedInstances,
      `QA: Revit dựng ${stats.totalForms} form cho ${expectedInstances} instance (form dư là các mảnh tách tại notch).`,
    );
  }

  if (typeof stats.missingForms === "number" && stats.missingForms > 0) {
    const details =
      Array.isArray(stats.failedParts) && stats.failedParts.length > 0
        ? `: ${stats.failedParts.slice(0, 5).join("; ")}`
        : ".";
    warnings.push(`QA: ${stats.missingForms} part/copy không dựng được${details}`);
  }

  if (typeof stats.connectors === "number") {
    check(
      checks,
      warnings,
      "connectors",
      stats.connectors === expectedConnectors,
      `QA: Revit tạo ${stats.connectors}/${expectedConnectors} connector.`,
    );
  }

  if (typeof stats.parameters === "number") {
    check(
      checks,
      warnings,
      "parameters",
      stats.parameters === expectedParameters,
      `QA: Revit có ${stats.parameters}/${expectedParameters} parameter.`,
    );
  }

  const bounds = model.bounds;
  if (stats.bounds && bounds) {
    const diffs = ["x", "y", "z"].filter((axis) => {
      const revit = Number(stats.bounds[axis]);
      return !Number.isFinite(revit) || Math.abs(revit - bounds.size[axis]) > BOUNDS_TOLERANCE_MM;
    });
    check(
      checks,
      warnings,
      "bounds",
      diffs.length === 0,
      `QA: kích thước bao lệch ở ${diffs.join(", ")} ` +
        `(Revit ${round(stats.bounds.x)}×${round(stats.bounds.y)}×${round(stats.bounds.z)} mm, ` +
        `studio ${round(bounds.size.x)}×${round(bounds.size.y)}×${round(bounds.size.z)} mm).`,
    );
  }

  if (typeof stats.freeforms === "number" && stats.freeforms > 0) {
    warnings.push(
      `QA: ${stats.freeforms} part đã thành FreeFormElement — đổi tham số sẽ cần Rebuild from spec.`,
    );
  }

  const rebuildRequired = Boolean(
    (Number(stats.freeforms) || 0) > 0 ||
    (Array.isArray(stats.inert) && stats.inert.length > 0) ||
    (Array.isArray(stats.unlabelled) && stats.unlabelled.length > 0) ||
    (typeof stats.flex === "string" && /still|X /.test(stats.flex)),
  );

  return {
    ok: warnings.length === 0,
    warnings,
    checks,
    rebuildRequired,
    parityRisks,
  };
}
