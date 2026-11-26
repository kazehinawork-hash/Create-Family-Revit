import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ActiveHandleState } from "./types";
import { clientToNdc, type ViewerInteractionContext } from "./interactionContext";

export interface ParamHandleDragOptions {
  controls: OrbitControls;
  handlesGroup: THREE.Group;
  sectionDragRef: MutableRefObject<boolean>;
  onUpdateParameterRef: MutableRefObject<((name: string, value: number) => void) | undefined>;
  setActiveHandle: Dispatch<SetStateAction<ActiveHandleState | null>>;
}

interface ActiveDragHandle {
  arrow: THREE.Object3D;
  axis: "x" | "y" | "z";
  dir: number;
  paramName: string;
  initialVal: number;
  dragPlane: THREE.Plane;
  startPoint: THREE.Vector3;
}

/** Handles hovering and dragging parametric dimension arrows attached to the selected part. */
export function attachParamHandleDrag(
  ctx: ViewerInteractionContext,
  options: ParamHandleDragOptions,
): () => void {
  const { renderer, camera } = ctx;
  const { controls, handlesGroup, sectionDragRef, onUpdateParameterRef, setActiveHandle } = options;

  let draggingHandle: ActiveDragHandle | null = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const onMouseDown = (event: MouseEvent) => {
    if (!clientToNdc(renderer.domElement, event.clientX, event.clientY, pointer)) return;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(handlesGroup.children, true);
    if (hits.length === 0) return;

    let handleObj: THREE.Object3D | null = hits[0].object;
    while (
      handleObj &&
      !handleObj.userData.isShapeHandle &&
      handleObj.parent !== handlesGroup &&
      handleObj.parent
    ) {
      handleObj = handleObj.parent;
    }

    if (!handleObj || !handleObj.userData.isShapeHandle) return;

    event.stopPropagation();
    controls.enabled = false;

    const axis = handleObj.userData.axis as "x" | "y" | "z";
    const dir = handleObj.userData.dir as number;
    const paramName = handleObj.userData.paramName as string;
    const initialVal = handleObj.userData.currentVal as number;

    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir.negate(), handleObj.position);
    const startIntersection = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, startIntersection);

    draggingHandle = {
      arrow: handleObj,
      axis,
      dir,
      paramName,
      initialVal,
      dragPlane: plane,
      startPoint: startIntersection.clone(),
    };

    const rect = renderer.domElement.getBoundingClientRect();
    const screenPos = handleObj.position.clone().project(camera);
    setActiveHandle({
      label: paramName,
      value: Math.round(initialVal),
      screenX: ((screenPos.x + 1) / 2) * rect.width,
      screenY: ((-screenPos.y + 1) / 2) * rect.height,
    });
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!draggingHandle) {
      if (sectionDragRef.current) return;
      if (!clientToNdc(renderer.domElement, event.clientX, event.clientY, pointer)) return;
      raycaster.setFromCamera(pointer, camera);
      if (raycaster.intersectObjects(handlesGroup.children, true).length > 0) {
        renderer.domElement.style.cursor = "pointer";
      } else if (renderer.domElement.style.cursor === "pointer") {
        renderer.domElement.style.cursor = "default";
      }
      return;
    }

    if (!clientToNdc(renderer.domElement, event.clientX, event.clientY, pointer)) return;
    raycaster.setFromCamera(pointer, camera);
    const rect = renderer.domElement.getBoundingClientRect();

    const currentIntersection = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(draggingHandle.dragPlane, currentIntersection)) {
      const deltaWorld = currentIntersection.clone().sub(draggingHandle.startPoint);
      const axisVector = new THREE.Vector3();
      axisVector[draggingHandle.axis] = 1;

      const axisDelta = deltaWorld.dot(axisVector) * draggingHandle.dir;
      const snapped = Math.max(50, Math.round((draggingHandle.initialVal + axisDelta * 2) / 10) * 10);

      const screenPos = draggingHandle.arrow.position.clone().project(camera);
      setActiveHandle({
        label: draggingHandle.paramName,
        value: snapped,
        screenX: ((screenPos.x + 1) / 2) * rect.width,
        screenY: ((-screenPos.y + 1) / 2) * rect.height,
      });

      onUpdateParameterRef.current?.(draggingHandle.paramName, snapped);
    }
  };

  const onMouseUp = () => {
    if (!draggingHandle) return;
    draggingHandle = null;
    controls.enabled = true;
    setTimeout(() => setActiveHandle(null), 1200);
  };

  const el = renderer.domElement;
  el.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  return () => {
    el.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  };
}
