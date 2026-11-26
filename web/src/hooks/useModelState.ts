import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  analyzeSpec,
  paramKey,
  type FamilyParameter,
  type FamilySpec,
  type FamilyTypeEntry,
  type ParameterType,
} from "@family/spec-core";
import type { ChatEntry } from "../components/ChatPanel";
import type { ModelNote, NoteDraft } from "../lib/annotations";
import { buildFamily, downloadPortablePackage, exportMultiType } from "../lib/api";
import type { Units } from "../lib/format";
import type { Strings } from "../lib/strings";
import { newId, type ToastState } from "./types";

interface UseModelStateOptions {
  t: Strings;
  formatNumber: (n: number) => string;
  pushEntry: (entry: Omit<ChatEntry, "id">) => void;
  setToast: Dispatch<SetStateAction<ToastState | null>>;
  setMobileTab: Dispatch<SetStateAction<"chat" | "viewer" | "params">>;
}

export function useModelState({
  t,
  formatNumber,
  pushEntry,
  setToast,
  setMobileTab,
}: UseModelStateOptions) {
  const [spec, setSpec] = useState<FamilySpec | null>(null);
  const [building, setBuilding] = useState(false);
  const [exportingTypes, setExportingTypes] = useState(false);
  const [previewTypeValues, setPreviewTypeValues] = useState<Record<string, number> | null>(null);
  const [exportingPortable, setExportingPortable] = useState(false);
  const [native, setNative] = useState(false);
  const [units, setUnits] = useState<Units>("mm");
  const [revitVersion, setRevitVersion] = useState("2024");
  const [modelNotes, setModelNotes] = useState<ModelNote[]>([]);
  const [focusNote, setFocusNote] = useState<ModelNote | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [highlightPartIds, setHighlightPartIds] = useState<string[]>([]);
  const [focusPartId, setFocusPartId] = useState<string | null>(null);
  const [hiddenPartIds, setHiddenPartIds] = useState<string[]>([]);
  const [transparentPartIds, setTransparentPartIds] = useState<string[]>([]);

  const specRef = useRef<FamilySpec | null>(null);
  specRef.current = spec;
  const pastRef = useRef<FamilySpec[]>([]);
  const futureRef = useRef<FamilySpec[]>([]);
  const lastRecordRef = useRef(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;
  void historyVersion;

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

  useEffect(() => {
    setHighlightPartIds([]);
  }, [spec]);

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

  /**
   * Single entry point for spec changes so undo/redo sees every edit.
   * Rapid changes (typing in a parameter) coalesce into one history step.
   */
  const applySpec = (
    next: FamilySpec | null,
    options: { record?: boolean; reset?: boolean } = {},
  ) => {
    const { record = true, reset = false } = options;
    const current = specRef.current;

    if (reset) {
      pastRef.current = [];
      futureRef.current = [];
      lastRecordRef.current = 0;
    } else if (record && current && next && current !== next) {
      const now = Date.now();
      if (now - lastRecordRef.current > 400 || pastRef.current.length === 0) {
        pastRef.current.push(current);
        if (pastRef.current.length > 60) pastRef.current.shift();
      }
      lastRecordRef.current = now;
      futureRef.current = [];
    }

    setSpec(next);
    setHistoryVersion((version) => version + 1);
  };

  const undoSpec = () => {
    const previous = pastRef.current.pop();
    const current = specRef.current;
    if (!previous) return;
    if (current) futureRef.current.push(current);
    lastRecordRef.current = 0;
    setSpec(previous);
    setNative(false);
    setHistoryVersion((version) => version + 1);
  };

  const redoSpec = () => {
    const next = futureRef.current.pop();
    const current = specRef.current;
    if (!next) return;
    if (current) pastRef.current.push(current);
    lastRecordRef.current = 0;
    setSpec(next);
    setNative(false);
    setHistoryVersion((version) => version + 1);
  };

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
        undoSpec();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redoSpec();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleToggleHidePart = (partId: string) => {
    setHiddenPartIds((current) =>
      current.includes(partId) ? current.filter((id) => id !== partId) : [...current, partId],
    );
  };

  const handleUnhideAll = () => {
    setHiddenPartIds([]);
  };

  const handleIsolatePart = (partId: string) => {
    const all = analysis?.model.parts.map((part) => part.id) ?? [];
    setHiddenPartIds(all.filter((id) => id !== partId));
    setSelectedPartId(partId);
  };

  const handleFocusPart = (partId: string) => {
    setSelectedPartId(partId);
    setFocusPartId(partId);
    setFocusNote(null);
    setMobileTab("viewer");
  };

  const handleAddNote = (draft: NoteDraft) => {
    const note: ModelNote = {
      id: newId(),
      partId: draft.partId,
      partName: draft.partName,
      point: draft.point,
      normal: draft.normal,
      text: draft.text,
      status: "open",
      createdAt: Date.now(),
    };
    setModelNotes((current) => [...current, note]);
    setSelectedPartId(note.partId);
    setMobileTab("viewer");
  };

  const handleFocusNote = (note: ModelNote) => {
    setSelectedPartId(note.partId);
    setFocusPartId(note.partId);
    setFocusNote(note);
    setMobileTab("viewer");
  };

  const handleUpdateNote = (id: string, text: string) => {
    setModelNotes((current) => current.map((note) => (note.id === id ? { ...note, text } : note)));
  };

  const handleDeleteNote = (id: string) => {
    setModelNotes((current) => current.filter((note) => note.id !== id));
    setFocusNote((current) => (current?.id === id ? null : current));
  };

  const handleToggleNoteResolved = (id: string) => {
    setModelNotes((current) =>
      current.map((note) =>
        note.id === id
          ? {
              ...note,
              status: note.status === "resolved" ? "open" : "resolved",
              resolvedAt: note.status === "resolved" ? undefined : Date.now(),
            }
          : note,
      ),
    );
  };

  const handleToggleTransparentPart = (partId: string) => {
    setTransparentPartIds((current) =>
      current.includes(partId) ? current.filter((id) => id !== partId) : [...current, partId],
    );
  };

  const handleResetTransparent = () => {
    setTransparentPartIds([]);
  };

  const handleChangeTypes = (types: FamilyTypeEntry[]) => {
    const current = specRef.current;
    if (!current) return;
    applySpec({ ...current, types });
    setNative(false);
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
    applySpec({
      ...current,
      parameters: current.parameters.map((param) =>
        param.name === name ? { ...param, value, formula: undefined } : param,
      ),
    });
    setNative(false);
  };

  const handleUpdateConnectorHost = (connectorId: string, host: "solid" | "reference-plane") => {
    const current = specRef.current;
    if (!current) return;
    applySpec({
      ...current,
      connectors: (current.connectors ?? []).map((connector) =>
        connector.id === connectorId ? { ...connector, host } : connector,
      ),
    });
    setNative(false);
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
    applySpec({ ...current, parameters: [...current.parameters, parameter] });
    setNative(false);
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
        setNative(true);

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

        pushEntry({
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

  return {
    spec,
    setSpec,
    specRef,
    analysis,
    previewTypeValues,
    previewModel,
    deferredModel,
    deferredParameters,
    issuePartIds,
    skippedCutPartIds,
    native,
    setNative,
    units,
    setUnits,
    revitVersion,
    setRevitVersion,
    building,
    exportingTypes,
    exportingPortable,
    modelNotes,
    setModelNotes,
    focusNote,
    setFocusNote,
    selectedPartId,
    setSelectedPartId,
    highlightPartIds,
    setHighlightPartIds,
    focusPartId,
    setFocusPartId,
    hiddenPartIds,
    setHiddenPartIds,
    transparentPartIds,
    setTransparentPartIds,
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
    handleBuild,
  };
}
