import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

import type { SavedModelMeta, SavedModelRevision, TrashItem } from "../lib/api";
import { useI18n } from "../lib/i18n";
import {
  ALL_GROUPS,
  UNGROUPED,
  buildSections,
  isAllGroups,
  readLibraryState,
  sidebarGroups,
  visibleModels,
  writeLibraryState,
  type LibraryGroupInfo,
  type LibrarySort,
} from "../lib/library";

export interface LibraryPanelProps {
  models: SavedModelMeta[];
  groups: LibraryGroupInfo[];
  loading?: boolean;
  currentModelId: string | null;
  /** "" = ungrouped, "*" = every group. */
  activeGroup: string;
  historyModelId: string | null;
  revisions: SavedModelRevision[];
  revisionsLoading: boolean;
  /** Revisions kept per model; 0 = unlimited. */
  historyKeep: number;
  onClose: () => void;
  onActiveGroup: (group: string) => void;
  onLoadModel: (id: string) => void;
  onNewModel: () => void;
  onOpenHistory: (id: string) => void;
  onCloseHistory: () => void;
  onRestoreRevision: (stamp: string) => void;
  onRenameModel: (id: string, name: string) => void | Promise<unknown>;
  onDeleteModel: (id: string) => void;
  onCreateGroup: (name: string) => void | Promise<unknown>;
  onRenameGroup: (from: string, to: string) => void | Promise<unknown>;
  onDeleteGroup: (name: string) => void;
  onMoveModel: (id: string, group: string) => void;
  trashItems: TrashItem[];
  onRestoreTrash: (key: string) => void;
  onPurgeTrash: (key: string) => void;
  onEmptyTrash: () => void;
}

const SORTS: LibrarySort[] = ["recent", "name", "category", "adjustable"];
const SIDEBAR_WIDTH_KEY = "family.library.sidebarWidth.v1";
const SIDEBAR_DEFAULT_WIDTH = 210;
const SIDEBAR_MIN_WIDTH = 150;
const SIDEBAR_MAX_WIDTH = 380;

function clampSidebarWidth(value: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, value));
}

function readSidebarWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(value) ? clampSidebarWidth(value) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function writeSidebarWidth(value: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(value));
  } catch {
    // Private mode or blocked storage: resizing still works for this session.
  }
}

function IconFolder() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function IconMore() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

/**
 * The saved-model library: groups on the left, searchable cards on the right.
 * The modal shell lives here so App only passes data and callbacks.
 */
export function LibraryPanel({
  models,
  groups,
  loading = false,
  currentModelId,
  activeGroup,
  historyModelId,
  revisions,
  revisionsLoading,
  historyKeep,
  onClose,
  onActiveGroup,
  onLoadModel,
  onNewModel,
  onOpenHistory,
  onCloseHistory,
  onRestoreRevision,
  onRenameModel,
  onDeleteModel,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveModel,
  trashItems,
  onRestoreTrash,
  onPurgeTrash,
  onEmptyTrash,
}: LibraryPanelProps) {
  const { t, formatDate, formatDateTime } = useI18n();
  const [showTrash, setShowTrash] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>(() => readLibraryState().sort);
  const [collapsed, setCollapsed] = useState<string[]>(() => readLibraryState().collapsed);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  // Menus are positioned with fixed coordinates: the scrollable columns would clip
  // an absolutely positioned dropdown that reaches past their edge.
  const [openMenu, setOpenMenu] = useState<{
    key: string;
    top: number;
    left: number;
    group?: string;
  } | null>(null);
  const [groupDelete, setGroupDelete] = useState<{
    name: string;
    count: number;
  } | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const renameCancelled = useRef(false);

  const sidebar = useMemo(() => sidebarGroups(models, groups), [models, groups]);
  const visible = useMemo(
    () => visibleModels(models, { group: activeGroup, query, sort }),
    [models, activeGroup, query, sort],
  );
  const sections = useMemo(
    () => buildSections(visible, groups, sort, t),
    [visible, groups, sort, t],
  );
  const currentName =
    models.find((model) => model.id === historyModelId)?.name ?? historyModelId ?? "";

  useEffect(() => {
    writeLibraryState({ sort, collapsed });
  }, [sort, collapsed]);

  const MENU_WIDTH = 176;
  const MENU_HEIGHT = 84;

  const placeMenu = (
    event: { currentTarget: HTMLElement; clientX: number; clientY: number },
    key: string,
    anchorRight?: number,
    anchorBottom?: number,
    group?: string,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(anchorRight ?? rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8),
    );
    // Near the bottom of the viewport the menu flips above the anchor instead of
    // being clipped by the window edge.
    const below = (anchorBottom ?? rect.bottom) + 6;
    const top = below + MENU_HEIGHT > window.innerHeight - 8 ? rect.top - MENU_HEIGHT - 6 : below;
    setOpenMenu({ key, top: Math.max(8, top), left, group });
  };

  const toggleMenu = (event: ReactMouseEvent<HTMLButtonElement>, key: string) => {
    if (openMenu?.key === key) {
      setOpenMenu(null);
      return;
    }
    placeMenu(event, key);
  };

  const openGroupMenuAt = (
    event: ReactMouseEvent<HTMLElement>,
    group: string,
    mode: "button" | "pointer",
  ) => {
    const key = `g:${group}`;
    if (mode === "button" && openMenu?.key === key) {
      setOpenMenu(null);
      return;
    }
    // Right-click / double-click positions the menu at the pointer, not at the row edge.
    placeMenu(event, key, event.clientX - MENU_WIDTH / 2, event.clientY + 4, group);
  };

  // A menu pinned to the viewport must not survive a scroll or a click elsewhere.
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".card-menu, .card-menu-wrap, .group-menu-wrap, .group-menu-btn")) return;
      setOpenMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [openMenu]);

  const selectGroup = (group: string) => {
    setShowTrash(false);
    onActiveGroup(group);
    writeLibraryState({ group });
    setOpenMenu(null);
  };

  const toggleSection = (key: string) => {
    setCollapsed((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
  };

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let lastWidth = startWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent: PointerEvent) => {
      lastWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      setSidebarWidth(lastWidth);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      writeSidebarWidth(lastWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const resizeSidebarBy = (delta: number) => {
    const next = clampSidebarWidth(sidebarWidth + delta);
    setSidebarWidth(next);
    writeSidebarWidth(next);
  };

  const beginRename = (item: SavedModelMeta) => {
    renameCancelled.current = false;
    setRenamingId(item.id);
    setRenameDraft(item.name);
    setOpenMenu(null);
  };

  const commitRename = (item: SavedModelMeta) => {
    if (renameCancelled.current) {
      renameCancelled.current = false;
      return;
    }
    if (renamingId !== item.id) return;

    const name = renameDraft.trim().replace(/\s+/g, " ");
    setRenamingId(null);
    if (!name || name === item.name) return;
    void onRenameModel(item.id, name);
  };

  const startNewGroup = () => {
    const entered = window.prompt(t.libNewGroupPrompt);
    const name = entered?.trim();
    if (!name) return;
    void onCreateGroup(name);
  };

  const commitGroupRename = (from: string, keepOpen = false) => {
    const name = groupDraft.trim().replace(/\s+/g, " ");
    if (!name || name === from) {
      setEditingGroup(null);
      setGroupError(null);
      return;
    }

    const clash = sidebar.some(
      (group) => group.name !== from && group.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) {
      // A silent rename would merge two groups behind the user's back: keep the
      // editor open (Enter) or report it under the list (blur, Escape-free).
      setGroupError(t.libGroupNameTaken(name));
      if (keepOpen) setGroupDraft(name);
      else setEditingGroup(null);
      return;
    }

    setEditingGroup(null);
    setGroupError(null);
    void onRenameGroup(from, name);
  };

  const beginGroupRename = (name: string) => {
    setOpenMenu(null);
    setGroupDraft(name);
    setGroupError(null);
    setEditingGroup(name);
  };

  const confirmDeleteGroup = (name: string) => {
    setOpenMenu(null);
    const count = sidebar.find((group) => group.name === name)?.count ?? 0;
    setGroupDelete({ name, count });
  };

  const commitDeleteGroup = () => {
    if (!groupDelete) return;
    onDeleteGroup(groupDelete.name);
    setGroupDelete(null);
  };

  const moveToNewGroup = (model: SavedModelMeta) => {
    setOpenMenu(null);
    const entered = window.prompt(t.libMoveNewGroupPrompt, "");
    const name = entered?.trim();
    if (!name) return;
    void Promise.resolve(onCreateGroup(name)).then(() => onMoveModel(model.id, name));
  };

  const sortLabels: Record<LibrarySort, string> = {
    recent: t.sortRecent,
    name: t.sortName,
    category: t.sortCategory,
    adjustable: t.sortAdjustable,
  };

  const renderCard = (item: SavedModelMeta) => (
    <div
      key={item.id}
      className={`saved-model-card ${currentModelId === item.id ? "active" : ""}`}
      draggable={renamingId !== item.id}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", item.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => {
        if (renamingId === item.id) return;
        onLoadModel(item.id);
      }}
    >
      <div className="model-thumb">
        {item.thumbUrl ? (
          <img src={item.thumbUrl} alt="" loading="lazy" draggable={false} />
        ) : (
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
          >
            <path d="M3 7l9-4 9 4-9 4-9-4z" />
            <path d="M3 12l9 4 9-4M3 17l9 4 9-4" />
          </svg>
        )}
      </div>
      <div className="card-top">
        <div className="card-actions">
          <div className="card-menu-wrap">
            <button
              type="button"
              className="btn-card-action"
              title={t.moveGroup}
              aria-label={t.libMoveModelTo(item.name)}
              onClick={(event) => {
                event.stopPropagation();
                toggleMenu(event, item.id);
              }}
            >
              <IconFolder />
            </button>
            {openMenu?.key === item.id && (
              <div
                className="card-menu card-menu-fixed"
                style={{ top: openMenu.top, left: openMenu.left }}
                onClick={(event) => event.stopPropagation()}
              >
                <span className="card-menu-label">{t.moveToGroup}</span>
                {[{ name: t.ungrouped, value: UNGROUPED as string }]
                  .concat(
                    sidebar.map((group) => ({ name: group.name, value: group.name as string })),
                  )
                  .filter((option) => option.value !== (item.group ?? ""))
                  .map((option) => (
                    <button
                      key={option.value || "__none"}
                      type="button"
                      onClick={() => {
                        setOpenMenu(null);
                        onMoveModel(item.id, option.value);
                      }}
                    >
                      {option.name}
                    </button>
                  ))}
                <button
                  type="button"
                  className="card-menu-new"
                  onClick={() => moveToNewGroup(item)}
                >
                  {t.newGroupOption}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn-rename-model"
            title={t.renameModel}
            data-testid={`rename-${item.id}`}
            onClick={(event) => {
              event.stopPropagation();
              beginRename(item);
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
          <button
            type="button"
            className="btn-history-model"
            title={t.libHistoryTooltip}
            onClick={(event) => {
              event.stopPropagation();
              onOpenHistory(item.id);
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </button>
          <button
            type="button"
            className="btn-delete-model"
            title={t.deleteModel}
            onClick={(event) => {
              event.stopPropagation();
              onDeleteModel(item.id);
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>

      {renamingId === item.id ? (
        <input
          className="model-name-input"
          value={renameDraft}
          autoFocus
          data-testid={`rename-input-${item.id}`}
          aria-label={t.libRenameModelAria(item.name)}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setRenameDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              renameCancelled.current = true;
              setRenamingId(null);
            }
          }}
          onBlur={() => commitRename(item)}
        />
      ) : (
        <h4 className="model-name" title={item.name}>
          {item.name}
        </h4>
      )}

      <div className="model-chips">
        <span className="chip chip-category">{item.category}</span>
        {item.lod ? <span className="chip">LOD {item.lod}</span> : null}
        {!isAllGroups(activeGroup) && activeGroup !== UNGROUPED ? null : item.group ? (
          <span className="chip chip-group">{item.group}</span>
        ) : null}
      </div>

      <div className="model-meta">
        <span>{t.libPartsCount(item.partsCount)}</span>
        <span>·</span>
        <span>{t.libParamsCount(item.paramsCount)}</span>
        <span>·</span>
        <span>{formatDate(item.updatedAt)}</span>
      </div>

      {item.usability && (
        <div className="model-usability">
          {t.libUsability(item.usability.parameters, item.usability.driving, item.usability.dead)}
        </div>
      )}
    </div>
  );

  const groupMenu = openMenu?.key.startsWith("g:") ? openMenu.group : undefined;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card library-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div className="title-row">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <h3>
              {t.libraryTitle} ({models.length})
            </h3>
          </div>
          <div className="header-actions">
            <button type="button" className="btn-ghost" onClick={onNewModel}>
              + {t.newFamily}
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label={t.close}>
              ×
            </button>
          </div>
        </div>

        <div className="modal-body library-body">
          {historyModelId && (
            <div className="history-panel">
              <div className="history-head">
                <strong>{t.libHistoryFor(currentName)}</strong>
                <button type="button" className="btn-ghost" onClick={onCloseHistory}>
                  {t.close}
                </button>
              </div>
              <p className="sub history-keep">{t.historyKeep(historyKeep)}</p>
              {revisionsLoading ? (
                <p className="sub">{t.libHistoryLoading}</p>
              ) : revisions.length === 0 ? (
                <p className="sub">{t.libHistoryEmpty}</p>
              ) : (
                <div className="history-list">
                  {revisions.map((revision) => (
                    <div key={revision.stamp} className="history-row">
                      <span>{formatDateTime(revision.savedAt)}</span>
                      <span className="sub">
                        {t.libPartsCount(revision.parts)} · {t.libParamsCount(revision.parameters)}
                      </span>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => onRestoreRevision(revision.stamp)}
                      >
                        {t.restore}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div
            className="library-columns"
            style={{ "--library-side-width": `${sidebarWidth}px` } as CSSProperties}
          >
            <aside className="library-side" aria-label={t.libGroupsAria}>
              <button
                type="button"
                className={`library-filter ${isAllGroups(activeGroup) ? "active" : ""}`}
                onClick={() => selectGroup(ALL_GROUPS)}
              >
                <span>{t.allGroups}</span>
                <span className="count">{models.length}</span>
              </button>
              <button
                type="button"
                className={`library-filter ${activeGroup === UNGROUPED ? "active" : ""}`}
                onClick={() => selectGroup(UNGROUPED)}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOverGroup(UNGROUPED);
                }}
                onDragLeave={() => setDragOverGroup(null)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOverGroup(null);
                  const id = event.dataTransfer.getData("text/plain");
                  if (id) onMoveModel(id, UNGROUPED);
                }}
                data-drop-group=""
              >
                <span>{t.ungrouped}</span>
                <span className="count">
                  {models.filter((model) => !(model.group ?? "").trim()).length}
                </span>
              </button>

              <div className="library-group-list">
                {sidebar.map((group) => (
                  <div
                    key={group.name}
                    className={`library-group-row ${activeGroup === group.name ? "active" : ""} ${
                      dragOverGroup === group.name ? "drop-target" : ""
                    } ${editingGroup === group.name ? "editing" : ""}`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragOverGroup(group.name);
                    }}
                    onDragLeave={() => setDragOverGroup(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragOverGroup(null);
                      const id = event.dataTransfer.getData("text/plain");
                      if (id) onMoveModel(id, group.name);
                    }}
                    onContextMenu={(event) => {
                      if (editingGroup === group.name) return;
                      event.preventDefault();
                      openGroupMenuAt(event, group.name, "pointer");
                    }}
                  >
                    {editingGroup === group.name ? (
                      <>
                        <input
                          className={`group-name-input ${groupError ? "invalid" : ""}`}
                          value={groupDraft}
                          autoFocus
                          aria-label={t.libRenameGroupAria(group.name)}
                          aria-invalid={groupError ? true : undefined}
                          data-testid={`group-rename-input-${group.name}`}
                          onChange={(event) => {
                            setGroupDraft(event.target.value);
                            setGroupError(null);
                          }}
                          onFocus={(event) => event.currentTarget.select()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitGroupRename(group.name, true);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              setEditingGroup(null);
                              setGroupError(null);
                            }
                          }}
                          onBlur={() => {
                            if (editingGroup === group.name) commitGroupRename(group.name);
                          }}
                        />
                        {groupError && (
                          <div className="group-name-error" role="alert">
                            {groupError}
                          </div>
                        )}
                      </>
                    ) : (
                      <button
                        type="button"
                        className="library-filter"
                        onClick={() => selectGroup(group.name)}
                        onDoubleClick={(event) => {
                          event.preventDefault();
                          beginGroupRename(group.name);
                        }}
                        title={t.libGroupRowHint(group.name)}
                        data-group-name={group.name}
                      >
                        <span className="group-name">{group.name}</span>
                        <span className="count">{group.count}</span>
                      </button>
                    )}
                    {editingGroup === group.name ? null : (
                      <button
                        type="button"
                        className="group-menu-btn"
                        aria-label={t.libGroupOptionsAria(group.name)}
                        aria-haspopup="menu"
                        title={t.libGroupOptionsAria(group.name)}
                        onClick={(event) => openGroupMenuAt(event, group.name, "button")}
                      >
                        <IconMore />
                      </button>
                    )}
                  </div>
                ))}
                {groupError && !editingGroup && (
                  <div className="group-name-error" role="alert">
                    {groupError}
                  </div>
                )}
              </div>

              <button
                type="button"
                className={`library-filter trash-filter ${showTrash ? "active" : ""}`}
                onClick={() => {
                  setShowTrash(true);
                  setOpenMenu(null);
                }}
              >
                <span>{t.trash}</span>
                <span className="count">{trashItems.length}</span>
              </button>

              <button type="button" className="library-new-group" onClick={startNewGroup}>
                {t.newGroup}
              </button>
            </aside>

            <div
              className="library-side-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={t.resizePanel}
              title={t.resizePanel}
              tabIndex={0}
              onPointerDown={beginSidebarResize}
              onDoubleClick={() => {
                setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
                writeSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  resizeSidebarBy(-12);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  resizeSidebarBy(12);
                }
              }}
            />

            <section className="library-main">
              {!showTrash && (
                <div className="library-toolbar">
                  <input
                    type="search"
                    className="library-search"
                    value={query}
                    placeholder={t.searchModels}
                    aria-label={t.libSearchAria}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <label className="library-sort">
                    <span>{t.sort}</span>
                    <select
                      value={sort}
                      aria-label={t.libSortAria}
                      onChange={(event) => setSort(event.target.value as LibrarySort)}
                    >
                      {SORTS.map((option) => (
                        <option key={option} value={option}>
                          {sortLabels[option]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              {showTrash ? (
                <div className="trash-view">
                  <div className="trash-head">
                    <strong>
                      {t.trash} ({trashItems.length})
                    </strong>
                    <button
                      type="button"
                      className="btn-ghost danger"
                      disabled={trashItems.length === 0}
                      onClick={() => {
                        if (window.confirm(t.confirmEmptyTrash)) onEmptyTrash();
                      }}
                    >
                      {t.emptyTrash}
                    </button>
                  </div>
                  <p className="sub">{t.trashHint}</p>
                  {trashItems.length === 0 ? (
                    <p className="sub library-empty">{t.trashEmpty}</p>
                  ) : (
                    <div className="saved-model-grid">
                      {trashItems.map((item) => (
                        <div key={item.key} className="saved-model-card trash-card">
                          <div className="model-thumb">
                            {item.thumbUrl ? (
                              <img src={item.thumbUrl} alt="" loading="lazy" />
                            ) : (
                              <IconFolder />
                            )}
                          </div>
                          <h4 className="model-name" title={item.name}>
                            {item.name}
                          </h4>
                          <div className="model-meta">
                            <span>{t.daysLeft(item.daysLeft)}</span>
                            {item.group ? (
                              <>
                                <span>·</span>
                                <span>{item.group}</span>
                              </>
                            ) : null}
                          </div>
                          <div className="trash-actions">
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => onRestoreTrash(item.key)}
                            >
                              {t.restore}
                            </button>
                            <button
                              type="button"
                              className="btn-ghost danger"
                              onClick={() => {
                                if (window.confirm(t.confirmPurge)) onPurgeTrash(item.key);
                              }}
                            >
                              {t.deleteForever}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : loading ? (
                <p className="sub">{t.libLibraryLoading}</p>
              ) : models.length === 0 ? (
                <div className="empty-library">
                  <p>{t.libraryEmpty}</p>
                  <p className="sub">{t.libraryEmptyHint}</p>
                </div>
              ) : visible.length === 0 ? (
                <p className="sub library-empty">{t.noMatches}</p>
              ) : isAllGroups(activeGroup) ? (
                <div className="library-sections">
                  {sections.map((section) => {
                    const isCollapsed = collapsed.includes(section.key);
                    return (
                      <div key={section.key || "__ungrouped"} className="library-section">
                        <button
                          type="button"
                          className="library-section-head"
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleSection(section.key)}
                        >
                          <span className={`chevron ${isCollapsed ? "closed" : ""}`}>▾</span>
                          <span className="library-section-title">{section.label}</span>
                          <span className="count">{section.models.length}</span>
                        </button>
                        {!isCollapsed && (
                          <div className="saved-model-grid">{section.models.map(renderCard)}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="saved-model-grid">{visible.map(renderCard)}</div>
              )}
            </section>
          </div>
        </div>
      </div>

      {groupMenu &&
        createPortal(
          <div
            className="card-menu card-menu-fixed group-card-menu"
            role="menu"
            data-testid="group-menu"
            style={{ top: openMenu!.top, left: openMenu!.left }}
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" onClick={() => beginGroupRename(groupMenu)}>
              {t.renameGroup}
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => confirmDeleteGroup(groupMenu)}
            >
              {t.deleteGroup}
            </button>
          </div>,
          document.body,
        )}

      {groupDelete &&
        createPortal(
          <div
            className="modal-backdrop group-delete-backdrop"
            onClick={(event) => {
              event.stopPropagation();
              setGroupDelete(null);
            }}
          >
            <div
              className="modal-card group-delete-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="group-delete-title"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="group-delete-title">{t.libDeleteGroupTitle(groupDelete.name)}</h3>
              <p>{t.libConfirmDeleteGroup(groupDelete.name, t.ungrouped)}</p>
              {groupDelete.count > 0 && (
                <p className="sub">{t.libDeleteGroupCount(groupDelete.count, t.ungrouped)}</p>
              )}
              <div className="group-delete-actions">
                <button type="button" className="btn-ghost" onClick={() => setGroupDelete(null)}>
                  {t.close}
                </button>
                <button
                  type="button"
                  className="btn-primary danger"
                  data-testid="group-delete-confirm"
                  onClick={commitDeleteGroup}
                >
                  {t.deleteGroup}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
