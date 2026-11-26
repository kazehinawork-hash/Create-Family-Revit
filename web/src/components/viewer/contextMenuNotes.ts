import type { ResolvedModel } from "@family/spec-core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import * as THREE from "three";
import type { ContextMenuState, NoteComposerState } from "./types";
import { wasDragged, type ViewerInteractionContext } from "./interactionContext";

export interface ContextMenuNotesOptions {
  modelRef: MutableRefObject<ResolvedModel | null>;
  pickedPartIdsRef: MutableRefObject<string[]>;
  onSelectPartRef: MutableRefObject<((partId: string | null) => void) | undefined>;
  setPickedPartIds: Dispatch<SetStateAction<string[]>>;
  setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
  setNoteComposer: Dispatch<SetStateAction<NoteComposerState | null>>;
}

/** Handles dismissing open menus/composers on pointer press and opening the part context menu. */
export function attachContextMenuNotes(
  ctx: ViewerInteractionContext,
  options: ContextMenuNotesOptions,
): () => void {
  const { renderer, camera, pickPartAt } = ctx;
  const {
    modelRef,
    pickedPartIdsRef,
    onSelectPartRef,
    setPickedPartIds,
    setContextMenu,
    setNoteComposer,
  } = options;

  let downPos = { x: 0, y: 0 };

  const onMouseDown = (event: MouseEvent) => {
    downPos = { x: event.clientX, y: event.clientY };
    setContextMenu(null);
    setNoteComposer(null);
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    if (wasDragged(downPos, event)) return;

    const picked = pickPartAt(event.clientX, event.clientY);
    if (!picked) {
      setContextMenu(null);
      return;
    }

    const { hit, partId, object } = picked;
    const partDef = modelRef.current?.parts.find((p) => p.id === partId);
    const partName = partDef?.name || picked.partName || partId;
    const mesh = hit.object as THREE.Mesh;

    const surfaceNormal = hit.face
      ? hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize()
      : null;
    const normal = surfaceNormal
      ? surfaceNormal.clone().negate()
      : camera.getWorldDirection(new THREE.Vector3());

    const box = new THREE.Box3().setFromObject(object);
    const center = !box.isEmpty() ? box.getCenter(new THREE.Vector3()) : hit.point.clone();

    if (!pickedPartIdsRef.current.includes(partId)) {
      setPickedPartIds([partId]);
      pickedPartIdsRef.current = [partId];
    }
    onSelectPartRef.current?.(partId);
    setContextMenu({
      partId,
      partName,
      x: event.clientX,
      y: event.clientY,
      normal,
      surfaceNormal,
      point: hit.point.clone(),
      center,
    });
  };

  const el = renderer.domElement;
  el.addEventListener("mousedown", onMouseDown);
  el.addEventListener("contextmenu", onContextMenu);

  return () => {
    el.removeEventListener("mousedown", onMouseDown);
    el.removeEventListener("contextmenu", onContextMenu);
  };
}
