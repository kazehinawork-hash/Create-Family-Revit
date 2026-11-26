import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import * as THREE from "three";
import { clientToNdc, wasDragged, type ViewerInteractionContext } from "./interactionContext";

export interface PickHoverSelectOptions {
  handlesGroup: THREE.Group;
  measuringRef: MutableRefObject<boolean>;
  pickingSectionRef: MutableRefObject<boolean>;
  hoverBlockedRef: MutableRefObject<boolean>;
  sectionDragMovedRef: MutableRefObject<boolean>;
  pickedPartIdsRef: MutableRefObject<string[]>;
  onSelectPartRef: MutableRefObject<((partId: string | null) => void) | undefined>;
  setPickedPartIds: Dispatch<SetStateAction<string[]>>;
  setHoveredPartId: Dispatch<SetStateAction<string | null>>;
  setHoverInfo: Dispatch<SetStateAction<{ x: number; y: number; name: string } | null>>;
  onPickSectionFace: (normal: THREE.Vector3, base: THREE.Vector3) => void;
}

/** Handles part hover tooltips, left-click selection / Ctrl multi-select, and section face picking. */
export function attachPickHoverSelect(
  ctx: ViewerInteractionContext,
  options: PickHoverSelectOptions,
): () => void {
  const { renderer, camera, pickPartAt } = ctx;
  const {
    handlesGroup,
    measuringRef,
    pickingSectionRef,
    hoverBlockedRef,
    sectionDragMovedRef,
    pickedPartIdsRef,
    onSelectPartRef,
    setPickedPartIds,
    setHoveredPartId,
    setHoverInfo,
    onPickSectionFace,
  } = options;

  let downPos = { x: 0, y: 0 };
  let hoverFrame = 0;
  const clickPointer = new THREE.Vector2();
  const clickRaycaster = new THREE.Raycaster();

  const clearHover = () => {
    setHoveredPartId((current) => (current === null ? current : null));
    setHoverInfo((current) => (current === null ? current : null));
  };

  const onMouseDown = (event: MouseEvent) => {
    downPos = { x: event.clientX, y: event.clientY };
  };

  const onHoverMove = (event: MouseEvent) => {
    if (event.buttons || hoverBlockedRef.current) {
      clearHover();
      return;
    }
    if (hoverFrame) return;
    const x = event.clientX;
    const y = event.clientY;

    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const picked = pickPartAt(x, y);
      const partId = picked?.partId ?? null;
      const name = picked?.partName ?? "";

      setHoveredPartId((current) => (current === partId ? current : partId));
      setHoverInfo((current) => {
        if (!partId) return current === null ? current : null;
        return { x: x - rect.left, y: y - rect.top, name };
      });
    });
  };

  const onClick = (event: MouseEvent) => {
    if (sectionDragMovedRef.current || wasDragged(downPos, event)) return;
    if (measuringRef.current) return;

    if (pickingSectionRef.current) {
      const hit = pickPartAt(event.clientX, event.clientY)?.hit;
      if (hit?.face) {
        const mesh = hit.object as THREE.Mesh;
        const normal = hit.face.normal
          .clone()
          .transformDirection(mesh.matrixWorld)
          .normalize()
          .negate();
        onPickSectionFace(normal, hit.point.clone());
      } else {
        onPickSectionFace(new THREE.Vector3(), new THREE.Vector3());
      }
      return;
    }

    if (!clientToNdc(renderer.domElement, event.clientX, event.clientY, clickPointer)) return;
    clickRaycaster.setFromCamera(clickPointer, camera);
    if (clickRaycaster.intersectObjects(handlesGroup.children, true).length > 0) return;

    const picked = pickPartAt(event.clientX, event.clientY);
    if (!picked) {
      setPickedPartIds([]);
      pickedPartIdsRef.current = [];
      onSelectPartRef.current?.(null);
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      const next = pickedPartIdsRef.current.includes(picked.partId)
        ? pickedPartIdsRef.current.filter((id) => id !== picked.partId)
        : [...pickedPartIdsRef.current, picked.partId];
      pickedPartIdsRef.current = next;
      setPickedPartIds(next);
      onSelectPartRef.current?.(next[next.length - 1] ?? null);
    } else {
      setPickedPartIds([picked.partId]);
      pickedPartIdsRef.current = [picked.partId];
      onSelectPartRef.current?.(picked.partId);
    }
  };

  const el = renderer.domElement;
  el.addEventListener("mousedown", onMouseDown);
  el.addEventListener("click", onClick);
  el.addEventListener("pointermove", onHoverMove);
  el.addEventListener("mousemove", onHoverMove);
  el.addEventListener("pointerleave", clearHover);
  el.addEventListener("mouseleave", clearHover);

  return () => {
    if (hoverFrame) cancelAnimationFrame(hoverFrame);
    el.removeEventListener("mousedown", onMouseDown);
    el.removeEventListener("click", onClick);
    el.removeEventListener("pointermove", onHoverMove);
    el.removeEventListener("mousemove", onHoverMove);
    el.removeEventListener("pointerleave", clearHover);
    el.removeEventListener("mouseleave", clearHover);
  };
}
