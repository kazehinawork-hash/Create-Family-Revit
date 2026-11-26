import { useState, type Dispatch, type SetStateAction } from "react";
import type { FamilySpec } from "@family/spec-core";
import type { ChatTarget, ModelNote } from "../lib/annotations";
import { targetFromNote } from "../lib/annotations";
import { uploadDocument, type UploadedDocument } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useStudio } from "./StudioContext";

interface UseDesignAttachmentsOptions {
  running: boolean;
  sendPrompt: (
    text: string,
    specOverride?: FamilySpec,
    options?: { fresh?: boolean; targets?: ChatTarget[]; noteIds?: string[] },
  ) => Promise<void>;
  setMobileTab: Dispatch<SetStateAction<"chat" | "viewer" | "params">>;
}

export function useDesignAttachments({
  running,
  sendPrompt,
  setMobileTab,
}: UseDesignAttachmentsOptions) {
  const { t, formatNumber } = useI18n();
  const { state, dispatch } = useStudio();
  const { modelNotes } = state;
  const [attachments, setAttachments] = useState<UploadedDocument[]>([]);
  const [uploading, setUploading] = useState(false);

  const handleAttach = async (files: File[]) => {
    setUploading(true);
    try {
      const uploaded: UploadedDocument[] = [];
      for (const file of files) {
        uploaded.push(await uploadDocument(file));
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

  const clearAttachments = () => setAttachments([]);

  const handleSendPartsToChat = (incoming: ChatTarget[]) => {
    dispatch({ type: "ADD_CHAT_TARGETS", targets: incoming });
    setMobileTab("chat");
  };

  const handleRemoveTarget = (index: number) => {
    dispatch({ type: "REMOVE_CHAT_TARGET", index });
  };

  const sendNotesToAgent = (notes: ModelNote[]) => {
    if (notes.length === 0 || running) return;
    const text =
      notes.length === 1
        ? t.appSendNotePrompt(notes[0].text)
        : t.appSendAllNotesPrompt(formatNumber(notes.length));
    void sendPrompt(text, undefined, {
      targets: notes.map(targetFromNote),
      noteIds: notes.map((note) => note.id),
    });
    setMobileTab("chat");
  };

  const handleSendNote = (note: ModelNote) => sendNotesToAgent([note]);

  const handleSendAllNotes = () => {
    sendNotesToAgent(modelNotes.filter((note) => note.status !== "resolved"));
  };

  return {
    attachments,
    uploading,
    clearAttachments,
    handleAttach,
    handleRemoveAttachment,
    handleSendPartsToChat,
    handleRemoveTarget,
    handleSendNote,
    handleSendAllNotes,
  };
}
