import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { migrateSpec, validateSpec, type FamilySpec } from "@family/spec-core";
import type { ChatTarget, ModelNote } from "../lib/annotations";
import { targetFromNote } from "../lib/annotations";
import {
  fetchDesignJob,
  fetchLatestExternalSpec,
  fetchSavedModelDetail,
  pingServer,
  streamDesign,
  subscribeExternalSpecStream,
  uploadDocument,
  type DesignJob,
  type DesignStats,
  type ExternalSpecPayload,
  type Lod,
  type UploadedDocument,
} from "../lib/api";
import { isModelId } from "../lib/api-key";
import { useI18n } from "../lib/i18n";
import { describeOutcome, errorAdvice, splitErrorMessage } from "../lib/outcome";
import { translateServerMessage } from "../lib/server-messages";
import { diffNotes, diffSpecs } from "../lib/spec-diff";
import { useStudio } from "./StudioContext";
import { durationText, type StageState, type ToastState } from "./types";

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

interface UseDesignChatOptions {
  setServerOnline: Dispatch<SetStateAction<boolean | null>>;
  setToast: Dispatch<SetStateAction<ToastState | null>>;
  setMobileTab: Dispatch<SetStateAction<"chat" | "viewer" | "params">>;
}

export function useDesignChat({
  setServerOnline,
  setToast,
  setMobileTab,
}: UseDesignChatOptions) {
  const { t, formatDate, formatNumber, language } = useI18n();
  const { state, dispatch } = useStudio();
  const { spec, modelNotes, chatTargets, chatFocusSignal, model, lod } = state;

  const [stage, setStage] = useState<StageState | null>(null);
  const [running, setRunning] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sessionUsage, setSessionUsage] = useState<Record<string, number>>({});
  const [incomplete, setIncomplete] = useState<string[] | null>(null);
  const [attachments, setAttachments] = useState<UploadedDocument[]>([]);
  const [uploading, setUploading] = useState(false);
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

  // Real-time synchronization with MCP / External Agents
  const lastExternalHashRef = useRef<string>("");
  const liveRef = useRef({ t, formatNumber, dispatch, setToast });
  liveRef.current = { t, formatNumber, dispatch, setToast };

  useEffect(() => {
    let alive = true;

    const handleExternalSpec = (data: ExternalSpecPayload) => {
      if (!alive || !data || !data.spec || !data.spec_hash) return;
      if (data.spec_hash === lastExternalHashRef.current) return;

      const {
        t: strings,
        formatNumber: fmtNum,
        dispatch: emit,
        setToast: showToast,
      } = liveRef.current;
      lastExternalHashRef.current = data.spec_hash;

      const partsCount = data.geometry_summary?.parts_count ?? (data.spec.parts?.length || 0);
      const paramsCount =
        data.geometry_summary?.parameters_count ?? (data.spec.parameters?.length || 0);
      const bounds = data.geometry_summary?.bounds;
      const dims = bounds
        ? ` · ${fmtNum(bounds.x)} × ${fmtNum(bounds.y)} × ${fmtNum(bounds.z)} mm`
        : "";
      const summary = strings.appPartsParams(fmtNum(partsCount), fmtNum(paramsCount));

      emit({
        type: "APPLY_DESIGN_RESULT",
        spec: data.spec,
        entry: {
          role: "agent",
          text: strings.appMcpSpecReceived(data.spec.name || "Family", `${summary}${dims}`),
          notes: data.spec.notes,
          meta: "⚡ MCP Real-time Sync",
          issues: (data.warnings || []).map((w) => ({
            message: w,
            severity: "warning",
            path: "spec",
          })),
        },
      });

      showToast({
        text: strings.appMcpLoadedTitle(data.spec.name || "Family"),
        sub: strings.appMcpLoadedSub(summary),
        tone: "ok",
      });
    };

    void fetchLatestExternalSpec().then((latest) => {
      if (alive && latest && latest.spec && latest.spec_hash) {
        handleExternalSpec(latest);
      }
    });

    const unsubscribe = subscribeExternalSpecStream(handleExternalSpec);

    const pollInterval = window.setInterval(async () => {
      if (!alive) return;
      const latest = await fetchLatestExternalSpec();
      if (alive && latest && latest.spec && latest.spec_hash) {
        handleExternalSpec(latest);
      }
    }, 2500);

    return () => {
      alive = false;
      unsubscribe();
      window.clearInterval(pollInterval);
    };
  }, []);

  const handleAttach = async (files: File[]) => {
    setUploading(true);
    try {
      const uploaded: UploadedDocument[] = [];
      for (const file of files) {
        const document = await uploadDocument(file);
        uploaded.push(document);
      }
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      dispatch({
        type: "PUSH_ENTRY",
        entry: {
          role: "agent",
          text: t.appAttachFailed(error instanceof Error ? error.message : String(error)),
          tone: "error",
        },
      });
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((current) => current.filter((_, idx) => idx !== index));
  };

  const handleModel = useCallback(
    (value: string) => {
      dispatch({ type: "SET_MODEL", model: value });
    },
    [dispatch],
  );

  const syncDefaultModel = useCallback(
    (availableIds: string[], serverDefaultModel?: string | null) => {
      dispatch({ type: "SYNC_DEFAULT_MODEL", availableIds, serverDefaultModel });
    },
    [dispatch],
  );

  const handleLod = (value: Lod) => {
    dispatch({ type: "SET_LOD", lod: value });
    if (spec) {
      setToast({
        text: t.appLodSelected(formatNumber(value)),
        sub: t.appLodSelectedSub,
        tone: "ok",
      });
    }
  };

  const handleSend = async (
    text: string,
    specOverride?: FamilySpec,
    sendOptions?: { fresh?: boolean; targets?: ChatTarget[]; noteIds?: string[] },
  ) => {
    if (running || uploading) return;
    lastPromptRef.current = text;
    const baseSpec = specOverride ?? spec;
    const hadSpec = Boolean(baseSpec);
    const docs = attachments;
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

    const buildAndApplyResult = (
      specValue: FamilySpec,
      stats: DesignStats,
      prefix = "",
      outcome: "ok" | "incomplete" | "has-errors" | "unchanged" | null = null,
      errors: Array<{ message?: string } | string> = [],
      previousSpec: FamilySpec | null = null,
    ) => {
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

      const resolvedNoteIds =
        copy.outcome === "ok" && pendingNoteIdsRef.current.length > 0
          ? [...pendingNoteIdsRef.current]
          : undefined;
      if (resolvedNoteIds) {
        pendingNoteIdsRef.current = [];
        lastNoteIdsRef.current = [];
      }

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

      setIncomplete(isIncomplete ? (stats.missing ?? [t.appMissingUnknown]) : null);

      setSessionUsage((current) => {
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
      });

      dispatch({
        type: "APPLY_DESIGN_RESULT",
        spec: specValue,
        resolvedNoteIds,
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
          metaInfo: fast
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
                },
        },
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
          customApiConfig:
            model === "custom:api"
              ? (() => {
                  try {
                    const raw = localStorage.getItem("custom_api_config");
                    if (!raw) return undefined;
                    const config = JSON.parse(raw);
                    if (config?.model && !isModelId(config.model)) config.model = "";
                    return config;
                  } catch {
                    return undefined;
                  }
                })()
              : undefined,
          commandCodeApiKey: (() => {
            try {
              return localStorage.getItem("command_code_api_key") || undefined;
            } catch {
              return undefined;
            }
          })(),
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
          buildAndApplyResult(
            event.spec,
            stats,
            "",
            event.outcome ?? null,
            event.errors ?? [],
            baseSpec,
          );
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
          buildAndApplyResult(
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
      setAttachments([]);
      if (!failed) setStage(null);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleSendPartsToChat = (incoming: ChatTarget[]) => {
    dispatch({ type: "ADD_CHAT_TARGETS", targets: incoming });
    setMobileTab("chat");
  };

  const handleRemoveTarget = (index: number) => {
    dispatch({ type: "REMOVE_CHAT_TARGET", index });
  };

  const handleUndoSpecEntry = (snapshot: FamilySpec | null) => {
    dispatch({ type: "APPLY_SPEC", spec: snapshot, native: false });
  };

  const handleRetryLast = () => {
    if (!lastPromptRef.current) return;
    void handleSend(lastPromptRef.current, undefined, {
      targets: lastTargetsRef.current,
      noteIds: lastNoteIdsRef.current,
    });
  };

  const handleEntryAction = (action: { kind?: string; sampleId?: string }) => {
    if (action.kind === "fresh") {
      if (!lastPromptRef.current) return;
      void handleSend(lastPromptRef.current, undefined, {
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
        void handleSend(lastPromptRef.current, sampleSpec);
      })();
      return;
    }
    if (lastPromptRef.current) void handleSend(lastPromptRef.current);
  };

  const handleLoadSampleChat = () => {
    if (running) return;
    void handleSend(t.chatSuggestion1);
  };

  const sendNotesToAgent = (notes: ModelNote[]) => {
    if (notes.length === 0 || running) return;
    const text =
      notes.length === 1
        ? t.appSendNotePrompt(notes[0].text)
        : t.appSendAllNotesPrompt(formatNumber(notes.length));
    void handleSend(text, undefined, {
      targets: notes.map(targetFromNote),
      noteIds: notes.map((note) => note.id),
    });
    setMobileTab("chat");
  };

  const handleSendNote = (note: ModelNote) => sendNotesToAgent([note]);

  const handleSendAllNotes = () => {
    sendNotesToAgent(modelNotes.filter((note) => note.status !== "resolved"));
  };

  const handleLoadDemo = async (key: "fcu" | "pump" | "elbow" | "ystrainer" | "ystrainer-tube") => {
    let demoRaw: unknown = null;
    let userPromptText = "";
    if (key === "fcu") {
      demoRaw = (await import("../../../spec/examples/fcu-080.json")).default;
      userPromptText = t.appDemoPromptFcu;
    } else if (key === "pump") {
      demoRaw = (await import("../../../spec/examples/pump-dn80.json")).default;
      userPromptText = t.appDemoPromptPump;
    } else if (key === "ystrainer") {
      demoRaw = (await import("../../../spec/examples/ystrainer-dn80.json")).default;
      userPromptText = t.appDemoPromptYStrainer;
    } else if (key === "ystrainer-tube") {
      demoRaw = (await import("../../../spec/examples/ystrainer-tube.json")).default;
      userPromptText = t.appDemoPromptYStrainerTube;
    } else if (key === "elbow") {
      userPromptText = t.appDemoPromptElbow;
      demoRaw = {
        schemaVersion: "1.0",
        name: "Threaded 90 Deg Duct Elbow DN50",
        typeName: "Elbow 90 DN50",
        category: "Duct Elbow",
        units: "mm",
        description: "90 degree threaded elbow DN50 with end bands and connectors",
        parameters: [
          { name: "Nominal Diameter", type: "Length", group: "Dimensions", value: 50 },
          { name: "Center Radius", type: "Length", group: "Dimensions", value: 57 },
          { name: "Body OD", type: "Length", group: "Dimensions", value: 68 },
          { name: "Band OD", type: "Length", group: "Dimensions", value: 76.5 },
          { name: "Band Length", type: "Length", group: "Dimensions", value: 12 },
          { name: "Takeoff Length", type: "Length", group: "Dimensions", value: 69 },
        ],
        materials: [
          { name: "Cast Iron", color: "#61676c", roughness: 0.65, metalness: 0.4 },
          { name: "Galvanized Trim", color: "#9aa1a6", roughness: 0.45, metalness: 0.5 },
        ],
        parts: [
          {
            id: "elbow-body",
            name: "Elbow Center Body",
            material: "Cast Iron",
            solid: {
              kind: "cylinder",
              axis: "z",
              base: { x: 0, y: 0, z: -34 },
              radius: "[Body OD] / 2",
              height: 68,
            },
          },
          {
            id: "flange-port-1",
            name: "End Band Port 1 (+X)",
            material: "Galvanized Trim",
            solid: {
              kind: "cylinder",
              axis: "x",
              base: { x: "[Center Radius]", y: 0, z: 0 },
              radius: "[Band OD] / 2",
              height: 12,
            },
          },
          {
            id: "flange-port-2",
            name: "End Band Port 2 (-Y)",
            material: "Galvanized Trim",
            solid: {
              kind: "cylinder",
              axis: "y",
              base: { x: 0, y: "-[Center Radius]", z: 0 },
              radius: "[Band OD] / 2",
              height: -12,
            },
          },
        ],
        connectors: [
          {
            id: "conn-1",
            name: "Connector 1",
            systemType: "SupplyAir",
            shape: "round",
            direction: "out",
            origin: { x: 69, y: 0, z: 0 },
            directionVector: { x: 1, y: 0, z: 0 },
            diameter: 50,
          },
          {
            id: "conn-2",
            name: "Connector 2",
            systemType: "SupplyAir",
            shape: "round",
            direction: "in",
            origin: { x: 0, y: -69, z: 0 },
            directionVector: { x: 0, y: -1, z: 0 },
            diameter: 50,
          },
        ],
      };
    }

    if (!demoRaw) return;
    const parsed = validateSpec(demoRaw).spec;

    dispatch({
      type: "START_DEMO_BUILD",
      userEntry: { role: "user", text: userPromptText },
    });
    setRunning(true);
    const startSimTime = Date.now();
    setRunStartedAt(startSimTime);
    setNow(startSimTime);
    setStage({ stage: "reading", message: t.appDemoStageReading });

    setTimeout(() => {
      setStage({ stage: "thinking", message: t.appDemoStageThinking });
    }, 700);

    const allParts = parsed.parts || [];
    const baseDelay = 1500;
    const partStep = 450;

    setTimeout(() => {
      setStage({
        stage: "generating",
        message: t.appDemoBuildStep(
          allParts[0]?.name || t.appDemoMainFrame,
          formatNumber(1),
          formatNumber(allParts.length),
        ),
      });
      dispatch({
        type: "APPLY_SPEC",
        spec: { ...parsed, parts: allParts.slice(0, 1), connectors: [] },
        record: false,
      });
    }, baseDelay);

    for (let i = 2; i <= allParts.length; i++) {
      setTimeout(
        () => {
          setStage({
            stage: "generating",
            message: t.appDemoBuildStep(
              allParts[i - 1]?.name || t.appDemoPartFallback(formatNumber(i)),
              formatNumber(i),
              formatNumber(allParts.length),
            ),
          });
          dispatch({
            type: "APPLY_SPEC",
            spec: {
              ...parsed,
              parts: allParts.slice(0, i),
              connectors: i === allParts.length ? parsed.connectors : [],
            },
            record: false,
          });
        },
        baseDelay + (i - 1) * partStep,
      );
    }

    const totalBuildTime = baseDelay + allParts.length * partStep;

    setTimeout(() => {
      setStage({ stage: "checking", message: t.appDemoStageChecking });
    }, totalBuildTime + 200);

    setTimeout(() => {
      setRunning(false);
      setRunStartedAt(null);
      setStage(null);
      dispatch({
        type: "APPLY_SPEC",
        spec: parsed,
        record: false,
      });

      const partCount = parsed.parts?.length ?? 0;
      const paramCount = parsed.parameters?.length ?? 0;
      dispatch({
        type: "PUSH_ENTRY",
        entry: {
          role: "agent",
          text: t.appDemoDone(parsed.name, formatNumber(partCount), formatNumber(paramCount)),
          notes: Array.isArray(parsed.notes) ? parsed.notes : [parsed.notes || t.appDemoNote],
          meta: `${((totalBuildTime + 600) / 1000).toFixed(1)}s · Simulated pass`,
        },
      });

      setToast({ text: t.appDemoToastDone(parsed.name), tone: "ok" });
    }, totalBuildTime + 600);
  };

  return {
    stage,
    running,
    elapsedLabel,
    lod,
    model,
    sessionUsage,
    incomplete,
    attachments,
    chatTargets,
    chatFocusSignal,
    uploading,
    handleAttach,
    handleRemoveAttachment,
    handleModel,
    syncDefaultModel,
    handleLod,
    handleSend,
    handleStop,
    handleSendPartsToChat,
    handleRemoveTarget,
    handleUndoSpecEntry,
    handleRetryLast,
    handleEntryAction,
    handleLoadSampleChat,
    handleSendNote,
    handleSendAllNotes,
    handleLoadDemo,
  };
}
