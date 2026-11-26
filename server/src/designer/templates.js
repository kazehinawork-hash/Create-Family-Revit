import { analyzeSpec } from "@family/spec-core";
import { checkCompleteness, partUnitKey } from "../checklist.js";
import { config } from "../config.js";
import { allowedParameterNames, applyResolvedValues } from "../design-evidence.js";
import { writeCachedResult } from "../result-cache.js";
import { TIER } from "../router.js";
import { matcherForKind, resolvedToTemplateOptions } from "../rules.js";
import {
  buildTemplateSpec,
  extractTemplateOptions,
  matchTemplateFamily,
} from "../templates/cable-ladder.js";
import { summarise } from "./prompts.js";
import { autoHealSpec, fillMissingParameters } from "./repair.js";

/**
 * Append missing checklist items/connectors from a matching cable-ladder template
 * when a model misses requested groups.
 */
export function fillMissingFromTemplate({ prompt, spec, gaps, checklist }) {
  if (!config.agent.useTemplates) return null;

  const family = matchTemplateFamily(prompt);
  if (!family) return null;

  let template;
  try {
    template = analyzeSpec(
      autoHealSpec(buildTemplateSpec(family, extractTemplateOptions(prompt))),
    );
  } catch {
    return null;
  }
  if (!template.ok) return null;

  if ((spec?.parts ?? []).length === 0) {
    const recheck = checkCompleteness(template.spec, checklist, {
      bounds: template.model?.bounds?.size ?? null,
    });
    return {
      analysis: template,
      gaps: recheck,
      note: `Model không trả về spec dùng được — dùng nguyên mẫu thang cáp (${family}).`,
    };
  }

  const materials = (spec.materials ?? []).map((material) => ({ ...material }));
  const known = new Set(materials.map((material) => material.name));
  const existingIds = new Set((spec.parts ?? []).map((part) => part.id));
  const additions = [];
  const connectorAdditions = [];
  const roles = [];

  for (const item of gaps.missing) {
    if (item.kind === "connectors") {
      const needed = Math.max(0, Number(item.expected) - Number(item.actual));
      const pool = template.model.connectors ?? [];
      const taken = pool.slice(0, needed).map((connector, index) => ({
        ...connector,
        id: `${connector.id ?? `conn-${index + 1}`}-fix`,
      }));
      connectorAdditions.push(...taken);
      if (taken.length > 0) roles.push(`${taken.length} connector`);
      continue;
    }

    if (item.kind !== "parts") continue;
    const needed = Math.max(0, Number(item.expected) - Number(item.actual));
    if (!needed) continue;

    const matcher = matcherForKind(item.role);
    const units = new Map();
    for (const part of template.model.parts) {
      const text = String(part.name ?? "").toLowerCase();
      if (!matcher.test(text)) continue;
      const key = partUnitKey(part) || part.id;
      if (!units.has(key)) units.set(key, []);
      units.get(key).push(part);
    }

    let addedUnits = 0;
    for (const group of units.values()) {
      if (addedUnits >= needed) break;

      const fresh = group.filter((part) => !existingIds.has(`${part.id}-fix`));
      if (fresh.length === 0) continue;

      for (const part of fresh) {
        const id = `${part.id}-fix`;
        existingIds.add(id);
        additions.push({ ...part, id });

        if (part.material && !known.has(part.material)) {
          const source = (template.spec.materials ?? []).find((m) => m.name === part.material);
          if (source) {
            materials.push(source);
            known.add(source.name);
          }
        }
      }
      addedUnits += 1;
    }

    if (addedUnits > 0)
      roles.push(`${addedUnits} ${item.role === "rung" ? "bậc thang" : item.role}`);
  }

  if (additions.length === 0 && connectorAdditions.length === 0) return null;

  const merged = autoHealSpec({
    ...spec,
    materials,
    parts: [...(spec.parts ?? []), ...additions],
    connectors: [...(spec.connectors ?? []), ...connectorAdditions],
  });
  const analysis = analyzeSpec(merged);
  if (!analysis.ok) return null;

  const recheck = checkCompleteness(analysis.spec, checklist, {
    bounds: analysis.model?.bounds?.size ?? null,
  });
  if (recheck.missing.length >= gaps.missing.length) return null;

  return {
    analysis,
    gaps: recheck,
    note: `Đã bổ sung ${roles.join(", ")} còn thiếu từ mẫu thang cáp (${family}).`,
  };
}

/**
 * Try building a verified cable-ladder family template directly without calling the LLM.
 */
export function tryBuildFromTemplate({
  family,
  prompt,
  level,
  checklist,
  evidencePlan,
  startedAt,
  resultKey,
  emit,
}) {
  if (!family || !config.agent.useTemplates) return null;

  const ruleFamily = ["cross", "tee", "elbow"].includes(family) ? "cable-ladder" : family;
  const templateOptions = {
    ...resolvedToTemplateOptions(ruleFamily, evidencePlan?.resolved),
    ...extractTemplateOptions(prompt),
  };
  const template = buildTemplateSpec(family, templateOptions);
  if (!template) return null;

  const healed = autoHealSpec(template);
  fillMissingParameters(healed, checklist);
  if (evidencePlan?.resolved?.length) {
    applyResolvedValues(healed, evidencePlan.resolved, {
      allow: allowedParameterNames(evidencePlan, checklist),
    });
  }
  const analysis = analyzeSpec(healed);
  const templateBounds = analysis.model?.bounds?.size ?? null;
  const completeness = checkCompleteness(analysis.spec ?? healed, checklist, {
    bounds: templateBounds,
  });

  if (analysis.ok && completeness.ok) {
    analysis.spec.lod = level;
    emit({
      type: "stage",
      stage: "template",
      message: `Dựng từ khuôn ${family} — không cần gọi model`,
    });

    const stats = {
      ...summarise(analysis.spec, analysis.model),
      lod: level,
      attempts: 0,
      elapsedMs: Date.now() - startedAt,
      usage: null,
      tier: TIER.STRUCTURE,
      tierLabel: "template",
      model: null,
      modelCalls: 0,
      promptChars: 0,
      savedCalls: 1,
      complete: true,
      checklist,
      productType:
        evidencePlan?.rule?.productType ?? evidencePlan?.evidence?.productType ?? null,
      ruleSource: evidencePlan?.ruleSource ?? null,
      resolution: (evidencePlan?.resolved ?? []).map((entry) => ({
        name: entry.name,
        value: entry.value,
        unit: entry.unit ?? "mm",
        level: entry.level ?? 5,
        source: entry.source ?? "Giả định",
      })),
      warnings: evidencePlan?.warnings ?? [],
    };
    console.log(
      `[design] tier=2 template family=${family} calls=0 parts=${stats.parts} ` +
        `connectors=${analysis.spec.connectors?.length ?? 0}`,
    );
    if (resultKey) writeCachedResult(resultKey, { analysis, stats });
    return { analysis, stats };
  }

  console.log(
    `[design] template ${family} incomplete (${completeness.missing
      .map((item) => item.label)
      .join(", ")}) — falling back to the model`,
  );
  return null;
}
