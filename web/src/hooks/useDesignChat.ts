import { useCallback, type Dispatch, type SetStateAction } from "react";
import { validateSpec, type FamilySpec } from "@family/spec-core";
import type { ChatTarget } from "../lib/annotations";
import type { Lod } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useStudio } from "./StudioContext";
import { loadDemoPreset, type DemoPresetKey } from "./demoSpecs";
import type { ToastState } from "./types";
import { useDesignAttachments } from "./useDesignAttachments";
import { useDesignJobRunner } from "./useDesignJobRunner";
import { useExternalSpecSync } from "./useExternalSpecSync";

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
  const { t, formatNumber } = useI18n();
  const { state, dispatch } = useStudio();
  const { spec, chatTargets, chatFocusSignal, model, lod } = state;

  useExternalSpecSync(setToast);

  const runner = useDesignJobRunner({ setServerOnline });

  const sendPrompt = async (
    text: string,
    specOverride?: FamilySpec,
    sendOptions?: { fresh?: boolean; targets?: ChatTarget[]; noteIds?: string[] },
  ) => {
    if (runner.running || attachmentsState.uploading) return;
    await runner.runDesign(
      text,
      attachmentsState.attachments,
      attachmentsState.clearAttachments,
      specOverride,
      sendOptions,
    );
  };

  const attachmentsState = useDesignAttachments({
    running: runner.running,
    sendPrompt,
    setMobileTab,
  });

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

  const handleUndoSpecEntry = (snapshot: FamilySpec | null) => {
    dispatch({ type: "APPLY_SPEC", spec: snapshot, native: false });
  };

  const handleLoadSampleChat = () => {
    if (runner.running) return;
    void sendPrompt(t.chatSuggestion1);
  };

  const handleLoadDemo = async (key: DemoPresetKey) => {
    const preset = await loadDemoPreset(key, t);
    if (!preset) return;
    const parsed = validateSpec(preset.raw).spec;

    dispatch({
      type: "START_DEMO_BUILD",
      userEntry: { role: "user", text: preset.userPromptText },
    });
    runner.beginSimulation();
    runner.setStage({ stage: "reading", message: t.appDemoStageReading });

    setTimeout(() => {
      runner.setStage({ stage: "thinking", message: t.appDemoStageThinking });
    }, 700);

    const allParts = parsed.parts || [];
    const baseDelay = 1500;
    const partStep = 450;

    setTimeout(() => {
      runner.setStage({
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
          runner.setStage({
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
      runner.setStage({ stage: "checking", message: t.appDemoStageChecking });
    }, totalBuildTime + 200);

    setTimeout(() => {
      runner.endSimulation();
      dispatch({ type: "APPLY_SPEC", spec: parsed, record: false });

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
    stage: runner.stage,
    running: runner.running,
    elapsedLabel: runner.elapsedLabel,
    lod,
    model,
    sessionUsage: runner.sessionUsage,
    incomplete: runner.incomplete,
    attachments: attachmentsState.attachments,
    chatTargets,
    chatFocusSignal,
    uploading: attachmentsState.uploading,
    handleAttach: attachmentsState.handleAttach,
    handleRemoveAttachment: attachmentsState.handleRemoveAttachment,
    handleModel,
    syncDefaultModel,
    handleLod,
    handleSend: sendPrompt,
    handleStop: runner.handleStop,
    handleSendPartsToChat: attachmentsState.handleSendPartsToChat,
    handleRemoveTarget: attachmentsState.handleRemoveTarget,
    handleUndoSpecEntry,
    handleRetryLast: () => runner.handleRetryLast(sendPrompt),
    handleEntryAction: (action: { kind?: string; sampleId?: string }) =>
      runner.handleEntryAction(action, sendPrompt),
    handleLoadSampleChat,
    handleSendNote: attachmentsState.handleSendNote,
    handleSendAllNotes: attachmentsState.handleSendAllNotes,
    handleLoadDemo,
  };
}
