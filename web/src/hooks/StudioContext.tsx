import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { FamilySpec } from "@family/spec-core";
import type { ChatEntry } from "../components/ChatPanel";
import type { ChatTarget, ModelNote, NoteDraft } from "../lib/annotations";
import type { Lod } from "../lib/api";
import type { Units } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { newId } from "./types";

export const LOD_LEVELS: Lod[] = [200, 300, 350, 400];

export function readStoredLod(): Lod {
  try {
    const stored = Number(window.localStorage.getItem("fa.lod"));
    return LOD_LEVELS.includes(stored as Lod) ? (stored as Lod) : 300;
  } catch {
    return 300;
  }
}

export function readStoredModel(): string {
  try {
    return window.localStorage.getItem("fa.model") ?? "";
  } catch {
    return "";
  }
}

export interface StudioState {
  spec: FamilySpec | null;
  past: FamilySpec[];
  future: FamilySpec[];
  lastRecordAt: number;
  native: boolean;
  units: Units;
  revitVersion: string;
  currentModelId: string | null;
  entries: ChatEntry[];
  modelNotes: ModelNote[];
  focusNote: ModelNote | null;
  selectedPartId: string | null;
  highlightPartIds: string[];
  focusPartId: string | null;
  hiddenPartIds: string[];
  transparentPartIds: string[];
  chatTargets: ChatTarget[];
  chatFocusSignal: number;
  fitSignal: number;
  model: string;
  lod: Lod;
}

export type StudioAction =
  | {
      type: "APPLY_SPEC";
      spec: FamilySpec | null;
      record?: boolean;
      reset?: boolean;
      native?: boolean;
      now?: number;
    }
  | { type: "UNDO_SPEC" }
  | { type: "REDO_SPEC" }
  | {
      type: "LOAD_FAMILY";
      spec: FamilySpec;
      modelId: string | null;
      annotations?: ModelNote[];
      entries?: ChatEntry[];
    }
  | {
      type: "APPLY_DESIGN_RESULT";
      spec: FamilySpec;
      entry?: Omit<ChatEntry, "id"> | ChatEntry;
      resolvedNoteIds?: string[];
      partial?: boolean;
      now?: number;
    }
  | { type: "RESET_SESSION"; greetingEntry: ChatEntry }
  | { type: "CLEAR_MODEL_LINK" }
  | { type: "START_DEMO_BUILD"; userEntry: Omit<ChatEntry, "id"> | ChatEntry }
  | {
      type: "RENAME_ACTIVE_MODEL";
      modelId: string;
      name: string;
      previousListName?: string;
    }
  | { type: "SET_NATIVE"; native: boolean }
  | { type: "SET_UNITS"; units: Units }
  | { type: "SET_REVIT_VERSION"; version: string }
  | { type: "SET_CURRENT_MODEL_ID"; id: string | null }
  | { type: "PUSH_ENTRY"; entry: Omit<ChatEntry, "id"> | ChatEntry }
  | { type: "SET_ENTRIES"; entries: ChatEntry[] }
  | {
      type: "SET_CHAT_TARGETS";
      targets: ChatTarget[] | ((current: ChatTarget[]) => ChatTarget[]);
    }
  | { type: "ADD_CHAT_TARGETS"; targets: ChatTarget[] }
  | { type: "REMOVE_CHAT_TARGET"; index: number }
  | { type: "ADD_NOTE"; draft: NoteDraft; id?: string; now?: number }
  | { type: "UPDATE_NOTE"; id: string; text: string }
  | { type: "DELETE_NOTE"; id: string }
  | { type: "TOGGLE_NOTE_RESOLVED"; id: string; now?: number }
  | { type: "CLEAR_NOTES" }
  | { type: "SELECT_PART"; partId: string | null }
  | { type: "FOCUS_PART"; partId: string }
  | { type: "FOCUS_NOTE"; note: ModelNote }
  | { type: "HIGHLIGHT_PARTS"; partIds: string[] }
  | { type: "TOGGLE_HIDE_PART"; partId: string }
  | { type: "UNHIDE_ALL_PARTS" }
  | { type: "ISOLATE_PART"; partId: string; allPartIds: string[] }
  | { type: "TOGGLE_TRANSPARENT_PART"; partId: string }
  | { type: "RESET_TRANSPARENT_PARTS" }
  | { type: "SET_MODEL"; model: string }
  | { type: "SYNC_DEFAULT_MODEL"; availableIds: string[]; serverDefaultModel?: string | null }
  | { type: "SET_LOD"; lod: Lod };

export function createInitialStudioState(
  greetingText = "",
  overrides: Partial<StudioState> = {},
): StudioState {
  return {
    spec: null,
    past: [],
    future: [],
    lastRecordAt: 0,
    native: false,
    units: "mm",
    revitVersion: "2024",
    currentModelId: null,
    entries: greetingText ? [{ id: "seed", role: "agent", text: greetingText }] : [],
    modelNotes: [],
    focusNote: null,
    selectedPartId: null,
    highlightPartIds: [],
    focusPartId: null,
    hiddenPartIds: [],
    transparentPartIds: [],
    chatTargets: [],
    chatFocusSignal: 0,
    fitSignal: 0,
    model: "",
    lod: 300,
    ...overrides,
  };
}

function withSpec(
  state: StudioState,
  next: FamilySpec | null,
  options: { record?: boolean; reset?: boolean; native?: boolean; now?: number } = {},
): StudioState {
  const { record = true, reset = false, native, now = Date.now() } = options;
  let past = state.past;
  let future = state.future;
  let lastRecordAt = state.lastRecordAt;

  if (reset) {
    past = [];
    future = [];
    lastRecordAt = 0;
  } else if (record && state.spec && next && state.spec !== next) {
    if (now - state.lastRecordAt > 400 || state.past.length === 0) {
      const appended = [...state.past, state.spec];
      past = appended.length > 60 ? appended.slice(appended.length - 60) : appended;
    }
    lastRecordAt = now;
    future = [];
  }

  return {
    ...state,
    spec: next,
    past,
    future,
    lastRecordAt,
    highlightPartIds: [],
    ...(native !== undefined ? { native } : {}),
  };
}

function toEntry(entry: Omit<ChatEntry, "id"> | ChatEntry): ChatEntry {
  return "id" in entry && entry.id ? entry : { ...entry, id: newId() };
}

export function studioReducer(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case "APPLY_SPEC":
      return withSpec(state, action.spec, {
        record: action.record,
        reset: action.reset,
        native: action.native,
        now: action.now,
      });

    case "UNDO_SPEC": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        ...state,
        spec: previous,
        past: state.past.slice(0, -1),
        future: state.spec ? [...state.future, state.spec] : state.future,
        lastRecordAt: 0,
        native: false,
        highlightPartIds: [],
      };
    }

    case "REDO_SPEC": {
      if (state.future.length === 0) return state;
      const next = state.future[state.future.length - 1];
      return {
        ...state,
        spec: next,
        past: state.spec ? [...state.past, state.spec] : state.past,
        future: state.future.slice(0, -1),
        lastRecordAt: 0,
        native: false,
        highlightPartIds: [],
      };
    }

    case "LOAD_FAMILY": {
      const nextLod =
        action.spec.lod && LOD_LEVELS.includes(action.spec.lod as Lod)
          ? (action.spec.lod as Lod)
          : state.lod;
      return {
        ...withSpec(state, action.spec, { reset: true, native: false }),
        currentModelId: action.modelId,
        modelNotes: Array.isArray(action.annotations) ? action.annotations : [],
        focusNote: null,
        selectedPartId: null,
        focusPartId: null,
        hiddenPartIds: [],
        transparentPartIds: [],
        chatTargets: [],
        fitSignal: state.fitSignal + 1,
        lod: nextLod,
        ...(action.entries ? { entries: action.entries } : {}),
      };
    }

    case "APPLY_DESIGN_RESULT": {
      const now = action.now ?? Date.now();
      const updated = withSpec(state, action.spec, {
        record: !action.partial,
        native: false,
        now,
      });
      const resolvedIds = action.resolvedNoteIds?.length ? new Set(action.resolvedNoteIds) : null;
      const modelNotes = resolvedIds
        ? updated.modelNotes.map((note) =>
            resolvedIds.has(note.id) ? { ...note, status: "resolved" as const, resolvedAt: now } : note,
          )
        : updated.modelNotes;
      return {
        ...updated,
        modelNotes,
        entries: action.entry ? [...updated.entries, toEntry(action.entry)] : updated.entries,
      };
    }

    case "RESET_SESSION":
      return {
        ...withSpec(state, null, { reset: true, native: false }),
        currentModelId: null,
        modelNotes: [],
        focusNote: null,
        selectedPartId: null,
        focusPartId: null,
        hiddenPartIds: [],
        transparentPartIds: [],
        chatTargets: [],
        entries: [action.greetingEntry],
      };

    case "CLEAR_MODEL_LINK":
      return {
        ...state,
        currentModelId: null,
        modelNotes: [],
        focusNote: null,
        chatTargets: [],
      };

    case "START_DEMO_BUILD":
      return {
        ...withSpec(state, null, { reset: true, native: false }),
        selectedPartId: null,
        focusPartId: null,
        hiddenPartIds: [],
        transparentPartIds: [],
        currentModelId: null,
        modelNotes: [],
        focusNote: null,
        chatTargets: [],
        entries: [...state.entries, toEntry(action.userEntry)],
      };

    case "RENAME_ACTIVE_MODEL": {
      if (state.currentModelId !== action.modelId || !state.spec) return state;
      const next: FamilySpec = { ...state.spec, name: action.name };
      if (
        action.previousListName &&
        state.spec.typeName &&
        state.spec.typeName.trim() === action.previousListName.trim()
      ) {
        next.typeName = action.name;
      }
      return { ...state, spec: next };
    }

    case "SET_NATIVE":
      return state.native === action.native ? state : { ...state, native: action.native };

    case "SET_UNITS":
      return state.units === action.units ? state : { ...state, units: action.units };

    case "SET_REVIT_VERSION":
      return state.revitVersion === action.version ? state : { ...state, revitVersion: action.version };

    case "SET_CURRENT_MODEL_ID":
      return { ...state, currentModelId: action.id };

    case "PUSH_ENTRY":
      return { ...state, entries: [...state.entries, toEntry(action.entry)] };

    case "SET_ENTRIES":
      return { ...state, entries: action.entries };

    case "SET_CHAT_TARGETS": {
      const next =
        typeof action.targets === "function" ? action.targets(state.chatTargets) : action.targets;
      return { ...state, chatTargets: next };
    }

    case "ADD_CHAT_TARGETS": {
      const next = [...state.chatTargets];
      for (const target of action.targets) {
        if (!next.some((item) => item.partId === target.partId)) next.push(target);
      }
      return {
        ...state,
        chatTargets: next,
        chatFocusSignal: state.chatFocusSignal + 1,
      };
    }

    case "REMOVE_CHAT_TARGET":
      return {
        ...state,
        chatTargets: state.chatTargets.filter((_, idx) => idx !== action.index),
      };

    case "ADD_NOTE": {
      const note: ModelNote = {
        id: action.id ?? newId(),
        partId: action.draft.partId,
        partName: action.draft.partName,
        point: action.draft.point,
        normal: action.draft.normal,
        text: action.draft.text,
        status: "open",
        createdAt: action.now ?? Date.now(),
      };
      return {
        ...state,
        modelNotes: [...state.modelNotes, note],
        selectedPartId: note.partId,
      };
    }

    case "UPDATE_NOTE":
      return {
        ...state,
        modelNotes: state.modelNotes.map((note) =>
          note.id === action.id ? { ...note, text: action.text } : note,
        ),
      };

    case "DELETE_NOTE":
      return {
        ...state,
        modelNotes: state.modelNotes.filter((note) => note.id !== action.id),
        focusNote: state.focusNote?.id === action.id ? null : state.focusNote,
      };

    case "TOGGLE_NOTE_RESOLVED": {
      const now = action.now ?? Date.now();
      return {
        ...state,
        modelNotes: state.modelNotes.map((note) =>
          note.id === action.id
            ? {
                ...note,
                status: note.status === "resolved" ? "open" : "resolved",
                resolvedAt: note.status === "resolved" ? undefined : now,
              }
            : note,
        ),
      };
    }

    case "CLEAR_NOTES":
      return { ...state, modelNotes: [], focusNote: null };

    case "SELECT_PART":
      return { ...state, selectedPartId: action.partId };

    case "FOCUS_PART":
      return {
        ...state,
        selectedPartId: action.partId,
        focusPartId: action.partId,
        focusNote: null,
      };

    case "FOCUS_NOTE":
      return {
        ...state,
        selectedPartId: action.note.partId,
        focusPartId: action.note.partId,
        focusNote: action.note,
      };

    case "HIGHLIGHT_PARTS":
      return { ...state, highlightPartIds: action.partIds };

    case "TOGGLE_HIDE_PART":
      return {
        ...state,
        hiddenPartIds: state.hiddenPartIds.includes(action.partId)
          ? state.hiddenPartIds.filter((id) => id !== action.partId)
          : [...state.hiddenPartIds, action.partId],
      };

    case "UNHIDE_ALL_PARTS":
      return { ...state, hiddenPartIds: [] };

    case "ISOLATE_PART":
      return {
        ...state,
        hiddenPartIds: action.allPartIds.filter((id) => id !== action.partId),
        selectedPartId: action.partId,
      };

    case "TOGGLE_TRANSPARENT_PART":
      return {
        ...state,
        transparentPartIds: state.transparentPartIds.includes(action.partId)
          ? state.transparentPartIds.filter((id) => id !== action.partId)
          : [...state.transparentPartIds, action.partId],
      };

    case "RESET_TRANSPARENT_PARTS":
      return { ...state, transparentPartIds: [] };

    case "SET_MODEL":
      return state.model === action.model ? state : { ...state, model: action.model };

    case "SYNC_DEFAULT_MODEL": {
      if (state.model && action.availableIds.includes(state.model)) return state;
      const next =
        action.serverDefaultModel && action.availableIds.includes(action.serverDefaultModel)
          ? action.serverDefaultModel
          : (action.availableIds[0] ?? "");
      return next === state.model ? state : { ...state, model: next };
    }

    case "SET_LOD":
      return state.lod === action.lod ? state : { ...state, lod: action.lod };
  }
}

export interface StudioContextValue {
  state: StudioState;
  specRef: MutableRefObject<FamilySpec | null>;
  dispatch: (action: StudioAction) => void;
}

const StudioContext = createContext<StudioContextValue | null>(null);

export function StudioProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [state, dispatch] = useReducer(studioReducer, undefined, () =>
    createInitialStudioState(t.appChatGreeting, {
      model: readStoredModel(),
      lod: readStoredLod(),
    }),
  );

  const specRef = useRef<FamilySpec | null>(null);
  specRef.current = state.spec;

  useEffect(() => {
    try {
      window.localStorage.setItem("fa.model", state.model);
    } catch {
      /* private mode, ignore */
    }
  }, [state.model]);

  useEffect(() => {
    try {
      window.localStorage.setItem("fa.lod", String(state.lod));
    } catch {
      /* private mode, ignore */
    }
  }, [state.lod]);

  const value = useMemo(() => ({ state, specRef, dispatch }), [state]);
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudio(): StudioContextValue {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error("useStudio must be used inside StudioProvider");
  return ctx;
}
