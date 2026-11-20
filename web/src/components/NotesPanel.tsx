import { useState } from "react";
import type { ModelNote } from "../lib/annotations";
import { useI18n } from "../lib/i18n";

interface Props {
  notes: ModelNote[];
  partIds: string[];
  sending?: boolean;
  onFocusNote: (note: ModelNote) => void;
  onUpdateNote: (id: string, text: string) => void;
  onDeleteNote: (id: string) => void;
  onToggleResolved: (id: string) => void;
  onSendNote: (note: ModelNote) => void;
  onSendAll: () => void;
}

export function NotesPanel({
  notes,
  partIds,
  sending,
  onFocusNote,
  onUpdateNote,
  onDeleteNote,
  onToggleResolved,
  onSendNote,
  onSendAll,
}: Props) {
  const { t, formatNumber } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const openNotes = notes.filter((note) => note.status !== "resolved");
  const liveParts = new Set(partIds);

  const beginEdit = (note: ModelNote) => {
    setEditingId(note.id);
    setDraft(note.text);
  };

  const commitEdit = () => {
    const text = draft.trim();
    if (editingId && text) onUpdateNote(editingId, text);
    setEditingId(null);
  };

  return (
    <div className="notes-panel" data-testid="notes-panel">
      <div className="notes-panel-head">
        <div>
          <div className="notes-panel-title">{t.paramsNotesTitle}</div>
          <div className="notes-panel-sub">{t.paramsNotesHint}</div>
        </div>
        {openNotes.length > 0 && (
          <button
            type="button"
            className="btn-primary notes-send-all"
            disabled={sending}
            onClick={onSendAll}
          >
            {t.paramsNoteSendAll(formatNumber(openNotes.length))}
          </button>
        )}
      </div>

      {notes.length === 0 ? (
        <div className="pane-empty small">{t.paramsNotesEmpty}</div>
      ) : (
        <div className="notes-list">
          {notes.map((note, index) => {
            const missing = !liveParts.has(note.partId);
            const editing = editingId === note.id;
            return (
              <div
                key={note.id}
                className={`note-card${note.status === "resolved" ? " resolved" : ""}${
                  missing ? " stale" : ""
                }`}
                data-note-id={note.id}
              >
                <button
                  type="button"
                  className="note-card-main"
                  onClick={() => onFocusNote(note)}
                  title={t.paramsNoteFocusHint}
                >
                  <span className="note-pin-number">{index + 1}</span>
                  <span className="note-card-copy">
                    <span className="note-card-part">
                      {note.partName || note.partId}
                      {note.status === "resolved" && (
                        <span className="note-resolved-badge">{t.paramsNoteResolvedBadge}</span>
                      )}
                      {missing && <span className="note-stale"> · {t.viewerNoteChanged}</span>}
                    </span>
                    {!editing && <span className="note-card-text">{note.text}</span>}
                  </span>
                </button>

                {editing ? (
                  <div className="note-edit">
                    <textarea
                      autoFocus
                      rows={3}
                      maxLength={2000}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setEditingId(null);
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          commitEdit();
                        }
                      }}
                    />
                    <div className="note-card-actions">
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setEditingId(null)}
                      >
                        {t.paramsNoteCancel}
                      </button>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={!draft.trim()}
                        onClick={commitEdit}
                      >
                        {t.paramsNoteSave}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="note-card-actions">
                    {note.status === "resolved" ? (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => onToggleResolved(note.id)}
                      >
                        {t.paramsNoteReopen}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={sending}
                          onClick={() => onSendNote(note)}
                        >
                          {t.paramsNoteSend}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => onToggleResolved(note.id)}
                        >
                          {t.paramsNoteResolve}
                        </button>
                      </>
                    )}
                    <button type="button" className="btn-ghost" onClick={() => beginEdit(note)}>
                      {t.paramsNoteEdit}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost danger"
                      onClick={() => {
                        if (window.confirm(t.paramsNoteDeleteConfirm)) onDeleteNote(note.id);
                      }}
                    >
                      {t.paramsNoteDelete}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
