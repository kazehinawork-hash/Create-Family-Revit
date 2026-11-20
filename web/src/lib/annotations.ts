export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** A part the user explicitly pointed at in the viewer, optionally with a pinned note. */
export interface ChatTarget {
  partId: string;
  partName: string;
  point?: Vec3Like;
  normal?: Vec3Like;
  note?: string;
  noteId?: string;
}

export type ModelNoteStatus = "open" | "resolved";

/** A note pinned on the model surface. Coordinates are in spec units (mm). */
export interface ModelNote {
  id: string;
  partId: string;
  partName: string;
  point: Vec3Like;
  normal?: Vec3Like;
  text: string;
  status: ModelNoteStatus;
  createdAt: number;
  resolvedAt?: number;
}

export interface NoteDraft {
  partId: string;
  partName: string;
  point: Vec3Like;
  normal?: Vec3Like;
  text: string;
}

export function roundVec3(value: Vec3Like): Vec3Like {
  return {
    x: Math.round(value.x * 10) / 10,
    y: Math.round(value.y * 10) / 10,
    z: Math.round(value.z * 10) / 10,
  };
}

export function targetFromNote(note: ModelNote): ChatTarget {
  return {
    partId: note.partId,
    partName: note.partName,
    point: note.point,
    normal: note.normal,
    note: note.text,
    noteId: note.id,
  };
}

export function sameTarget(a: ChatTarget, b: ChatTarget): boolean {
  return a.partId === b.partId && (a.noteId ?? "") === (b.noteId ?? "");
}

export function mergeTargets(current: ChatTarget[], incoming: ChatTarget[]): ChatTarget[] {
  const next = [...current];
  for (const target of incoming) {
    const index = next.findIndex((item) => sameTarget(item, target));
    if (index >= 0) next[index] = target;
    else next.push(target);
  }
  return next;
}
