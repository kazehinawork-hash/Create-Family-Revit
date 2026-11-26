import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { analyzeSpec, migrateSpec, type FamilySpec } from "@family/spec-core";
import type { ChatEntry } from "../components/ChatPanel";
import type { ChatTarget, ModelNote } from "../lib/annotations";
import {
  createLibraryGroup,
  deleteLibraryGroup,
  deleteSavedModel,
  emptyTrash,
  fetchLibraryGroups,
  fetchModelHistory,
  fetchModelRevision,
  fetchSavedModelDetail,
  fetchSavedModels,
  fetchTrash,
  moveModelToGroup,
  purgeTrashedModel,
  renameLibraryGroup,
  renameModel,
  restoreTrashedModel,
  saveModel,
  uploadModelThumbnail,
  type LibraryGroupSummary,
  type Lod,
  type SavedModelMeta,
  type SavedModelRevision,
  type TrashItem,
} from "../lib/api";
import { ALL_GROUPS, UNGROUPED, readLibraryState } from "../lib/library";
import type { Strings } from "../lib/strings";
import { newId, type ThumbJob, type ToastState } from "./types";

interface UseLibraryOptions {
  t: Strings;
  formatDateTime: (date: number | Date) => string;
  spec: FamilySpec | null;
  setSpec: Dispatch<SetStateAction<FamilySpec | null>>;
  applySpec: (next: FamilySpec | null, options?: { record?: boolean; reset?: boolean }) => void;
  entries: ChatEntry[];
  setEntries: Dispatch<SetStateAction<ChatEntry[]>>;
  modelNotes: ModelNote[];
  setModelNotes: Dispatch<SetStateAction<ModelNote[]>>;
  setFocusNote: Dispatch<SetStateAction<ModelNote | null>>;
  setChatTargets: Dispatch<SetStateAction<ChatTarget[]>>;
  currentModelId: string | null;
  setCurrentModelId: Dispatch<SetStateAction<string | null>>;
  handleLod: (value: Lod) => void;
  viewerCaptureRef: MutableRefObject<(() => string | null) | null>;
  setToast: Dispatch<SetStateAction<ToastState | null>>;
}

export function useLibrary({
  t,
  formatDateTime,
  spec,
  setSpec,
  applySpec,
  entries,
  setEntries,
  modelNotes,
  setModelNotes,
  setFocusNote,
  setChatTargets,
  currentModelId,
  setCurrentModelId,
  handleLod,
  viewerCaptureRef,
  setToast,
}: UseLibraryOptions) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [savedList, setSavedList] = useState<SavedModelMeta[]>([]);
  const [libraryGroups, setLibraryGroups] = useState<LibraryGroupSummary[]>([]);
  const [libraryGroup, setLibraryGroup] = useState(() => readLibraryState().group);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [thumbJob, setThumbJob] = useState<ThumbJob | null>(null);
  const thumbCaptureRef = useRef<(() => string | null) | null>(null);
  const thumbStartedRef = useRef(false);
  const thumbAbortRef = useRef(false);
  const [historyModelId, setHistoryModelId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<SavedModelRevision[]>([]);
  const [historyKeep, setHistoryKeep] = useState(20);
  const [revisionsLoading, setRevisionsLoading] = useState(false);

  const captureThumbnail = (): string | undefined => {
    try {
      return viewerCaptureRef.current?.() ?? undefined;
    } catch {
      return undefined;
    }
  };

  const activeSaveGroup = () => (libraryGroup === ALL_GROUPS ? UNGROUPED : libraryGroup);

  const refreshLibrary = async () => {
    setLibraryLoading(true);
    const [models, snapshot, trash] = await Promise.all([
      fetchSavedModels(),
      fetchLibraryGroups(),
      fetchTrash(),
    ]);
    setSavedList(models);
    setLibraryGroups(snapshot.groups);
    setTrashItems(trash.items);
    setLibraryGroup((current) => {
      if (current === ALL_GROUPS || current === UNGROUPED) return current;
      return snapshot.groups.some((group) => group.name === current) ? current : ALL_GROUPS;
    });
    setLibraryLoading(false);
  };

  const handleOpenLibrary = async () => {
    setLibraryOpen(true);
    setHistoryModelId(null);
    await refreshLibrary();
  };

  useEffect(() => {
    if (!libraryOpen) {
      thumbAbortRef.current = true;
      thumbStartedRef.current = false;
      setThumbJob(null);
      return;
    }
    if (thumbStartedRef.current || libraryLoading) return;

    const missing = savedList.filter((item) => !item.thumbUrl);
    if (missing.length === 0) return;

    thumbStartedRef.current = true;
    thumbAbortRef.current = false;

    const captureJob = (job: ThumbJob) =>
      new Promise<string | null>((resolve) => {
        thumbCaptureRef.current = null;
        setThumbJob(job);
        const startedAt = Date.now();
        let timer = 0;
        let done = false;
        const finish = (value: string | null) => {
          if (done) return;
          done = true;
          window.clearTimeout(timer);
          resolve(value);
        };
        const tick = () => {
          if (thumbAbortRef.current) {
            finish(null);
            return;
          }
          const image = thumbCaptureRef.current?.() ?? null;
          if (image) {
            finish(image);
            return;
          }
          if (Date.now() - startedAt > 6000) {
            finish(null);
            return;
          }
          timer = window.setTimeout(tick, 250);
        };
        timer = window.setTimeout(tick, 150);
      });

    void (async () => {
      for (const item of missing) {
        if (thumbAbortRef.current) break;
        const detail = await fetchSavedModelDetail(item.id).catch(() => null);
        const savedSpec = detail?.spec;
        if (!savedSpec) continue;

        let thumbAnalysis;
        try {
          thumbAnalysis = analyzeSpec(savedSpec);
        } catch {
          continue;
        }
        if (!thumbAnalysis.model) continue;

        const image = await captureJob({
          id: item.id,
          model: thumbAnalysis.model,
          parameters: savedSpec.parameters ?? [],
          materials: savedSpec.materials ?? [],
        });
        if (thumbAbortRef.current) break;

        if (image) {
          try {
            await uploadModelThumbnail(item.id, image);
            const thumbUrl = `/api/models/${encodeURIComponent(item.id)}/thumb?t=${Date.now()}`;
            setSavedList((current) =>
              current.map((entry) => (entry.id === item.id ? { ...entry, thumbUrl } : entry)),
            );
          } catch {
            /* a failed preview must not block the library */
          }
        }
        setThumbJob(null);
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      setThumbJob(null);
    })();
  }, [libraryOpen, libraryLoading, savedList]);

  const handleSaveModel = async () => {
    if (!spec) return;
    try {
      const res = await saveModel({
        id: currentModelId || undefined,
        name: spec.name,
        spec,
        entries,
        annotations: modelNotes,
        ...(currentModelId ? {} : { group: activeSaveGroup() }),
        thumbnail: captureThumbnail(),
      });
      if (res.ok && res.id) {
        setCurrentModelId(res.id);
        setToast({ text: t.appSaveDone, sub: `ID: ${res.id}`, tone: "ok" });
        if (libraryOpen) void refreshLibrary();
      }
    } catch (error) {
      setToast({
        text: t.appSaveFailed(error instanceof Error ? error.message : String(error)),
        tone: "error",
      });
    }
  };

  const handleSaveModelAs = async () => {
    if (!spec) return;
    const entered = window.prompt(t.appSaveAsPrompt, `${spec.name} copy`);
    const name = entered?.trim();
    if (!name) return;

    try {
      const copySpec: FamilySpec = { ...spec, name };
      const res = await saveModel({
        name,
        spec: copySpec,
        entries,
        annotations: modelNotes,
        group: activeSaveGroup(),
        thumbnail: captureThumbnail(),
      });
      if (res.ok && res.id) {
        applySpec(copySpec);
        setCurrentModelId(res.id);
        setToast({ text: t.appSaveAsDone, sub: t.appSaveAsSub(name), tone: "ok" });
        if (libraryOpen) void refreshLibrary();
      }
    } catch (error) {
      setToast({
        text: t.appSaveFailed(error instanceof Error ? error.message : String(error)),
        tone: "error",
      });
    }
  };

  const handleCreateGroup = async (name: string) => {
    try {
      const result = await createLibraryGroup(name);
      setLibraryGroups(result.groups ?? []);
      setLibraryGroup(result.name);
      setToast({ text: t.appGroupCreated(result.name), tone: "ok" });
    } catch (error) {
      setToast({
        text: t.appGroupCreateFailed(error instanceof Error ? error.message : String(error)),
        tone: "error",
      });
    }
  };

  const handleRenameGroup = async (from: string, to: string) => {
    try {
      await renameLibraryGroup(from, to);
      if (libraryGroup === from) setLibraryGroup(to);
      await refreshLibrary();
      setToast({ text: t.appGroupRenamed(to), tone: "ok" });
    } catch (error) {
      setToast({
        text: t.appGroupRenameFailed(error instanceof Error ? error.message : String(error)),
        tone: "error",
      });
    }
  };

  const handleDeleteGroup = async (name: string) => {
    try {
      await deleteLibraryGroup(name);
      if (libraryGroup === name) setLibraryGroup(ALL_GROUPS);
      await refreshLibrary();
      setToast({ text: t.appGroupDeleted(name), sub: t.appGroupDeletedSub, tone: "ok" });
    } catch (error) {
      setToast({
        text: t.appGroupDeleteFailed(error instanceof Error ? error.message : String(error)),
        tone: "error",
      });
    }
  };

  const handleMoveModel = async (id: string, group: string) => {
    try {
      await moveModelToGroup(id, group);
      setSavedList((current) =>
        current.map((item) => (item.id === id ? { ...item, group } : item)),
      );
      const snapshot = await fetchLibraryGroups();
      setLibraryGroups(snapshot.groups);
      setToast({
        text: group ? t.appMovedToGroup(group) : t.appMovedToUngrouped,
        tone: "ok",
      });
    } catch (error) {
      setToast({
        text: t.appMoveFailed(error instanceof Error ? error.message : String(error)),
        tone: "error",
      });
    }
  };

  const handleOpenHistory = async (id: string) => {
    setHistoryModelId(id);
    setRevisionsLoading(true);
    const history = await fetchModelHistory(id);
    setRevisions(history.revisions);
    setHistoryKeep(history.keep);
    setRevisionsLoading(false);
  };

  const handleRestoreRevision = async (stamp: string) => {
    if (!historyModelId) return;
    const revision = await fetchModelRevision(historyModelId, stamp);
    if (!revision?.spec) {
      setToast({ text: t.appRevisionUnreadable, tone: "error" });
      return;
    }
    const migratedSpec = migrateSpec(revision.spec).spec as unknown as FamilySpec;
    applySpec(migratedSpec, { reset: true });
    setCurrentModelId(historyModelId);
    setModelNotes(Array.isArray(revision.annotations) ? revision.annotations : []);
    setFocusNote(null);
    setChatTargets([]);
    setHistoryModelId(null);
    setLibraryOpen(false);
    setToast({
      text: t.appRevisionRestored,
      sub: formatDateTime(revision.savedAt),
      tone: "ok",
    });
  };

  const handleLoadModel = async (id: string) => {
    try {
      const detail = await fetchSavedModelDetail(id);
      if (detail && detail.spec) {
        const migratedSpec = migrateSpec(detail.spec).spec as unknown as FamilySpec;
        applySpec(migratedSpec, { reset: true });
        setCurrentModelId(detail.id);
        setModelNotes(Array.isArray(detail.annotations) ? detail.annotations : []);
        setFocusNote(null);
        setChatTargets([]);
        if (migratedSpec.lod) handleLod(migratedSpec.lod);
        if (Array.isArray(detail.entries) && detail.entries.length > 0) {
          setEntries(detail.entries);
        } else {
          setEntries([
            {
              id: newId(),
              role: "agent",
              text: t.appModelReloaded(migratedSpec.name),
            },
          ]);
        }
        setLibraryOpen(false);
        setToast({ text: t.appModelOpened(detail.name), tone: "ok" });
      }
    } catch (error) {
      setToast({
        text: t.appModelOpenFailed(error instanceof Error ? error.message : String(error)),
        tone: "error",
      });
    }
  };

  const handleRenameModel = async (id: string, name: string) => {
    const item = savedList.find((entry) => entry.id === id);
    if (!item || !name.trim()) return;

    try {
      const result = await renameModel(id, name.trim());
      const renamed = result.name ?? name.trim();

      setSavedList((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, name: renamed } : entry)),
      );

      if (currentModelId === id) {
        setSpec((current) => {
          if (!current) return current;
          const next: FamilySpec = { ...current, name: renamed };
          if (current.typeName && current.typeName.trim() === item.name.trim()) {
            next.typeName = renamed;
          }
          return next;
        });
      }

      setToast({ text: t.appModelRenamed, tone: "ok" });
    } catch (error) {
      setToast({
        text: t.appModelRenameFailed(error instanceof Error ? error.message : String(error)),
        tone: "error",
      });
    }
  };

  const handleDeleteModel = async (id: string) => {
    if (!window.confirm(t.confirmTrash)) return;
    try {
      const removed = await deleteSavedModel(id);
      setSavedList((curr) => curr.filter((item) => item.id !== id));
      const trash = await fetchTrash();
      setTrashItems(trash.items);
      setLibraryGroups((current) =>
        current.map((group) => ({
          ...group,
          count: Math.max(
            0,
            group.count - (savedList.find((item) => item.id === id)?.group === group.name ? 1 : 0),
          ),
        })),
      );
      if (currentModelId === id) {
        setCurrentModelId(null);
        setModelNotes([]);
        setFocusNote(null);
        setChatTargets([]);
      }
      setToast({
        text: t.trashMoved,
        tone: "ok",
        action: { label: t.undoTrash, onClick: () => void handleRestoreTrash(removed.key) },
      });
    } catch (error) {
      setToast({
        text: t.appDeleteFailed(error instanceof Error ? error.message : String(error)),
        tone: "error",
      });
    }
  };

  const handleRestoreTrash = async (key: string) => {
    try {
      await restoreTrashedModel(key);
      await refreshLibrary();
      setToast({ text: t.trashRestored, tone: "ok" });
    } catch (error) {
      setToast({
        text: t.appRestoreFailed(error instanceof Error ? error.message : String(error)),
        tone: "error",
      });
    }
  };

  const handlePurgeTrash = async (key: string) => {
    try {
      await purgeTrashedModel(key);
      await refreshLibrary();
      setToast({ text: t.trashPurged, tone: "ok" });
    } catch (error) {
      setToast({
        text: t.appPurgeFailed(error instanceof Error ? error.message : String(error)),
        tone: "error",
      });
    }
  };

  const handleEmptyTrash = async () => {
    try {
      await emptyTrash();
      await refreshLibrary();
      setToast({ text: t.trashEmptied, tone: "ok" });
    } catch (error) {
      setToast({
        text: t.appEmptyTrashFailed(error instanceof Error ? error.message : String(error)),
        tone: "error",
      });
    }
  };

  const handleNewModel = () => {
    if (spec && !window.confirm(t.appConfirmNewModel)) return;
    applySpec(null, { reset: true });
    setCurrentModelId(null);
    setModelNotes([]);
    setFocusNote(null);
    setChatTargets([]);
    setEntries([{ id: "seed", role: "agent", text: t.appChatGreeting }]);
  };

  return {
    libraryOpen,
    setLibraryOpen,
    savedList,
    libraryGroups,
    libraryGroup,
    setLibraryGroup,
    libraryLoading,
    trashItems,
    thumbJob,
    thumbCaptureRef,
    historyModelId,
    setHistoryModelId,
    revisions,
    historyKeep,
    revisionsLoading,
    handleOpenLibrary,
    handleSaveModel,
    handleSaveModelAs,
    handleCreateGroup,
    handleRenameGroup,
    handleDeleteGroup,
    handleMoveModel,
    handleOpenHistory,
    handleRestoreRevision,
    handleLoadModel,
    handleRenameModel,
    handleDeleteModel,
    handleRestoreTrash,
    handlePurgeTrash,
    handleEmptyTrash,
    handleNewModel,
  };
}
