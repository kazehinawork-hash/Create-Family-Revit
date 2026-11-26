import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { migrateSpec, type FamilySpec } from "@family/spec-core";
import type { ChatTarget } from "../lib/annotations";
import {
  fetchDesignJob,
  fetchSavedModelDetail,
  pingServer,
  streamDesign,
  type DesignJob,
  type DesignStats,
  type UploadedDocument,
} from "../lib/api";
import { isModelId } from "../lib/api-key";
import { useI18n } from "../lib/i18n";
import { errorAdvice, splitErrorMessage } from "../lib/outcome";
import { translateServerMessage } from "../lib/server-messages";
import { useStudio } from "./StudioContext";
import {
  buildDesignResultEntry,
  mergeSessionUsage,
  type DesignOutcomeKind,
} from "./designResultBuilder";
import type { StageState } from "./types";

type SendPromptFn = (
  text: string,
  specOverride?: FamilySpec,
  sendOptions?: { fresh?: boolean; targets?: ChatTarget[]; noteIds?: string[] },
) => Promise<void>;

async function waitForDesignJob(
  jobId: string,
  signal: AbortSignal,
): Promise<DesignJob | "missing" | "timeout"> {
  const deadline = Date.now() + 10 * 60 * 1000;

  while (Date.now() < deadline) {
    if (signal.aborted) return "timeout";

    let job: DesignJob | null | undefined;
    try {
      job = await fetchDesignJob(jobId);
    } catch {
      job = undefined;
    }

    if (job === null) return "missing";
    if (job && job.status !== "running") return job;

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  return "timeout";
}

function readCustomApiConfig(model: string) {
  if (model !== "custom:api") return undefined;
  try {
    const raw = localStorage.getItem("custom_api_config");
    if (!raw) return undefined;
    const config = JSON.parse(raw);
    if (config?.model && !isModelId(config.model)) config.model = "";
    return config;
  } catch {
    return undefined;
  }
}

function readCommandCodeApiKey() {
  try {
    return localStorage.getItem("command_code_api_key") || undefined;
  } catch {
    return undefined;
  }
}

interface UseDesignJobRunnerOptions {
  setServerOnline: Dispatch<SetStateAction<boolean | null>>;
}

export function useDesignJobRunner({ setServerOnline }: UseDesignJobRunnerOptions) {
  const { t, formatDate, formatNumber, language } = useI18n();
  const { state, dispatch } = useStudio();
  const { spec, chatTargets, model, lod } = state;

  const [stage, setStage] = useState<StageState | null>(null);
  const [running, setRunning] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sessionUsage, setSessionUsage] = useState<Record<string, number>>({});
  const [incomplete, setIncomplete] = useState<string[] | null>(null);
  const [lastBeatAt, setLastBeatAt] = useState<number | null>(null);
  void lastBeatAt;

  const abortRef = useRef<AbortController | null>(null);
  const lastPromptRef = useRef("");
  const lastTargetsRef = useRef<ChatTarget[]>([]);
  const lastNoteIdsRef = useRef<string[]>([]);
  const pendingNoteIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const elapsed = runStartedAt ? Math.max(0, Math.floor((now - runStartedAt) / 1000)) : 0;
  const elapsedLabel =
    running && runStartedAt
      ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`
      : null;

  const beginSimulation = (startTime = Date.now()) => {
    setRunning(true);
    setRunStartedAt(startTime);
    setNow(startTime);
  };

  const endSimulation = () => {
    setRunning(false);
    setRunStartedAt(null);
    setStage(null);
  };

  const runDesign = async (
    text: string,
    docs: UploadedDocument[],
    onDone: () => void,
    specOverride?: FamilySpec,
    sendOptions?: { fresh?: boolean; targets?: ChatTarget[]; noteIds?: string[] },
  ) => {
    lastPromptRef.current = text;
    const baseSpec = specOverride ?? spec;
    const hadSpec = Boolean(baseSpec);
    const outgoingTargets = sendOptions?.targets ?? chatTargets;
    const outgoingNoteIds = sendOptions?.noteIds ?? [];
    if (!baseSpec) {
      dispatch({ type: "CLEAR_NOTES" });
    }
    lastTargetsRef.current = outgoingTargets;
    lastNoteIdsRef.current = outgoingNoteIds;
    pendingNoteIdsRef.current = outgoingNoteIds;
    dispatch({
      type: "PUSH_ENTRY",
      entry: {
        role: "user",
        text,
        attachments: docs.length > 0 ? docs : undefined,
        targets: outgoingTargets.length > 0 ? outgoingTargets : undefined,
      },
    });
    dispatch({ type: "SET_CHAT_TARGETS", targets: [] });
    setRunning(true);
    setRunStartedAt(Date.now());
    setNow(Date.now());
    setStage({
      stage: "thinking",
      message: docs.length > 0 ? t.appStageReadingAttachments : t.appStageReadingRequest,
    });

    let failed = false;
    let stalled = false;
    let receivedSpec = false;
    let jobId: string | null = null;
    let lastBeat = Date.now();

    const controller = new AbortController();
    abortRef.current = controller;
    setLastBeatAt(Date.now());

    const watchdog = window.setInterval(() => {
      if (Date.now() - lastBeat > 900000 && !controller.signal.aborted) {
        stalled = true;
        controller.abort();
      }
    }, 5000);

    const applyResult = (
      specValue: FamilySpec,
      stats: DesignStats,
      prefix = "",
      outcome: DesignOutcomeKind = null,
      errors: Array<{ message?: string } | string> = [],
      previousSpec: FamilySpec | null = null,
    ) => {
      const built = buildDesignResultEntry({
        specValue,
        stats,
        previousSpec,
        hadSpec,
        prefix,
        outcome,
        errors,
        t,
        formatDate,
      });

      const resolvedNoteIds =
        built.resolvedOk && pendingNoteIdsRef.current.length > 0
          ? [...pendingNoteIdsRef.current]
          : undefined;
      if (resolvedNoteIds) {
        pendingNoteIdsRef.current = [];
        lastNoteIdsRef.current = [];
      }

      setIncomplete(built.incomplete);
      setSessionUsage((current) => mergeSessionUsage(current, stats));
      dispatch({
        type: "APPLY_DESIGN_RESULT",
        spec: specValue,
        resolvedNoteIds,
        entry: built.entry,
      });
    };

    try {
      await streamDesign(
        {
          prompt: text,
          spec: baseSpec,
          lod,
          model: model || undefined,
          fresh: sendOptions?.fresh || undefined,
          language,
          customApiConfig: readCustomApiConfig(model),
          commandCodeApiKey: readCommandCodeApiKey(),
          attachments:
            docs.length > 0 ? docs.map((d) => ({ path: d.path, name: d.name })) : undefined,
          targets: outgoingTargets.length > 0 ? outgoingTargets : undefined,
        },
        (event) => {
          if (event.type === "job") {
            jobId = event.jobId;
            return;
          }

          if (event.type === "suggestion") {
            dispatch({
              type: "PUSH_ENTRY",
              entry: {
                role: "agent",
                text: t.appSimilarSaved(
                  event.sample.name,
                  formatNumber(Math.round(event.sample.score * 100)),
                ),
                action: {
                  label: t.appSimilarSavedAction,
                  kind: "use-sample",
                  sampleId: event.sample.id,
                },
              },
            });
            return;
          }

          if (event.type === "stage") {
            setStage({
              stage: event.stage,
              message: translateServerMessage(language, event.code, event.params, event.message),
              issues: event.issues,
            });
            return;
          }

          if (event.type === "error") {
            failed = true;
            setStage(null);
            const advice = errorAdvice(event.kind, t);
            const shown = translateServerMessage(language, event.code, event.params, event.message);
            const { text: errText, details } = splitErrorMessage(shown);
            dispatch({
              type: "PUSH_ENTRY",
              entry: {
                role: "agent",
                tone: "error",
                text: `⛔ ${errText}\n${advice.hint}`,
                details:
                  [event.details, event.message !== shown ? event.message : details]
                    .filter(Boolean)
                    .join("\n\n") || undefined,
                action:
                  advice.action === "retry"
                    ? { label: t.appResend }
                    : advice.action === "open-api"
                      ? { label: t.appOpenApiConfig, kind: "open-api" }
                      : undefined,
              },
            });
            return;
          }

          const { stats } = event;
          if (stats.step?.partial) {
            dispatch({ type: "APPLY_SPEC", spec: event.spec, native: false });
            setStage({
              stage: "step",
              message: t.appStepProgress(
                stats.step.label,
                formatNumber(stats.step.index + 1),
                formatNumber(stats.step.total),
              ),
            });
            return;
          }

          receivedSpec = true;
          applyResult(event.spec, stats, "", event.outcome ?? null, event.errors ?? [], baseSpec);
        },
        controller.signal,
        () => {
          lastBeat = Date.now();
          setLastBeatAt(lastBeat);
        },
      );

      if (!receivedSpec && !stalled && jobId && !failed) {
        setStage({ stage: "recovering", message: t.appStageRecovering });
        const recovered = await waitForDesignJob(jobId, controller.signal);

        if (recovered === "missing") {
          setStage(null);
          dispatch({
            type: "PUSH_ENTRY",
            entry: {
              role: "agent",
              tone: "error",
              text: t.appErrorJobLost,
              action: { label: t.appResend },
            },
          });
        } else if (recovered === "timeout") {
          setStage(null);
          dispatch({
            type: "PUSH_ENTRY",
            entry: {
              role: "agent",
              tone: "error",
              text: t.appErrorJobTimeout,
              action: { label: t.appResend },
            },
          });
        } else if (recovered.spec) {
          receivedSpec = true;
          setStage(null);
          applyResult(
            recovered.spec,
            recovered.stats ?? {
              parameters: recovered.spec.parameters?.length ?? 0,
              parts: recovered.spec.parts?.length ?? 0,
              instances: recovered.spec.parts?.length ?? 0,
              materials: recovered.spec.materials?.length ?? 0,
              bounds: null,
              attempts: 0,
              elapsedMs: 0,
            },
            t.appRecoveredPrefix,
            null,
            [],
            baseSpec,
          );
        } else {
          setStage(null);
          const stored = translateServerMessage(
            language,
            recovered.code ?? undefined,
            {},
            recovered.error ?? t.appUnknownReason,
          );
          const { text: errText, details } = splitErrorMessage(stored);
          dispatch({
            type: "PUSH_ENTRY",
            entry: {
              role: "agent",
              tone: "error",
              text: t.appErrorJobFailed(errText, errorAdvice("unknown", t).hint),
              details,
              action: { label: t.appResend },
            },
          });
        }
      } else if (!receivedSpec && !stalled && !failed) {
        failed = true;
        dispatch({
          type: "PUSH_ENTRY",
          entry: {
            role: "agent",
            text: t.appErrorClosedNoSpec,
            tone: "error",
            action: { label: t.appResend },
          },
        });
      }
    } catch (error) {
      if (stalled) {
        failed = true;
        dispatch({
          type: "PUSH_ENTRY",
          entry: {
            role: "agent",
            text: t.appErrorNoResponse,
            tone: "error",
            action: { label: t.appResend },
          },
        });
      } else if (error instanceof Error && error.name === "AbortError") {
        dispatch({ type: "PUSH_ENTRY", entry: { role: "agent", text: t.appStopped } });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const { text: errText, details } = splitErrorMessage(message);
        dispatch({
          type: "PUSH_ENTRY",
          entry: {
            role: "agent",
            tone: "error",
            text: `⛔ ${errText}\n${errorAdvice(null, t).hint}`,
            details,
            action: { label: t.appResend },
          },
        });
        void pingServer().then((ping) => setServerOnline(Boolean(ping?.ok)));
      }
    } finally {
      window.clearInterval(watchdog);
      abortRef.current = null;
      setRunning(false);
      setRunStartedAt(null);
      onDone();
      if (!failed) setStage(null);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleRetryLast = (sendPrompt: SendPromptFn) => {
    if (!lastPromptRef.current) return;
    void sendPrompt(lastPromptRef.current, undefined, {
      targets: lastTargetsRef.current,
      noteIds: lastNoteIdsRef.current,
    });
  };

  const handleEntryAction = (
    action: { kind?: string; sampleId?: string },
    sendPrompt: SendPromptFn,
  ) => {
    if (action.kind === "fresh") {
      if (!lastPromptRef.current) return;
      void sendPrompt(lastPromptRef.current, undefined, {
        fresh: true,
        targets: lastTargetsRef.current,
        noteIds: lastNoteIdsRef.current,
      });
      return;
    }
    if (action.kind === "use-sample" && action.sampleId) {
      void (async () => {
        const loaded = await fetchSavedModelDetail(action.sampleId!);
        const rawSample = loaded?.spec ?? null;
        if (!rawSample) return;
        const sampleSpec = migrateSpec(rawSample).spec as unknown as FamilySpec;
        dispatch({ type: "APPLY_SPEC", spec: sampleSpec });
        void sendPrompt(lastPromptRef.current, sampleSpec);
      })();
      return;
    }
    if (lastPromptRef.current) void sendPrompt(lastPromptRef.current);
  };

  return {
    stage,
    setStage,
    running,
    elapsedLabel,
    sessionUsage,
    incomplete,
    beginSimulation,
    endSimulation,
    runDesign,
    handleStop,
    handleRetryLast,
    handleEntryAction,
  };
}
