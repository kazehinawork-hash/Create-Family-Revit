import type { ResolvedModel } from "@family/spec-core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import * as THREE from "three";
import type { Strings } from "../../lib/strings";
import { snapToAxis } from "./sceneHelpers";
import { clientToNdc, wasDragged, type ViewerInteractionContext } from "./interactionContext";

export interface MeasureToolOptions {
  scene: THREE.Scene;
  modelRef: MutableRefObject<ResolvedModel | null>;
  tRef: MutableRefObject<Strings>;
  formatNumberRef: MutableRefObject<(value: number) => string>;
  measuringRef: MutableRefObject<boolean>;
  sectionDragMovedRef: MutableRefObject<boolean>;
  measurePointsRef: MutableRefObject<THREE.Vector3[]>;
  measureSegmentsRef: MutableRefObject<THREE.Group[]>;
  measureMarkersRef: MutableRefObject<THREE.Mesh[]>;
  measurePreviewGroupRef: MutableRefObject<THREE.Group | null>;
  setMeasureLabel: Dispatch<SetStateAction<string | null>>;
  setMeasureCount: Dispatch<SetStateAction<number>>;
}

function drawBadgeText(ctx: CanvasRenderingContext2D, text: string) {
  ctx.clearRect(0, 0, 256, 72);
  ctx.beginPath();
  ctx.roundRect(4, 4, 248, 64, 18);
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.fill();
  ctx.strokeStyle = "#2f6feb";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "#1f2328";
  ctx.font = "bold 30px 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 37);
}

/** Handles vertex/edge/face snapping, live ruler preview, and finalized 2-point measurements. */
export function attachMeasureTool(
  ctx: ViewerInteractionContext,
  options: MeasureToolOptions,
): () => void {
  const { renderer, camera, content, requestRender } = ctx;
  const {
    scene,
    modelRef,
    tRef,
    formatNumberRef,
    measuringRef,
    sectionDragMovedRef,
    measurePointsRef,
    measureSegmentsRef,
    measureMarkersRef,
    measurePreviewGroupRef,
    setMeasureLabel,
    setMeasureCount,
  } = options;

  let downPos = { x: 0, y: 0 };
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const snapLabel = (kind: string) => {
    const strings = tRef.current;
    if (kind === "corner") return strings.viewerSnapCorner;
    if (kind === "edge") return strings.viewerSnapEdge;
    return strings.viewerSnapFace;
  };

  const pickMeasurePoint = (
    activeRay: THREE.Raycaster,
    screenX: number,
    screenY: number,
  ): { point: THREE.Vector3; kind: string } | null => {
    const hits = activeRay.intersectObjects(content.children, true);
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
        const distToSeg = (
          p: { x: number; y: number },
          a: { x: number; y: number },
          b: { x: number; y: number },
        ) => {
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const lenSq = dx * dx + dy * dy;
          const t =
            lenSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq)) : 0;
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
          const d = distToSeg({ x: screenX, y: screenY }, screens[i], screens[j]);
          if (d < bestEdgeDistance) {
            bestEdgeDistance = d;
            bestEdge = index;
          }
        });
        if (bestEdge >= 0) {
          const [i, j] = edges[bestEdge];
          const pointOnSegment = new THREE.Vector3();
          activeRay.ray.distanceSqToSegment(corners[i], corners[j], undefined, pointOnSegment);
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
    const context2d = canvas.getContext("2d");
    if (context2d) drawBadgeText(context2d, `${formatNumberRef.current(Math.round(length))} mm`);
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
    requestRender();
  };

  const previewGroup = new THREE.Group();
  previewGroup.visible = false;
  scene.add(previewGroup);
  measurePreviewGroupRef.current = previewGroup;

  const previewLineGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
  const previewLineMat = new THREE.MeshBasicMaterial({
    color: 0xcf222e,
    transparent: true,
    opacity: 0.65,
    depthTest: false,
  });
  const previewLine = new THREE.Mesh(previewLineGeo, previewLineMat);
  previewLine.renderOrder = 996;
  previewGroup.add(previewLine);

  const previewDotGeo = new THREE.SphereGeometry(1, 14, 12);
  const previewDotMat = new THREE.MeshBasicMaterial({ color: 0xcf222e, depthTest: false });
  const previewDot = new THREE.Mesh(previewDotGeo, previewDotMat);
  previewDot.renderOrder = 997;
  previewGroup.add(previewDot);

  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = 256;
  previewCanvas.height = 72;
  const previewContext = previewCanvas.getContext("2d");
  const previewTexture = new THREE.CanvasTexture(previewCanvas);
  previewTexture.anisotropy = 4;
  const previewLabelMat = new THREE.SpriteMaterial({
    map: previewTexture,
    transparent: true,
    depthTest: false,
  });
  const previewLabel = new THREE.Sprite(previewLabelMat);
  previewLabel.renderOrder = 998;
  previewGroup.add(previewLabel);

  let previewText = "";
  let previewSnapKey = "";
  let previewSnap: { point: THREE.Vector3; kind: string } | null = null;

  const updatePreviewLabel = (text: string) => {
    if (!previewContext || text === previewText) return;
    previewText = text;
    drawBadgeText(previewContext, text);
    previewTexture.needsUpdate = true;
  };

  const onMouseDown = (event: MouseEvent) => {
    downPos = { x: event.clientX, y: event.clientY };
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!measuringRef.current) {
      previewGroup.visible = false;
      return;
    }

    const rect = renderer.domElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      previewGroup.visible = false;
      return;
    }

    pointer.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);

    const snapKey = `${Math.round(x / 2)}:${Math.round(y / 2)}`;
    if (snapKey !== previewSnapKey) {
      previewSnapKey = snapKey;
      previewSnap = pickMeasurePoint(raycaster, x, y);
    }
    const picked = previewSnap;
    if (!picked) {
      previewGroup.visible = false;
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
    if (points.length === 0) {
      previewLine.visible = false;
      previewLabel.visible = true;
      previewLabel.scale.set(labelHeight * (256 / 72), labelHeight, 1);
      previewLabel.position.copy(picked.point).add(new THREE.Vector3(0, 0, labelHeight * 0.9));
      updatePreviewLabel(snapLabel(picked.kind));
      requestRender();
      return;
    }

    const a = points[0];
    const constrained = snapToAxis(a, picked.point);
    const direction = constrained.point.clone().sub(a);
    const length = direction.length();
    if (length < 1e-3) {
      previewLine.visible = false;
      previewLabel.visible = false;
      requestRender();
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
    previewLabel.position.copy(previewLine.position).add(new THREE.Vector3(0, 0, labelHeight * 0.8));
    updatePreviewLabel(
      tRef.current.viewerMeasurePreview(
        formatNumberRef.current(Math.round(length)),
        constrained.axis ?? "",
      ),
    );
    requestRender();
  };

  const onClick = (event: MouseEvent) => {
    if (!measuringRef.current) return;
    if (sectionDragMovedRef.current || wasDragged(downPos, event)) return;
    if (!clientToNdc(renderer.domElement, event.clientX, event.clientY, pointer)) return;

    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(pointer, camera);
    const picked = pickMeasurePoint(raycaster, event.clientX - rect.left, event.clientY - rect.top);
    if (!picked) return;

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
      previewGroup.visible = false;
      setMeasureLabel(
        tRef.current.viewerMeasureResult(
          formatNumberRef.current(Math.round(distance)),
          snapLabel(snapKind),
          constrained?.axis ?? "",
        ),
      );
    }
    requestRender();
  };

  const el = renderer.domElement;
  el.addEventListener("mousedown", onMouseDown);
  el.addEventListener("click", onClick);
  window.addEventListener("mousemove", onMouseMove);

  return () => {
    el.removeEventListener("mousedown", onMouseDown);
    el.removeEventListener("click", onClick);
    window.removeEventListener("mousemove", onMouseMove);
    scene.remove(previewGroup);
    previewLineGeo.dispose();
    previewLineMat.dispose();
    previewDotGeo.dispose();
    previewDotMat.dispose();
    previewTexture.dispose();
    previewLabelMat.dispose();
    measurePreviewGroupRef.current = null;
  };
}
