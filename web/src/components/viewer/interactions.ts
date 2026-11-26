import type { ResolvedModel } from "@family/spec-core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Strings } from "../../lib/strings";
import { snapToAxis } from "./sceneHelpers";
import type {
  ActiveHandleState,
  ContextMenuState,
  NoteComposerState,
  SectionCustomState,
  SectionDragData,
} from "./types";

export interface ViewerInteractionDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  handlesGroup: THREE.Group;
  modelRef: MutableRefObject<ResolvedModel | null>;
  tRef: MutableRefObject<Strings>;
  formatNumberRef: MutableRefObject<(value: number) => string>;
  renderDirtyRef: MutableRefObject<boolean>;
  measuringRef: MutableRefObject<boolean>;
  pickingSectionRef: MutableRefObject<boolean>;
  hoverBlockedRef: MutableRefObject<boolean>;
  measurePointsRef: MutableRefObject<THREE.Vector3[]>;
  measureSegmentsRef: MutableRefObject<THREE.Group[]>;
  measureMarkersRef: MutableRefObject<THREE.Mesh[]>;
  measurePreviewGroupRef: MutableRefObject<THREE.Group | null>;
  sectionArrowRef: MutableRefObject<THREE.Object3D | null>;
  sectionDragRef: MutableRefObject<boolean>;
  sectionDragMovedRef: MutableRefObject<boolean>;
  sectionDragDataRef: MutableRefObject<SectionDragData | null>;
  pickedPartIdsRef: MutableRefObject<string[]>;
  onSelectPartRef: MutableRefObject<((partId: string | null) => void) | undefined>;
  onUpdateParameterRef: MutableRefObject<((name: string, value: number) => void) | undefined>;
  setActiveHandle: Dispatch<SetStateAction<ActiveHandleState | null>>;
  setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
  setNoteComposer: Dispatch<SetStateAction<NoteComposerState | null>>;
  setHoveredPartId: Dispatch<SetStateAction<string | null>>;
  setHoverInfo: Dispatch<SetStateAction<{ x: number; y: number; name: string } | null>>;
  setPickedPartIds: Dispatch<SetStateAction<string[]>>;
  setMeasureLabel: Dispatch<SetStateAction<string | null>>;
  setMeasureCount: Dispatch<SetStateAction<number>>;
  setSectionCustom: Dispatch<SetStateAction<SectionCustomState | null>>;
  setSectionAxis: Dispatch<SetStateAction<"off" | "x" | "y" | "z" | "custom">>;
  setSectionT: Dispatch<SetStateAction<number>>;
  setPickingSection: Dispatch<SetStateAction<boolean>>;
}

export function attachViewerInteractions(deps: ViewerInteractionDeps): () => void {
  const {
    renderer,
    scene,
    camera,
    controls,
    content,
    handlesGroup,
    modelRef,
    tRef,
    formatNumberRef,
    renderDirtyRef,
    measuringRef,
    pickingSectionRef,
    hoverBlockedRef,
    measurePointsRef,
    measureSegmentsRef,
    measureMarkersRef,
    measurePreviewGroupRef,
    sectionArrowRef,
    sectionDragRef,
    sectionDragMovedRef,
    sectionDragDataRef,
    pickedPartIdsRef,
    onSelectPartRef,
    onUpdateParameterRef,
    setActiveHandle,
    setContextMenu,
    setNoteComposer,
    setHoveredPartId,
    setHoverInfo,
    setPickedPartIds,
    setMeasureLabel,
    setMeasureCount,
    setSectionCustom,
    setSectionAxis,
    setSectionT,
    setPickingSection,
  } = deps;

  let downPos = { x: 0, y: 0 };
  const CLICK_DRAG_TOLERANCE_PX = 6;
  let draggingHandle: {
    arrow: THREE.Object3D;
    axis: "x" | "y" | "z";
    dir: number;
    paramName: string;
    initialVal: number;
    initialMouse: { x: number; y: number };
    dragPlane: THREE.Plane;
    startPoint: THREE.Vector3;
  } | null = null;

  const dragRaycaster = new THREE.Raycaster();
  const dragPointer = new THREE.Vector2();

  const snapLabel = (kind: string) => {
    const strings = tRef.current;
    if (kind === "corner") return strings.viewerSnapCorner;
    if (kind === "edge") return strings.viewerSnapEdge;
    return strings.viewerSnapFace;
  };

  const pickMeasurePoint = (
    raycaster: THREE.Raycaster,
    screenX: number,
    screenY: number,
  ): { point: THREE.Vector3; kind: string } | null => {
    const hits = raycaster.intersectObjects(content.children, true);
    const hit = hits.find((entry) => (entry.object as THREE.Mesh).isMesh);
    if (!hit) return null;

    const bounds = modelRef.current?.bounds;
    const modelExtent = bounds ? Math.max(bounds.size.x, bounds.size.y, bounds.size.z) : 0;

    let point = hit.point.clone();
    let kind = "face";

    const mesh = hit.object as THREE.Mesh;
    if (hit.face && mesh.isMesh) {
      const geometry = mesh.geometry as THREE.BufferGeometry;
      const position = geometry.getAttribute("position");
      const rect = renderer.domElement.getBoundingClientRect();
      const toScreen = (world: THREE.Vector3) => {
        const projected = world.clone().project(camera);
        return {
          x: ((projected.x + 1) / 2) * rect.width,
          y: ((-projected.y + 1) / 2) * rect.height,
        };
      };

      if (position) {
        const probe = modelExtent > 0 ? modelExtent * 0.12 : Number.POSITIVE_INFINITY;
        const probeSq = probe * probe;
        const vertex = new THREE.Vector3();
        let bestDistance = 14;
        let best: THREE.Vector3 | null = null;

        for (let i = 0; i < position.count; i += 1) {
          vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
          if (vertex.distanceToSquared(hit.point) > probeSq) continue;
          const screen = toScreen(vertex);
          const distance = Math.hypot(screen.x - screenX, screen.y - screenY);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = vertex.clone();
          }
        }

        if (best) {
          point = best;
          kind = "corner";
        }
      }

      if (kind === "face" && position && hit.face) {
        const distanceToSegment = (
          p: { x: number; y: number },
          a: { x: number; y: number },
          b: { x: number; y: number },
        ) => {
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const lengthSq = dx * dx + dy * dy;
          const t =
            lengthSq > 0
              ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
              : 0;
          return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
        };

        const corners = [hit.face.a, hit.face.b, hit.face.c].map((index) =>
          new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld),
        );
        const screens = corners.map(toScreen);
        const edges: [number, number][] = [
          [0, 1],
          [1, 2],
          [2, 0],
        ];
        let bestEdge = -1;
        let bestEdgeDistance = 10;
        edges.forEach(([i, j], index) => {
          const distance = distanceToSegment({ x: screenX, y: screenY }, screens[i], screens[j]);
          if (distance < bestEdgeDistance) {
            bestEdgeDistance = distance;
            bestEdge = index;
          }
        });

        if (bestEdge >= 0) {
          const [i, j] = edges[bestEdge];
          const pointOnSegment = new THREE.Vector3();
          raycaster.ray.distanceSqToSegment(corners[i], corners[j], undefined, pointOnSegment);
          point = pointOnSegment;
          kind = "edge";
        }
      }
    }

    return { point, kind };
  };

  const addMeasurement = (a: THREE.Vector3, b: THREE.Vector3, modelExtent: number) => {
    const direction = b.clone().sub(a);
    const length = direction.length();
    if (length <= 0) return;
    direction.normalize();

    const accent = 0xcf222e;
    const radius = Math.max(1.6, modelExtent * 0.0011);
    const group = new THREE.Group();
    const accentMaterial = new THREE.MeshBasicMaterial({ color: accent, depthTest: false });
    const midpoint = a.clone().addScaledVector(direction, length / 2);

    const lineMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, length, 10),
      accentMaterial,
    );
    lineMesh.position.copy(midpoint);
    lineMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    lineMesh.renderOrder = 993;
    group.add(lineMesh);

    const viewDirection = camera.getWorldDirection(new THREE.Vector3());
    const perpendicular = new THREE.Vector3().crossVectors(direction, viewDirection);
    if (perpendicular.lengthSq() < 1e-6) perpendicular.set(0, 0, 1);
    perpendicular.normalize();
    const arrowLength = Math.max(12, modelExtent * 0.016);
    const arrowRadius = Math.max(3, modelExtent * 0.0042);
    for (const [endpoint, sign] of [
      [a, -1],
      [b, 1],
    ] as [THREE.Vector3, number][]) {
      const pointing = direction.clone().multiplyScalar(sign);
      const arrowHead = new THREE.Mesh(
        new THREE.ConeGeometry(arrowRadius, arrowLength, 12),
        accentMaterial,
      );
      arrowHead.position.copy(endpoint).addScaledVector(pointing, -arrowLength / 2);
      arrowHead.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pointing);
      arrowHead.renderOrder = 993;
      group.add(arrowHead);
    }

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 72;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.beginPath();
      ctx.roundRect(4, 4, 248, 64, 18);
      ctx.fillStyle = "rgba(255,255,255,0.97)";
      ctx.fill();
      ctx.strokeStyle = "#2f6feb";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = "#1f2328";
      ctx.font = "bold 30px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${formatNumberRef.current(Math.round(length))} mm`, 128, 37);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 4;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }),
    );
    const spriteHeight = Math.max(modelExtent * 0.04, 34);
    sprite.scale.set(spriteHeight * (256 / 72), spriteHeight, 1);
    sprite.position.copy(midpoint).addScaledVector(perpendicular, arrowLength * 1.6);
    sprite.renderOrder = 1000;
    group.add(sprite);

    scene.add(group);
    measureSegmentsRef.current.push(group);
    setMeasureCount(measureSegmentsRef.current.length);
    renderDirtyRef.current = true;
  };

  const previewGroup = new THREE.Group();
  previewGroup.visible = false;
  scene.add(previewGroup);
  measurePreviewGroupRef.current = previewGroup;

  const previewLine = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 8),
    new THREE.MeshBasicMaterial({
      color: 0xcf222e,
      transparent: true,
      opacity: 0.65,
      depthTest: false,
    }),
  );
  previewLine.renderOrder = 996;
  previewGroup.add(previewLine);

  const previewDot = new THREE.Mesh(
    new THREE.SphereGeometry(1, 14, 12),
    new THREE.MeshBasicMaterial({ color: 0xcf222e, depthTest: false }),
  );
  previewDot.renderOrder = 997;
  previewGroup.add(previewDot);

  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = 256;
  previewCanvas.height = 72;
  const previewContext = previewCanvas.getContext("2d");
  const previewTexture = new THREE.CanvasTexture(previewCanvas);
  previewTexture.anisotropy = 4;
  const previewLabel = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: previewTexture, transparent: true, depthTest: false }),
  );
  previewLabel.renderOrder = 998;
  previewGroup.add(previewLabel);

  let previewText = "";

  const drawPreviewLabel = (text: string) => {
    if (!previewContext || text === previewText) return;
    previewText = text;
    previewContext.clearRect(0, 0, 256, 72);
    previewContext.beginPath();
    previewContext.roundRect(4, 4, 248, 64, 18);
    previewContext.fillStyle = "rgba(255,255,255,0.95)";
    previewContext.fill();
    previewContext.strokeStyle = "#2f6feb";
    previewContext.lineWidth = 3;
    previewContext.stroke();
    previewContext.fillStyle = "#1f2328";
    previewContext.font = "bold 30px 'Segoe UI', Arial, sans-serif";
    previewContext.textAlign = "center";
    previewContext.textBaseline = "middle";
    previewContext.fillText(text, 128, 37);
    previewTexture.needsUpdate = true;
  };

  const hideMeasurePreview = () => {
    previewGroup.visible = false;
  };

  let previewSnapKey = "";
  let previewSnap: { point: THREE.Vector3; kind: string } | null = null;

  const updateMeasurePreview = (e: MouseEvent) => {
    if (!measuringRef.current) {
      hideMeasurePreview();
      return;
    }

    const rect = renderer.domElement.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      hideMeasurePreview();
      return;
    }

    dragPointer.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    dragRaycaster.setFromCamera(dragPointer, camera);

    const snapKey = `${Math.round(x / 2)}:${Math.round(y / 2)}`;
    if (snapKey !== previewSnapKey) {
      previewSnapKey = snapKey;
      previewSnap = pickMeasurePoint(dragRaycaster, x, y);
    }
    const picked = previewSnap;
    if (!picked) {
      hideMeasurePreview();
      return;
    }

    const bounds = modelRef.current?.bounds;
    const modelExtent = bounds ? Math.max(bounds.size.x, bounds.size.y, bounds.size.z) : 0;
    const markerRadius = Math.max(5, modelExtent / 220);
    const labelHeight = Math.max(modelExtent * 0.04, 32);

    previewGroup.visible = true;
    previewDot.visible = true;
    previewDot.scale.setScalar(markerRadius);
    previewDot.position.copy(picked.point);

    const points = measurePointsRef.current;
    const kindLabel = snapLabel(picked.kind);
    if (points.length === 0) {
      previewLine.visible = false;
      previewLabel.visible = true;
      previewLabel.scale.set(labelHeight * (256 / 72), labelHeight, 1);
      previewLabel.position.copy(picked.point).add(new THREE.Vector3(0, 0, labelHeight * 0.9));
      drawPreviewLabel(kindLabel);
      renderDirtyRef.current = true;
      return;
    }

    const a = points[0];
    const constrained = snapToAxis(a, picked.point);
    const direction = constrained.point.clone().sub(a);
    const length = direction.length();
    if (length < 1e-3) {
      previewLine.visible = false;
      previewLabel.visible = false;
      renderDirtyRef.current = true;
      return;
    }
    direction.normalize();

    previewDot.position.copy(constrained.point);
    previewLine.visible = true;
    previewLine.scale.set(markerRadius * 0.3, length, markerRadius * 0.3);
    previewLine.position.copy(a).addScaledVector(direction, length / 2);
    previewLine.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);

    previewLabel.visible = true;
    previewLabel.scale.set(labelHeight * (256 / 72), labelHeight, 1);
    previewLabel.position
      .copy(previewLine.position)
      .add(new THREE.Vector3(0, 0, labelHeight * 0.8));
    drawPreviewLabel(
      tRef.current.viewerMeasurePreview(
        formatNumberRef.current(Math.round(length)),
        constrained.axis ?? "",
      ),
    );

    renderDirtyRef.current = true;
  };

  const pickPointer = new THREE.Vector2();
  const pickRaycaster = new THREE.Raycaster();

  const partAtObject = (
    object: THREE.Object3D,
  ): { partId: string; partName: string; object: THREE.Object3D } | null => {
    let current: THREE.Object3D | null = object;
    while (current && current !== content) {
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
  };

  const visibleInTree = (object: THREE.Object3D): boolean => {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (!current.visible) return false;
      if (current === content) return true;
      current = current.parent;
    }
    return true;
  };

  const pickPartAt = (
    clientX: number,
    clientY: number,
  ): {
    hit: THREE.Intersection;
    partId: string;
    partName: string;
    object: THREE.Object3D;
  } | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pickPointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    pickRaycaster.setFromCamera(pickPointer, camera);
    const hits = pickRaycaster.intersectObjects(content.children, true);
    for (const hit of hits) {
      if (!(hit.object as THREE.Mesh).isMesh || !visibleInTree(hit.object)) continue;
      if (renderer.clippingPlanes?.some((plane) => plane.distanceToPoint(hit.point) < 0)) {
        continue;
      }
      const part = partAtObject(hit.object);
      if (part) return { hit, ...part };
    }
    return null;
  };

  const onCanvasMouseDown = (e: MouseEvent) => {
    downPos = { x: e.clientX, y: e.clientY };
    setContextMenu(null);
    setNoteComposer(null);

    const rect = renderer.domElement.getBoundingClientRect();
    dragPointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    dragRaycaster.setFromCamera(dragPointer, camera);
    const handleHits = dragRaycaster.intersectObjects(handlesGroup.children, true);

    if (handleHits.length > 0) {
      let handleObj: THREE.Object3D | null = handleHits[0].object;
      while (
        handleObj &&
        !handleObj.userData.isShapeHandle &&
        handleObj.parent !== handlesGroup &&
        handleObj.parent
      ) {
        handleObj = handleObj.parent;
      }

      if (handleObj && handleObj.userData.isShapeHandle) {
        e.stopPropagation();
        controls.enabled = false;

        const axis = handleObj.userData.axis as "x" | "y" | "z";
        const dir = handleObj.userData.dir as number;
        const paramName = handleObj.userData.paramName as string;
        const initialVal = handleObj.userData.currentVal as number;

        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          camDir.negate(),
          handleObj.position,
        );

        const startIntersection = new THREE.Vector3();
        dragRaycaster.ray.intersectPlane(plane, startIntersection);

        draggingHandle = {
          arrow: handleObj,
          axis,
          dir,
          paramName,
          initialVal,
          initialMouse: { x: e.clientX, y: e.clientY },
          dragPlane: plane,
          startPoint: startIntersection.clone(),
        };

        const screenPos = handleObj.position.clone().project(camera);
        setActiveHandle({
          label: paramName,
          value: Math.round(initialVal),
          screenX: ((screenPos.x + 1) / 2) * rect.width,
          screenY: ((-screenPos.y + 1) / 2) * rect.height,
        });
      }
    }
  };

  const onCanvasMouseMove = (e: MouseEvent) => {
    if (!draggingHandle) {
      if (sectionDragRef.current) return;
      const rect = renderer.domElement.getBoundingClientRect();
      dragPointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      dragRaycaster.setFromCamera(dragPointer, camera);
      const handleHits = dragRaycaster.intersectObjects(handlesGroup.children, true);
      if (handleHits.length > 0) {
        renderer.domElement.style.cursor = "pointer";
      } else if (
        sectionArrowRef.current &&
        dragRaycaster.intersectObject(sectionArrowRef.current, true).length > 0
      ) {
        renderer.domElement.style.cursor = "grab";
      } else {
        renderer.domElement.style.cursor = "default";
      }
      updateMeasurePreview(e);
      return;
    }

    const rect = renderer.domElement.getBoundingClientRect();
    dragPointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    dragRaycaster.setFromCamera(dragPointer, camera);

    const currentIntersection = new THREE.Vector3();
    if (dragRaycaster.ray.intersectPlane(draggingHandle.dragPlane, currentIntersection)) {
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

  const onCanvasMouseUp = () => {
    if (draggingHandle) {
      draggingHandle = null;
      controls.enabled = true;
      setTimeout(() => setActiveHandle(null), 1200);
    }
  };

  const onCanvasClick = (e: MouseEvent) => {
    if (sectionDragMovedRef.current) {
      sectionDragMovedRef.current = false;
      return;
    }
    const dx = Math.abs(e.clientX - downPos.x);
    const dy = Math.abs(e.clientY - downPos.y);
    if (dx > CLICK_DRAG_TOLERANCE_PX || dy > CLICK_DRAG_TOLERANCE_PX) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const mainRaycaster = new THREE.Raycaster();
    mainRaycaster.setFromCamera(pointer, camera);

    if (pickingSectionRef.current) {
      const hit = pickPartAt(e.clientX, e.clientY)?.hit;
      if (hit?.face) {
        const mesh = hit.object as THREE.Mesh;
        const normal = hit.face.normal
          .clone()
          .transformDirection(mesh.matrixWorld)
          .normalize()
          .negate();
        setSectionCustom({ normal, base: hit.point.clone() });
        setSectionAxis("custom");
        setSectionT(0.5);
      }
      setPickingSection(false);
      return;
    }

    if (measuringRef.current) {
      const picked = pickMeasurePoint(mainRaycaster, e.clientX - rect.left, e.clientY - rect.top);
      if (picked) {
        const { kind: snapKind } = picked;
        const points = measurePointsRef.current;
        const constrained = points.length === 1 ? snapToAxis(points[0], picked.point) : null;
        const point = constrained ? constrained.point : picked.point;
        const bounds = modelRef.current?.bounds;
        const modelExtent = bounds ? Math.max(bounds.size.x, bounds.size.y, bounds.size.z) : 0;

        const markerRadius = Math.max(5, modelExtent / 220);
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(markerRadius, 16, 12),
          new THREE.MeshBasicMaterial({ color: 0xcf222e, depthTest: false }),
        );
        marker.position.copy(point);
        marker.renderOrder = 998;
        scene.add(marker);
        measureMarkersRef.current.push(marker);

        if (points.length === 0) {
          points.push(point);
          setMeasureLabel(tRef.current.viewerMeasureFirstPoint(snapLabel(snapKind)));
        } else {
          const a = points[0];
          const distance = a.distanceTo(point);
          points.length = 0;
          addMeasurement(a, point, modelExtent);
          hideMeasurePreview();
          setMeasureLabel(
            tRef.current.viewerMeasureResult(
              formatNumberRef.current(Math.round(distance)),
              snapLabel(snapKind),
              constrained?.axis ?? "",
            ),
          );
        }
        renderDirtyRef.current = true;
      }
      return;
    }

    if (mainRaycaster.intersectObjects(handlesGroup.children, true).length > 0) return;

    const picked = pickPartAt(e.clientX, e.clientY);
    if (!picked) {
      setPickedPartIds([]);
      pickedPartIdsRef.current = [];
      onSelectPartRef.current?.(null);
      return;
    }

    const modifier = e.ctrlKey || e.metaKey;
    if (modifier) {
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

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const dx = Math.abs(e.clientX - downPos.x);
    const dy = Math.abs(e.clientY - downPos.y);
    if (dx > CLICK_DRAG_TOLERANCE_PX || dy > CLICK_DRAG_TOLERANCE_PX) return;

    const picked = pickPartAt(e.clientX, e.clientY);
    if (picked) {
      const { hit, partId, object } = picked;
      const partDef = modelRef.current?.parts.find((p) => p.id === partId);
      const partName = partDef?.name || picked.partName || partId;
      const mesh = hit.object as THREE.Mesh;

      const surfaceNormal: THREE.Vector3 | null = hit.face
        ? hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize()
        : null;
      const normal: THREE.Vector3 = surfaceNormal
        ? surfaceNormal.clone().negate()
        : camera.getWorldDirection(new THREE.Vector3());

      let center: THREE.Vector3 | null = null;
      const box = new THREE.Box3().setFromObject(object);
      if (!box.isEmpty()) center = box.getCenter(new THREE.Vector3());
      if (!center) center = hit.point.clone();

      if (!pickedPartIdsRef.current.includes(partId)) {
        setPickedPartIds([partId]);
        pickedPartIdsRef.current = [partId];
      }
      onSelectPartRef.current?.(partId);
      setContextMenu({
        partId,
        partName,
        x: e.clientX,
        y: e.clientY,
        normal,
        surfaceNormal,
        point: hit.point.clone(),
        center,
      });
      return;
    }

    setContextMenu(null);
  };

  let hoverFrame = 0;
  const clearHover = () => {
    setHoveredPartId((current) => (current === null ? current : null));
    setHoverInfo((current) => (current === null ? current : null));
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

  const onHoverLeave = () => clearHover();

  const sectionRay = new THREE.Raycaster();
  const sectionPointer = new THREE.Vector2();
  const readSectionPointer = (e: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    sectionPointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  };

  const onSectionPointerDown = (e: PointerEvent) => {
    const arrow = sectionArrowRef.current;
    const data = sectionDragDataRef.current;
    if (!arrow || !data) return;
    readSectionPointer(e);
    sectionRay.setFromCamera(sectionPointer, camera);
    if (sectionRay.intersectObject(arrow, true).length === 0) return;

    e.stopPropagation();
    e.preventDefault();
    sectionDragRef.current = true;
    controls.enabled = false;
    renderer.domElement.style.cursor = "grabbing";
  };

  const onSectionPointerMove = (e: PointerEvent) => {
    const data = sectionDragDataRef.current;
    if (!sectionDragRef.current || !data) return;
    readSectionPointer(e);
    sectionRay.setFromCamera(sectionPointer, camera);

    const span = data.range * 2;
    const start = data.origin.clone().addScaledVector(data.normal, -span);
    const end = data.origin.clone().addScaledVector(data.normal, span);
    const hitPoint = new THREE.Vector3();
    sectionRay.ray.distanceSqToSegment(start, end, undefined, hitPoint);
    const offset = hitPoint.sub(data.origin).dot(data.normal);
    setSectionT(Math.min(1, Math.max(0, 0.5 + (data.sign * offset) / data.range)));
  };

  const onSectionPointerUp = () => {
    if (!sectionDragRef.current) return;
    sectionDragRef.current = false;
    sectionDragMovedRef.current = true;
    controls.enabled = true;
    renderer.domElement.style.cursor = "";
  };

  renderer.domElement.addEventListener("contextmenu", onContextMenu);
  renderer.domElement.addEventListener("mousedown", onCanvasMouseDown);
  window.addEventListener("mousemove", onCanvasMouseMove);
  window.addEventListener("mouseup", onCanvasMouseUp);
  renderer.domElement.addEventListener("click", onCanvasClick);
  renderer.domElement.addEventListener("pointermove", onHoverMove);
  renderer.domElement.addEventListener("mousemove", onHoverMove);
  renderer.domElement.addEventListener("pointerleave", onHoverLeave);
  renderer.domElement.addEventListener("mouseleave", onHoverLeave);
  renderer.domElement.addEventListener("pointerdown", onSectionPointerDown, true);
  window.addEventListener("pointermove", onSectionPointerMove);
  window.addEventListener("pointerup", onSectionPointerUp);

  return () => {
    if (hoverFrame) cancelAnimationFrame(hoverFrame);
    renderer.domElement.removeEventListener("pointermove", onHoverMove);
    renderer.domElement.removeEventListener("mousemove", onHoverMove);
    renderer.domElement.removeEventListener("pointerleave", onHoverLeave);
    renderer.domElement.removeEventListener("mouseleave", onHoverLeave);
    renderer.domElement.removeEventListener("contextmenu", onContextMenu);
    renderer.domElement.removeEventListener("mousedown", onCanvasMouseDown);
    window.removeEventListener("mousemove", onCanvasMouseMove);
    window.removeEventListener("mouseup", onCanvasMouseUp);
    renderer.domElement.removeEventListener("click", onCanvasClick);
    renderer.domElement.removeEventListener("pointerdown", onSectionPointerDown, true);
    window.removeEventListener("pointermove", onSectionPointerMove);
    window.removeEventListener("pointerup", onSectionPointerUp);
  };
}
