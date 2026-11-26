import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SectionDragData } from "./types";
import { clientToNdc, type ViewerInteractionContext } from "./interactionContext";

export interface SectionDragOptions {
  controls: OrbitControls;
  sectionArrowRef: MutableRefObject<THREE.Object3D | null>;
  sectionDragRef: MutableRefObject<boolean>;
  sectionDragMovedRef: MutableRefObject<boolean>;
  sectionDragDataRef: MutableRefObject<SectionDragData | null>;
  setSectionT: Dispatch<SetStateAction<number>>;
}

/** Handles hovering and dragging the 3D section-plane arrow handle along the plane normal. */
export function attachSectionDrag(
  ctx: ViewerInteractionContext,
  options: SectionDragOptions,
): () => void {
  const { renderer, camera } = ctx;
  const {
    controls,
    sectionArrowRef,
    sectionDragRef,
    sectionDragMovedRef,
    sectionDragDataRef,
    setSectionT,
  } = options;

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const onPointerDown = (event: PointerEvent) => {
    const arrow = sectionArrowRef.current;
    const data = sectionDragDataRef.current;
    if (!arrow || !data) return;
    if (!clientToNdc(renderer.domElement, event.clientX, event.clientY, pointer)) return;
    raycaster.setFromCamera(pointer, camera);
    if (raycaster.intersectObject(arrow, true).length === 0) return;

    event.stopPropagation();
    event.preventDefault();
    sectionDragRef.current = true;
    controls.enabled = false;
    renderer.domElement.style.cursor = "grabbing";
  };

  const onPointerMove = (event: PointerEvent) => {
    const data = sectionDragDataRef.current;
    if (sectionDragRef.current && data) {
      if (!clientToNdc(renderer.domElement, event.clientX, event.clientY, pointer)) return;
      raycaster.setFromCamera(pointer, camera);

      const span = data.range * 2;
      const start = data.origin.clone().addScaledVector(data.normal, -span);
      const end = data.origin.clone().addScaledVector(data.normal, span);
      const hitPoint = new THREE.Vector3();
      raycaster.ray.distanceSqToSegment(start, end, undefined, hitPoint);
      const offset = hitPoint.sub(data.origin).dot(data.normal);
      setSectionT(Math.min(1, Math.max(0, 0.5 + (data.sign * offset) / data.range)));
      return;
    }

    const arrow = sectionArrowRef.current;
    if (!arrow || renderer.domElement.style.cursor === "pointer") {
      if (renderer.domElement.style.cursor === "grab") renderer.domElement.style.cursor = "default";
      return;
    }
    if (!clientToNdc(renderer.domElement, event.clientX, event.clientY, pointer)) return;
    raycaster.setFromCamera(pointer, camera);
    if (raycaster.intersectObject(arrow, true).length > 0) {
      renderer.domElement.style.cursor = "grab";
    } else if (renderer.domElement.style.cursor === "grab") {
      renderer.domElement.style.cursor = "default";
    }
  };

  const onPointerUp = () => {
    if (!sectionDragRef.current) return;
    sectionDragRef.current = false;
    sectionDragMovedRef.current = true;
    controls.enabled = true;
    renderer.domElement.style.cursor = "";
    // Clear on the next task so any click listener firing after pointerup sees the guard first.
    setTimeout(() => {
      sectionDragMovedRef.current = false;
    }, 0);
  };

  const el = renderer.domElement;
  el.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  return () => {
    el.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };
}
