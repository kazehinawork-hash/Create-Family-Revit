import type { FamilySpec } from "@family/spec-core";
import type { ChatEntry } from "../components/ChatPanel";
import type { DesignStats } from "../lib/api";
import { describeOutcome } from "../lib/outcome";
import { diffNotes, diffSpecs } from "../lib/spec-diff";
import type { Strings } from "../lib/strings";
import { durationText } from "./types";

export type DesignOutcomeKind = "ok" | "incomplete" | "has-errors" | "unchanged" | null;

export interface BuildDesignResultInput {
  specValue: FamilySpec;
  stats: DesignStats;
  previousSpec: FamilySpec | null;
  hadSpec: boolean;
  prefix?: string;
  outcome?: DesignOutcomeKind;
  errors?: Array<{ message?: string } | string>;
  t: Strings;
  formatDate: (date: number | Date, options?: Intl.DateTimeFormatOptions) => string;
}

export interface BuiltDesignResult {
  entry: Omit<ChatEntry, "id">;
  resolvedOk: boolean;
  incomplete: string[] | null;
}

export function buildDesignResultEntry({
  specValue,
  stats,
  previousSpec,
  hadSpec,
  prefix = "",
  outcome = null,
  errors = [],
  t,
  formatDate,
}: BuildDesignResultInput): BuiltDesignResult {
  const fast = stats.fastEdit;
  const diff = diffSpecs(previousSpec, specValue);
  const notes = diffNotes(previousSpec?.notes, specValue.notes);
  const isIncomplete = stats.complete === false || outcome === "incomplete";
  const warningList = (stats.warnings as string[] | undefined) ?? [];
  const missing = isIncomplete ? (stats.missing ?? [t.appMissingUnknown]) : undefined;

  const copy = describeOutcome(
    {
      stats,
      analysis: {
        ok: outcome ? outcome !== "has-errors" : undefined,
        spec: specValue,
        errors,
      },
    },
    { updated: hadSpec },
    t,
  );
  const errorList = copy.outcome === "has-errors" ? (errors as never[]) : [];

  const changedNames = [
    ...diff.parts.map((part) => part.name),
    ...diff.parameters.map((parameter) => parameter.name),
  ].slice(0, 3);
  const answer =
    notes.answer ??
    (changedNames.length > 0
      ? previousSpec
        ? t.chatFallbackChanged(changedNames.join(", "))
        : t.chatFallbackCreated(changedNames.join(", "))
      : copy.title);

  const inChars = (stats.calls ?? []).reduce(
    (total, call) => total + (call.inChars ?? call.promptChars ?? 0),
    0,
  );
  const outChars = (stats.calls ?? []).reduce((total, call) => total + (call.outChars ?? 0), 0);
  const calls = stats.modelCalls ?? stats.calls?.length ?? 0;
  const usedModel = stats.model ?? stats.calls?.[0]?.model;
  const cachedAt = stats.cachedAt
    ? formatDate(stats.cachedAt, { hour: "2-digit", minute: "2-digit" })
    : "--:--";

  const metaInfo: ChatEntry["metaInfo"] = fast
    ? {
        elapsed: durationText(stats.elapsedMs, t),
        inChars,
        outChars,
        local: true,
      }
    : stats.cached
      ? {
          elapsed: durationText(stats.elapsedMs, t),
          model: usedModel,
          calls,
          inChars,
          outChars,
          cached: t.cachedResult(cachedAt),
        }
      : {
          elapsed: durationText(stats.elapsedMs, t),
          model: usedModel,
          calls,
          inChars,
          outChars,
        };

  return {
    resolvedOk: copy.outcome === "ok",
    incomplete: missing ?? null,
    entry: {
      role: "agent",
      tone: copy.tone === "normal" ? "normal" : "error",
      text: `${prefix}${answer}`,
      warnings: warningList.length > 0 ? warningList : undefined,
      notes: notes.fresh.length > 0 ? notes.fresh : undefined,
      oldNotes: notes.old.length > 0 ? notes.old : undefined,
      changes: diff,
      check: {
        ok: errorList.length === 0 && warningList.length === 0 && !missing?.length,
        errors: errorList.length,
        warnings: warningList.length,
        missing,
      },
      undoSpec: previousSpec,
      issues: errorList,
      action: stats.cached
        ? { label: t.runFresh, kind: "fresh" as const }
        : copy.outcome === "unchanged"
          ? { label: t.appResend }
          : undefined,
      resolution: Array.isArray(stats.resolution)
        ? (stats.resolution as {
            name: string;
            value: unknown;
            level?: number;
            source?: string;
          }[])
        : undefined,
      metaInfo,
    },
  };
}

export function mergeSessionUsage(
  current: Record<string, number>,
  stats: DesignStats,
): Record<string, number> {
  const callRows = stats.calls?.length
    ? stats.calls
    : stats.model
      ? [{ model: stats.model, modelCalls: stats.modelCalls ?? 1 }]
      : [];
  if (callRows.length === 0) return current;

  const next = { ...current };
  for (const call of callRows) {
    if (!call.model) continue;
    next[call.model] = (next[call.model] ?? 0) + (call.modelCalls ?? 1);
  }
  return next;
}
