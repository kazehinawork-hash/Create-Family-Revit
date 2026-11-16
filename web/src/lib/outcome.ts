/**
 * How a finished design run is worded, and what a failure advises. Pure functions so
 * every branch is testable without React; the caller passes the active dictionary.
 */
import { vi, type Strings } from "./strings";

type OutcomeCopy = Pick<
  Strings,
  | "appOutcomeUnchanged"
  | "appOutcomeBuiltErrors"
  | "appOutcomeIncomplete"
  | "appOutcomeCreated"
  | "appOutcomeUpdated"
>;

type AdviceCopy = Pick<
  Strings,
  | "appAdviceAuth"
  | "appAdviceOverloaded"
  | "appAdviceNetwork"
  | "appAdviceTimeout"
  | "appAdviceOutputLimit"
  | "appAdviceInvalidRequest"
  | "appAdviceUnknown"
>;

export type DesignOutcome = "ok" | "incomplete" | "has-errors" | "unchanged";

export interface OutcomeSource {
  stats?: {
    complete?: boolean;
    missing?: string[];
    unchanged?: boolean;
    warnings?: string[];
    name?: string;
  } | null;
  analysis?: {
    ok?: boolean;
    spec?: { name?: string } | null;
    errors?: Array<{ message?: string } | string>;
  } | null;
}

export interface OutcomeMessage {
  outcome: DesignOutcome;
  tone: "normal" | "warning" | "error";
  title: string;
  /** Bullets shown under the title (missing parts, error list, reason). */
  items: string[];
}

export function designOutcomeOf({ stats, analysis }: OutcomeSource): DesignOutcome {
  if (stats?.unchanged) return "unchanged";
  if (analysis && analysis.ok === false) return "has-errors";
  if (stats?.complete === false) return "incomplete";
  return "ok";
}

export function describeOutcome(
  { stats, analysis }: OutcomeSource,
  { updated = false }: { updated?: boolean } = {},
  strings: OutcomeCopy = vi,
): OutcomeMessage {
  const outcome = designOutcomeOf({ stats, analysis });
  const name = analysis?.spec?.name || stats?.name || "family";

  if (outcome === "unchanged") {
    return {
      outcome,
      tone: "error",
      title: strings.appOutcomeUnchanged,
      // The reason is listed once, in the warnings box.
      items: [],
    };
  }

  if (outcome === "has-errors") {
    const errors = analysis?.errors ?? [];
    return {
      outcome,
      tone: "error",
      title: strings.appOutcomeBuiltErrors(name, errors.length),
      // The clickable issue list is rendered from `issues`, not repeated here.
      items: [],
    };
  }

  if (outcome === "incomplete") {
    return {
      outcome,
      tone: "warning",
      title: strings.appOutcomeIncomplete(name),
      items: stats?.missing ?? [],
    };
  }

  return {
    outcome,
    tone: "normal",
    title: updated ? strings.appOutcomeUpdated(name) : strings.appOutcomeCreated(name),
    items: [],
  };
}

export type ErrorKind =
  | "auth"
  | "overloaded"
  | "network"
  | "timeout"
  | "output-limit"
  | "invalid-request"
  | "unknown"
  | string;

export interface ErrorAdvice {
  hint: string;
  /** What the studio should offer next. */
  action: "retry" | "open-api" | null;
}

export function errorAdvice(kind?: ErrorKind | null, strings: AdviceCopy = vi): ErrorAdvice {
  switch (kind) {
    case "auth":
      return { hint: strings.appAdviceAuth, action: "open-api" };
    case "overloaded":
      return { hint: strings.appAdviceOverloaded, action: "retry" };
    case "network":
      return { hint: strings.appAdviceNetwork, action: "retry" };
    case "timeout":
      return { hint: strings.appAdviceTimeout, action: "retry" };
    case "output-limit":
      return { hint: strings.appAdviceOutputLimit, action: "retry" };
    case "invalid-request":
      return { hint: strings.appAdviceInvalidRequest, action: null };
    default:
      return { hint: strings.appAdviceUnknown, action: "retry" };
  }
}

/**
 * Long provider messages are unreadable in a chat bubble: keep one short sentence and
 * push the rest into the "Chi tiết lỗi" block.
 */
export function splitErrorMessage(message: string, limit = 200): { text: string; details?: string } {
  const raw = String(message ?? "").trim();
  if (raw.length <= limit) return { text: raw };

  const firstSentence = raw.split(/(?<=[.!?…])\s+/)[0] ?? raw;
  const summary = firstSentence.length <= limit ? firstSentence : `${raw.slice(0, limit - 1)}…`;
  return { text: summary, details: raw };
}
