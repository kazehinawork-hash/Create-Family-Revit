import { useDeferredValue, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  analyzeSpec,
  paramKey,
  type FamilyParameter,
  type FamilySpec,
  type FamilyTypeEntry,
  type ParameterType,
} from "@family/spec-core";
import type { ModelNote, NoteDraft } from "../lib/annotations";
import { buildFamily, downloadPortablePackage, exportMultiType, fetchHealth, openRfaFolder } from "../lib/api";
import type { Units } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { useStudio } from "./StudioContext";
import type { ToastState } from "./types";

interface UseModelStateOptions {
  setToast: Dispatch<SetStateAction<ToastState | null>>;
  setMobileTab: Dispatch<SetStateAction<"chat" | "viewer" | "params">>;
}

export function useModelState({ setToast, setMobileTab }: UseModelStateOptions) {
  const { t, formatNumber } = useI18n();
  const { state, specRef, dispatch } = useStudio();
  const {
    spec,
    past,
    future,
    native,
    units,
    revitVersion,
    modelNotes,
    focusNote,
    selectedPartId,
    highlightPartIds,
    focusPartId,
    hiddenPartIds,
    transparentPartIds,
  } = state;

  const [building, setBuilding] = useState(false);
  const [exportingTypes, setExportingTypes] = useState(false);
  const [previewTypeValues, setPreviewTypeValues] = useState<Record<string, number> | null>(null);
  const [exportingPortable, setExportingPortable] = useState(false);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  const analysis = useMemo(() => (spec ? analyzeSpec(spec) : null), [spec]);

  const previewAnalysis = useMemo(() => {
    if (!spec || !previewTypeValues) return null;

    return analyzeSpec({
      ...spec,
      parameters: spec.parameters.map((parameter) => {
        const value = previewTypeValues[parameter.name];
        return value === undefined ? parameter : { ...parameter, value, formula: undefined };
      }),
    });
  }, [spec, previewTypeValues]);

  const previewModel = useDeferredValue(previewAnalysis?.model ?? null);

  const issuePartIds = useMemo(() => {
    const ids = new Set<string>();
    for (const issue of analysis?.issues ?? []) {
      if (!issue.path.startsWith("logic.")) continue;
      const partId = issue.path.split(".").pop();
      if (partId) ids.add(partId);
    }
    return [...ids];
  }, [analysis]);

  const skippedCutPartIds = useMemo(() => {
    const ids = new Set<string>();
    for (const issue of analysis?.issues ?? []) {
      const match = /^logic\.geometry\.([^.]+)\.cuts\[/.exec(issue.path);
      if (match) ids.add(match[1]);
    }
    return [...ids];
  }, [analysis]);

  const deferredModel = useDeferredValue(analysis?.model ?? null);
  const deferredParameters = useDeferredValue(spec?.parameters);
  const [viewerFitSignal, setViewerFitSignal] = useState(0);

  useEffect(() => {
    if (!deferredModel || deferredModel !== analysis?.model) return;
    if (state.fitSignal > viewerFitSignal) {
      setViewerFitSignal(state.fitSignal);
    }
  }, [state.fitSignal, deferredModel, analysis, viewerFitSignal]);

  const applySpec = (
    next: FamilySpec | null,
    options: { record?: boolean; reset?: boolean; native?: boolean } = {},
  ) => {
    dispatch({ type: "APPLY_SPEC", spec: next, ...options });
  };

  const undoSpec = () => dispatch({ type: "UNDO_SPEC" });
  const redoSpec = () => dispatch({ type: "REDO_SPEC" });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (typing || !(event.ctrlKey || event.metaKey)) return;

      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        dispatch({ type: "UNDO_SPEC" });
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        dispatch({ type: "REDO_SPEC" });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  const handleToggleHidePart = (partId: string) =>
    dispatch({ type: "TOGGLE_HIDE_PART", partId });

  const handleUnhideAll = () => dispatch({ type: "UNHIDE_ALL_PARTS" });

  const handleIsolatePart = (partId: string) => {
    const allPartIds = analysis?.model.parts.map((part) => part.id) ?? [];
    dispatch({ type: "ISOLATE_PART", partId, allPartIds });
  };

  const handleFocusPart = (partId: string) => {
    dispatch({ type: "FOCUS_PART", partId });
    setMobileTab("viewer");
  };

  const handleAddNote = (draft: NoteDraft) => {
    dispatch({ type: "ADD_NOTE", draft });
    setMobileTab("viewer");
  };

  const handleFocusNote = (note: ModelNote) => {
    dispatch({ type: "FOCUS_NOTE", note });
    setMobileTab("viewer");
  };

  const handleUpdateNote = (id: string, text: string) =>
    dispatch({ type: "UPDATE_NOTE", id, text });

  const handleDeleteNote = (id: string) => dispatch({ type: "DELETE_NOTE", id });

  const handleToggleNoteResolved = (id: string) =>
    dispatch({ type: "TOGGLE_NOTE_RESOLVED", id });

  const handleToggleTransparentPart = (partId: string) =>
    dispatch({ type: "TOGGLE_TRANSPARENT_PART", partId });

  const handleResetTransparent = () => dispatch({ type: "RESET_TRANSPARENT_PARTS" });

  const setUnits = (next: Units) => dispatch({ type: "SET_UNITS", units: next });
  const setRevitVersion = (version: string) =>
    dispatch({ type: "SET_REVIT_VERSION", version });
  const setSelectedPartId = (partId: string | null) =>
    dispatch({ type: "SELECT_PART", partId });
  const setHighlightPartIds = (partIds: string[]) =>
    dispatch({ type: "HIGHLIGHT_PARTS", partIds });

  const handleChangeTypes = (types: FamilyTypeEntry[]) => {
    const current = specRef.current;
    if (!current) return;
    applySpec({ ...current, types }, { native: false });
  };

  const handlePreviewType = (values: Record<string, number> | null) => {
    setPreviewTypeValues(values ? { ...values } : null);
  };

  const handleExportTypes = async () => {
    const current = specRef.current;
    if (!current || !analysis?.ok) return;
    const types = current.types ?? [];
    if (types.length === 0) return;

    setExportingTypes(true);
    setToast({
      text: t.appExportTypesTitle(formatNumber(types.length)),
      sub: t.appExportTypesSub,
      tone: "ok",
    });

    try {
      const result = await exportMultiType({ ...current, revitVersion });
      setToast({
        text: t.appExportTypesDone(formatNumber(types.length)),
        sub: result.path ? `${result.path} · ${result.types ?? types.length} type` : undefined,
        tone: "ok",
      });
    } catch (error) {
      setToast({
        text: t.appExportTypesFailed,
        sub: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setExportingTypes(false);
    }
  };

  const handleUpdateParameter = (name: string, value: number | string) => {
    const current = specRef.current;
    if (!current) return;
    applySpec(
      {
        ...current,
        parameters: current.parameters.map((param) =>
          param.name === name ? { ...param, value, formula: undefined } : param,
        ),
      },
      { native: false },
    );
  };

  const handleUpdateConnectorHost = (connectorId: string, host: "solid" | "reference-plane") => {
    const current = specRef.current;
    if (!current) return;
    applySpec(
      {
        ...current,
        connectors: (current.connectors ?? []).map((connector) =>
          connector.id === connectorId ? { ...connector, host } : connector,
        ),
      },
      { native: false },
    );
  };

  const handleAddParameter = (draft: {
    name: string;
    type: ParameterType;
    value: number | string;
  }) => {
    const current = specRef.current;
    if (!current) return;

    const taken = new Set(current.parameters.map((param) => paramKey(param.name)));
    let name = draft.name;
    let suffix = 2;
    while (taken.has(paramKey(name))) {
      name = `${draft.name} ${suffix}`;
      suffix += 1;
    }
    const parameter: FamilyParameter = {
      name,
      type: draft.type,
      group: draft.type === "Length" || draft.type === "Angle" ? "Dimensions" : "Data",
      value: draft.value,
    };
    applySpec({ ...current, parameters: [...current.parameters, parameter] }, { native: false });
  };

  const handleExportPortable = async () => {
    if (!spec || !analysis?.ok || exportingPortable) return;
    setExportingPortable(true);
    setToast({
      text: t.appPortableStarted,
      sub: t.appPortableStartedSub,
      tone: "ok",
    });

    try {
      await downloadPortablePackage({ ...spec, revitVersion });
      setToast({
        text: t.appPortableDone,
        sub: t.appPortableDoneSub,
        tone: "ok",
      });
    } catch (err: unknown) {
      setToast({
        text: t.appPortableFailed,
        sub: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setExportingPortable(false);
    }
  };

  const handleBuild = async () => {
    if (!spec || !analysis?.ok || building) return;
    setBuilding(true);
    setToast({
      text: t.appBuildStarted,
      sub: t.appBuildStartedSub,
      tone: "ok",
    });
    try {
      const result = await buildFamily({ ...spec, revitVersion });
      if (result.ok && result.path) {
        dispatch({ type: "SET_NATIVE", native: true });

        const driving = result.stats?.driving ?? [];
        const unlabelled = result.stats?.unlabelled ?? [];
        const inert = result.stats?.inert ?? [];
        const failedParts = result.stats?.failedParts ?? [];
        const missingForms = result.stats?.missingForms ?? 0;
        const qa = result.qa;
        const buildMode = result.stats?.mode;
        const rebuildMode = buildMode === "planes" || buildMode === "rebuild";
        const notes = [
          ...(result.warnings ?? []),
          ...(buildMode === "planes" ? [t.appBuildNotePlanes] : []),
          ...(buildMode === "rebuild" ? [t.appBuildNoteRebuild] : []),
          ...(missingForms > 0 ? [t.appBuildMissingForms(formatNumber(missingForms))] : []),
          ...failedParts.slice(0, 5).map((item) => t.appBuildFailedPart(item)),
          ...(qa?.rebuildRequired ? [t.appBuildNoteQa] : []),
          ...unlabelled.map((item) => t.appBuildUnlabelled(item)),
          ...inert.map((name) => t.appBuildInert(name)),
        ].slice(0, 14);

        dispatch({
          type: "PUSH_ENTRY",
          entry: {
            role: "agent",
            text:
              `${t.appBuildResultTitle(spec.name, result.revitVersion ?? revitVersion)}\n` +
              `${t.appBuildDriving(formatNumber(driving.length), formatNumber(result.stats?.locks ?? 0))}` +
              `${result.stats?.refPlanes ? ` · ${formatNumber(result.stats.refPlanes)} reference plane` : ""}` +
              `${result.stats?.joins ? ` · ${formatNumber(result.stats.joins)} join` : ""}` +
              `${result.stats?.totalForms !== undefined ? ` · ${formatNumber(result.stats.totalForms)} form` : ""}` +
              `${qa ? ` · QA ${qa.ok ? "pass" : t.appBuildQaWarnings(formatNumber(qa.warnings.length))}` : ""}`,
            notes: notes.length > 0 ? notes : undefined,
            meta: result.path,
            tone: (driving.length === 0 && !rebuildMode) || missingForms > 0 ? "error" : undefined,
          },
        });

        setToast({
          text:
            missingForms > 0
              ? t.appBuildDoneMissing(formatNumber(missingForms))
              : rebuildMode
                ? t.appBuildDoneRebuild
                : qa?.rebuildRequired
                  ? t.appBuildDoneNeedsRebuild
                  : t.appBuildDoneSuccess,
          sub:
            missingForms > 0
              ? t.appBuildMissingHint
              : rebuildMode
                ? t.appBuildRebuildSub
                : driving.length === 0
                  ? t.appBuildNoDrivingWarning
                  : t.appBuildDrivingSub(formatNumber(driving.length), result.path),
          tone:
            missingForms > 0 || (driving.length === 0 && !rebuildMode)
              ? "error"
              : rebuildMode
                ? "ok"
                : qa?.rebuildRequired
                  ? "warn"
                  : "ok",
        });
        const link = document.createElement("a");
        link.href = `/api/download-rfa?path=${encodeURIComponent(result.path)}`;
        link.download = `${spec.name || "Family"}.rfa`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        void openRfaFolder(result.path);
      } else if (result.mode === "queue") {
        setToast({
          text: t.appBridgeOffTitle,
          sub: t.appBridgeOffSub,
          tone: "warn",
        });
        if (result.file) {
          const link = document.createElement("a");
          link.href = `/api/download-spec?file=${encodeURIComponent(result.file)}`;
          link.download = `${spec.name || "Family"}-spec.json`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }
      } else {
        setToast({ text: result.error ?? t.appBuildFailed, tone: "error" });
      }
    } catch (error) {
      setToast({ text: error instanceof Error ? error.message : String(error), tone: "error" });
    } finally {
      setBuilding(false);
    }
  };

  const handleExportRfa = async (fallbackBridgeConnected = false) => {
    if (!spec || !analysis?.ok || building || exportingPortable) return;
    const latest = await fetchHealth();
    const bridgeUp = latest ? Boolean(latest.revit?.connected) : fallbackBridgeConnected;
    if (bridgeUp) {
      await handleBuild();
      return;
    }
    await handleExportPortable();
  };

  return {
    spec,
    specRef,
    analysis,
    previewTypeValues,
    previewModel,
    deferredModel,
    deferredParameters,
    issuePartIds,
    skippedCutPartIds,
    native,
    units,
    setUnits,
    revitVersion,
    setRevitVersion,
    building,
    exportingTypes,
    exportingPortable,
    modelNotes,
    focusNote,
    selectedPartId,
    setSelectedPartId,
    highlightPartIds,
    setHighlightPartIds,
    focusPartId,
    viewerFitSignal,
    hiddenPartIds,
    transparentPartIds,
    canUndo,
    canRedo,
    applySpec,
    undoSpec,
    redoSpec,
    handleToggleHidePart,
    handleUnhideAll,
    handleIsolatePart,
    handleFocusPart,
    handleAddNote,
    handleFocusNote,
    handleUpdateNote,
    handleDeleteNote,
    handleToggleNoteResolved,
    handleToggleTransparentPart,
    handleResetTransparent,
    handleChangeTypes,
    handlePreviewType,
    handleExportTypes,
    handleUpdateParameter,
    handleUpdateConnectorHost,
    handleAddParameter,
    handleExportPortable,
    handleExportRfa,
    handleBuild,
  };
}
