import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type { SavedModelMeta, SavedModelRevision } from "../lib/api";
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
  SORT_LABELS,
} from "../lib/library";

export interface LibraryPanelProps {
  models: SavedModelMeta[];
  groups: LibraryGroupInfo[];
  loading?: boolean;
  currentModelId: string | null;
  /** "" = Chưa nhóm, "*" = Tất cả. */
  activeGroup: string;
  historyModelId: string | null;
  revisions: SavedModelRevision[];
  revisionsLoading: boolean;
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
}

const SORTS: LibrarySort[] = ["recent", "name", "category"];

function formatDate(value: number): string {
  try {
    return new Date(value).toLocaleDateString("vi-VN");
  } catch {
    return "";
  }
}

function IconFolder() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function IconMore() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
}: LibraryPanelProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>(() => readLibraryState().sort);
  const [collapsed, setCollapsed] = useState<string[]>(() => readLibraryState().collapsed);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState("");
  // Menus are positioned with fixed coordinates: the scrollable columns would clip
  // an absolutely positioned dropdown that reaches past their edge.
  const [openMenu, setOpenMenu] = useState<{ key: string; top: number; left: number } | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const renameCancelled = useRef(false);

  const sidebar = useMemo(() => sidebarGroups(models, groups), [models, groups]);
  const visible = useMemo(
    () => visibleModels(models, { group: activeGroup, query, sort }),
    [models, activeGroup, query, sort],
  );
  const sections = useMemo(
    () => buildSections(visible, groups, sort),
    [visible, groups, sort],
  );
  const currentName =
    models.find((model) => model.id === historyModelId)?.name ?? historyModelId ?? "";

  useEffect(() => {
    writeLibraryState({ sort, collapsed });
  }, [sort, collapsed]);

  const MENU_WIDTH = 176;

  const toggleMenu = (event: ReactMouseEvent<HTMLButtonElement>, key: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    setOpenMenu((current) =>
      current?.key === key ? null : { key, top: rect.bottom + 6, left },
    );
  };

  // A menu pinned to the viewport must not survive a scroll or a click elsewhere.
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".card-menu, .card-menu-wrap, .group-menu-wrap")) return;
      setOpenMenu(null);
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [openMenu]);

  const selectGroup = (group: string) => {
    onActiveGroup(group);
    writeLibraryState({ group });
    setOpenMenu(null);
  };

  const toggleSection = (key: string) => {
    setCollapsed((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
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
    const entered = window.prompt("Tên nhóm mới:");
    const name = entered?.trim();
    if (!name) return;
    void onCreateGroup(name);
  };

  const commitGroupRename = (from: string) => {
    const name = groupDraft.trim();
    setEditingGroup(null);
    if (!name || name === from) return;
    void onRenameGroup(from, name);
  };

  const confirmDeleteGroup = (name: string) => {
    setOpenMenu(null);
    if (
      !window.confirm(
        `Xoá nhóm "${name}"? Các family trong nhóm sẽ chuyển về "Chưa nhóm" và không bị xoá.`,
      )
    ) {
      return;
    }
    onDeleteGroup(name);
  };

  const moveToNewGroup = (model: SavedModelMeta) => {
    setOpenMenu(null);
    const entered = window.prompt("Chuyển family vào nhóm mới:", "");
    const name = entered?.trim();
    if (!name) return;
    void Promise.resolve(onCreateGroup(name)).then(() => onMoveModel(model.id, name));
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
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
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
              title="Chuyển nhóm"
              aria-label={`Chuyển ${item.name} sang nhóm khác`}
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
                <span className="card-menu-label">Chuyển vào nhóm</span>
                {[{ name: "Chưa nhóm", value: UNGROUPED as string }]
                  .concat(sidebar.map((group) => ({ name: group.name, value: group.name as string })))
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
                <button type="button" className="card-menu-new" onClick={() => moveToNewGroup(item)}>
                  + Nhóm mới…
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn-rename-model"
            title="Đổi tên mô hình"
            data-testid={`rename-${item.id}`}
            onClick={(event) => {
              event.stopPropagation();
              beginRename(item);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
          <button
            type="button"
            className="btn-history-model"
            title="Xem lịch sử các bản lưu"
            onClick={(event) => {
              event.stopPropagation();
              onOpenHistory(item.id);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </button>
          <button
            type="button"
            className="btn-delete-model"
            title="Xoá mô hình này"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteModel(item.id);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
          aria-label={`Tên mới cho ${item.name}`}
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
        <span>{item.partsCount} parts</span>
        <span>·</span>
        <span>{item.paramsCount} params</span>
        <span>·</span>
        <span>{formatDate(item.updatedAt)}</span>
      </div>
    </div>
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card library-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div className="title-row">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <h3>Thư viện mô hình đã lưu ({models.length})</h3>
          </div>
          <div className="header-actions">
            <button type="button" className="btn-ghost" onClick={onNewModel}>
              + Dựng mô hình mới
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label="Đóng thư viện">
              ×
            </button>
          </div>
        </div>

        <div className="modal-body library-body">
          {historyModelId && (
            <div className="history-panel">
              <div className="history-head">
                <strong>Lịch sử: {currentName}</strong>
                <button type="button" className="btn-ghost" onClick={onCloseHistory}>
                  Đóng
                </button>
              </div>
              {revisionsLoading ? (
                <p className="sub">Đang tải lịch sử…</p>
              ) : revisions.length === 0 ? (
                <p className="sub">
                  Chưa có bản cũ. Lịch sử bắt đầu ghi từ lần Save tiếp theo của mô hình này.
                </p>
              ) : (
                <div className="history-list">
                  {revisions.map((revision) => (
                    <div key={revision.stamp} className="history-row">
                      <span>{new Date(revision.savedAt).toLocaleString("vi-VN")}</span>
                      <span className="sub">
                        {revision.parts} parts · {revision.parameters} params
                      </span>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => onRestoreRevision(revision.stamp)}
                      >
                        Khôi phục
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="library-columns">
            <aside className="library-side" aria-label="Nhóm mô hình">
              <button
                type="button"
                className={`library-filter ${isAllGroups(activeGroup) ? "active" : ""}`}
                onClick={() => selectGroup(ALL_GROUPS)}
              >
                <span>Tất cả</span>
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
                <span>Chưa nhóm</span>
                <span className="count">{models.filter((model) => !(model.group ?? "").trim()).length}</span>
              </button>

              <div className="library-group-list">
                {sidebar.map((group) => (
                  <div
                    key={group.name}
                    className={`library-group-row ${activeGroup === group.name ? "active" : ""} ${
                      dragOverGroup === group.name ? "drop-target" : ""
                    }`}
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
                  >
                    {editingGroup === group.name ? (
                      <input
                        className="group-name-input"
                        value={groupDraft}
                        autoFocus
                        aria-label={`Tên mới cho nhóm ${group.name}`}
                        onChange={(event) => setGroupDraft(event.target.value)}
                        onFocus={(event) => event.currentTarget.select()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setEditingGroup(null);
                          }
                        }}
                        onBlur={() => commitGroupRename(group.name)}
                      />
                    ) : (
                      <button
                        type="button"
                        className="library-filter"
                        onClick={() => selectGroup(group.name)}
                        title={group.name}
                      >
                        <span className="group-name">{group.name}</span>
                        <span className="count">{group.count}</span>
                      </button>
                    )}
                    <div className="group-menu-wrap">
                      <button
                        type="button"
                        className="group-menu-btn"
                        aria-label={`Tùy chọn cho nhóm ${group.name}`}
                        onClick={(event) => toggleMenu(event, `g:${group.name}`)}
                      >
                        <IconMore />
                      </button>
                      {openMenu?.key === `g:${group.name}` && (
                        <div
                          className="card-menu card-menu-fixed"
                          style={{ top: openMenu.top, left: openMenu.left }}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setOpenMenu(null);
                              setGroupDraft(group.name);
                              setEditingGroup(group.name);
                            }}
                          >
                            Đổi tên nhóm
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => confirmDeleteGroup(group.name)}
                          >
                            Xoá nhóm
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <button type="button" className="library-new-group" onClick={startNewGroup}>
                + Nhóm mới
              </button>
            </aside>

            <section className="library-main">
              <div className="library-toolbar">
                <input
                  type="search"
                  className="library-search"
                  value={query}
                  placeholder="Tìm theo tên hoặc category…"
                  aria-label="Tìm mô hình"
                  onChange={(event) => setQuery(event.target.value)}
                />
                <label className="library-sort">
                  <span>Sắp xếp</span>
                  <select
                    value={sort}
                    aria-label="Sắp xếp danh sách mô hình"
                    onChange={(event) => setSort(event.target.value as LibrarySort)}
                  >
                    {SORTS.map((option) => (
                      <option key={option} value={option}>
                        {SORT_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {loading ? (
                <p className="sub">Đang tải thư viện…</p>
              ) : models.length === 0 ? (
                <div className="empty-library">
                  <p>Chưa có mô hình nào được lưu trong thư viện.</p>
                  <p className="sub">
                    Khi đang xem hoặc chỉnh sửa 1 mô hình trên Web, bấm nút <strong>Save</strong> trên thanh
                    trên cùng để lưu lại.
                  </p>
                </div>
              ) : visible.length === 0 ? (
                <p className="sub library-empty">Không có mô hình nào khớp tìm kiếm trong mục này.</p>
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
    </div>
  );
}
