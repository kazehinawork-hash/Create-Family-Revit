import * as THREE from "three";

export const CLICK_DRAG_TOLERANCE_PX = 6;

export interface PickedPartHit {
  hit: THREE.Intersection;
  partId: string;
  partName: string;
  object: THREE.Object3D;
}

export interface ViewerInteractionContext {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  content: THREE.Group;
  pickPartAt: (clientX: number, clientY: number) => PickedPartHit | null;
  requestRender: () => void;
}

export function clientToNdc(
  domElement: HTMLElement,
  clientX: number,
  clientY: number,
  out = new THREE.Vector2(),
): THREE.Vector2 | null {
  const rect = domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return out.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
}

export function wasDragged(downPos: { x: number; y: number }, event: MouseEvent): boolean {
  return (
    Math.abs(event.clientX - downPos.x) > CLICK_DRAG_TOLERANCE_PX ||
    Math.abs(event.clientY - downPos.y) > CLICK_DRAG_TOLERANCE_PX
  );
}

function partAtObject(
  object: THREE.Object3D,
  root: THREE.Group,
): { partId: string; partName: string; object: THREE.Object3D } | null {
  let current: THREE.Object3D | null = object;
  while (current && current !== root) {
    const partId = current.userData?.partId as string | undefined;
    if (partId) {
      return {
        partId,
        partName: (current.userData?.partName as string) || partId,
        object: current,
      };
    }
    current = current.parent;
  }
  return null;
}

function visibleInTree(object: THREE.Object3D, root: THREE.Group): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return true;
}

/** Shared lightweight interaction context: camera, renderer, content root, picking & render trigger. */
export function createInteractionContext(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  content: THREE.Group,
  requestRender: () => void,
): ViewerInteractionContext {
  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();

  const pickPartAt = (clientX: number, clientY: number): PickedPartHit | null => {
    if (!clientToNdc(renderer.domElement, clientX, clientY, pointer)) return null;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(content.children, true);
    for (const hit of hits) {
      if (!(hit.object as THREE.Mesh).isMesh || !visibleInTree(hit.object, content)) continue;
      if (renderer.clippingPlanes?.some((plane) => plane.distanceToPoint(hit.point) < 0)) {
        continue;
      }
      const part = partAtObject(hit.object, content);
      if (part) return { hit, ...part };
    }
    return null;
  };

  return { renderer, camera, content, pickPartAt, requestRender };
}
