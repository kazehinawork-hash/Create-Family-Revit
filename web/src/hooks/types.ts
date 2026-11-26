import type { FamilyParameter, Issue, MaterialDef, ResolvedModel } from "@family/spec-core";
import type { Strings } from "../lib/strings";

export interface StageState {
  stage: string;
  message: string;
  issues?: Issue[];
}

export interface ToastState {
  text: string;
  sub?: string;
  tone: "ok" | "warn" | "error";
  /** Optional action shown inside the toast (e.g. "Hoàn tác" after a delete). */
  action?: { label: string; onClick: () => void };
}

/** One saved model rendered offscreen to fill a missing library thumbnail. */
export interface ThumbJob {
  id: string;
  model: ResolvedModel;
  parameters: FamilyParameter[];
  materials: MaterialDef[];
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Run durations carry unit labels ("12 s", "3 min 04 s"), so they follow the active
 * language. Numbers leave the formatter as strings: dictionaries never format.
 */
export function durationText(ms: number, t: Strings): string {
  if (!Number.isFinite(ms) || ms < 0) return t.appDurationUnknown;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return t.appDurationSeconds(String(totalSeconds));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return t.appDurationMinutes(String(minutes), String(seconds).padStart(2, "0"));
}
