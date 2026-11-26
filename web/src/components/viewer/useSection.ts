import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ResolvedModel } from "@family/spec-core";
import * as THREE from "three";
import type { Strings } from "../../lib/strings";
import { planeCrossSection } from "./sceneHelpers";
import type { PartCacheEntry, SceneState, SectionCustomState, SectionDragData } from "./types";

export interface UseSectionOptions {
  stateRef: MutableRefObject<SceneState | null>;
  partCacheRef: MutableRefObject<Map<string, PartCacheEntry>>;
  renderDirtyRef: MutableRefObject<boolean>;
  model: ResolvedModel | null;
  t: Strings;
  formatNumber: (value: number) => string;
}

function disposeGroupContents(group: THREE.Group) {
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose();
    if ((child as THREE.Sprite).isSprite) {
      (child as THREE.Sprite).material.map?.dispose();
    }
  });
}

function createSectionHandleSprite(): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.beginPath();
    ctx.roundRect(5, 5, 246, 86, 26);
    ctx.fillStyle = "rgba(247,250,255,0.98)";
    ctx.shadowColor = "rgba(20, 30, 50, 0.28)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = "#2f6feb";
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.strokeStyle = "#2f6feb";
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(102, 36);
    ctx.lineTo(128, 20);
    ctx.lineTo(154, 36);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(102, 60);
    ctx.lineTo(128, 76);
    ctx.lineTo(154, 60);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  sprite.renderOrder = 1000;
  return sprite;
}

function createSectionLabelSprite(): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 72;
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  sprite.renderOrder = 1001;
  return sprite;
}

function drawSectionLabel(sprite: THREE.Sprite, labelText: string) {
  const material = sprite.material as THREE.SpriteMaterial;
  const canvas = material.map?.image as HTMLCanvasElement | undefined;
  const ctx = canvas?.getContext("2d");
  if (!ctx || sprite.userData.text === labelText) return;
  sprite.userData.text = labelText;
  ctx.clearRect(0, 0, 256, 72);
  ctx.beginPath();
  ctx.roundRect(4, 4, 248, 64, 18);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fill();
  ctx.strokeStyle = "#2f6feb";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "#1f2328";
  ctx.font = "bold 26px 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(labelText, 128, 37);
  if (material.map) material.map.needsUpdate = true;
}

/** Manages section box clipping state, visual outline/handle/stencil cap, and mm position inputs. */
export function useSection({
  stateRef,
  partCacheRef,
  renderDirtyRef,
  model,
  t,
  formatNumber,
}: UseSectionOptions) {
  const [sectionAxis, setSectionAxis] = useState<"off" | "x" | "y" | "z" | "custom">("off");
  const [sectionT, setSectionT] = useState(1);
  const [sectionCustom, setSectionCustom] = useState<SectionCustomState | null>(null);
  const [pickingSection, setPickingSection] = useState(false);
  const pickingSectionRef = useRef(false);
  pickingSectionRef.current = pickingSection;
  const [sectionFill, setSectionFill] = useState(true);

  const sectionPlaneRef = useRef<THREE.Group | null>(null);
  const sectionOutlineRef = useRef<THREE.Group | null>(null);
  const sectionArrowRef = useRef<THREE.Object3D | null>(null);
  const sectionHandleLabelRef = useRef<THREE.Sprite | null>(null);
  const sectionBuildKeyRef = useRef<string>("off");
  const sectionDragRef = useRef(false);
  const sectionDragMovedRef = useRef(false);
  const sectionDragDataRef = useRef<SectionDragData | null>(null);
  const sectionCapRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    renderDirtyRef.current = true;
    const modelKey = model?.bounds
      ? `${model.bounds.size.x.toFixed(1)},${model.bounds.size.y.toFixed(1)},${model.bounds.size.z.toFixed(1)}`
      : "none";
    const buildKey =
      sectionAxis === "off" || !model?.bounds
        ? "off"
        : sectionAxis === "custom"
          ? sectionCustom
            ? `custom:${sectionCustom.normal
                .toArray()
                .map((v) => v.toFixed(4))
                .join(",")}:${sectionCustom.base
                .toArray()
                .map((v) => v.toFixed(2))
                .join(",")}:${modelKey}`
            : "custom-none"
          : `axis:${sectionAxis}:${modelKey}`;

    if (buildKey !== sectionBuildKeyRef.current) {
      const previousPlane = sectionPlaneRef.current;
      if (previousPlane) {
        state.scene.remove(previousPlane);
        disposeGroupContents(previousPlane);
        sectionPlaneRef.current = null;
        sectionArrowRef.current = null;
        sectionOutlineRef.current = null;
        sectionHandleLabelRef.current = null;
      }
      sectionBuildKeyRef.current = buildKey;
    }

    if (sectionAxis === "off" || !model?.bounds) {
      state.renderer.clippingPlanes = [];
      if (sectionCapRef.current) sectionCapRef.current.visible = false;
      for (const entry of partCacheRef.current.values()) {
        if (entry.stencilBack) entry.stencilBack.visible = false;
        if (entry.stencilFront) entry.stencilFront.visible = false;
      }
      state.renderer.shadowMap.needsUpdate = true;
      renderDirtyRef.current = true;
      return;
    }

    const { min, max, size } = model.bounds;
    const center = new THREE.Vector3(
      (min.x + max.x) / 2,
      (min.y + max.y) / 2,
      (min.z + max.z) / 2,
    );
    const extent = Math.max(size.x, size.y, size.z, 400);
    const customRange = sectionCustom
      ? Math.abs(sectionCustom.normal.x) * size.x +
        Math.abs(sectionCustom.normal.y) * size.y +
        Math.abs(sectionCustom.normal.z) * size.z
      : extent;

    let normal: THREE.Vector3 | null = null;
    let planePoint: THREE.Vector3 | null = null;

    if (sectionAxis === "custom" && sectionCustom) {
      normal = sectionCustom.normal.clone().normalize();
      const offset = (sectionT - 0.5) * customRange;
      planePoint = sectionCustom.base.clone().addScaledVector(normal, offset);
    } else if (sectionAxis !== "custom") {
      const axis = sectionAxis;
      const lo = min[axis];
      const hi = max[axis];
      const position = lo + (hi - lo) * sectionT;
      normal = new THREE.Vector3(
        axis === "x" ? -1 : 0,
        axis === "y" ? -1 : 0,
        axis === "z" ? -1 : 0,
      );
      planePoint = new THREE.Vector3(
        axis === "x" ? position : center.x,
        axis === "y" ? position : center.y,
        axis === "z" ? position : center.z,
      );
    }

    if (!normal || !planePoint) {
      state.renderer.clippingPlanes = [];
      state.renderer.shadowMap.needsUpdate = true;
      renderDirtyRef.current = true;
      return;
    }

    state.renderer.clippingPlanes = [new THREE.Plane(normal.clone(), -normal.dot(planePoint))];

    const planeCenter = center
      .clone()
      .addScaledVector(normal, -center.clone().sub(planePoint).dot(normal));
    const polygon = planeCrossSection(model.bounds, normal, planePoint);
    const handleHeight = Math.max(extent * 0.05, 50);
    const polygonCentroid =
      polygon.length >= 3
        ? polygon
            .reduce((acc, item) => acc.add(item), new THREE.Vector3())
            .divideScalar(polygon.length)
        : planeCenter.clone();
    const handlePoint = polygonCentroid.clone().addScaledVector(normal, handleHeight * 0.75);

    let group = sectionPlaneRef.current;
    if (!group) {
      group = new THREE.Group();
      state.scene.add(group);
      sectionPlaneRef.current = group;
    }

    let outlineGroup = sectionOutlineRef.current;
    if (!outlineGroup) {
      outlineGroup = new THREE.Group();
      group.add(outlineGroup);
      sectionOutlineRef.current = outlineGroup;
    }

    for (const child of [...outlineGroup.children]) {
      outlineGroup.remove(child);
      const line = child as THREE.Line;
      line.geometry?.dispose();
      (line.material as THREE.Material | undefined)?.dispose();
    }

    if (polygon.length >= 3) {
      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(polygon),
        new THREE.LineBasicMaterial({ color: 0x2f6feb, transparent: true, opacity: 0.9 }),
      );
      border.renderOrder = 990;
      outlineGroup.add(border);

      const inset = polygon.map((item) =>
        item.clone().sub(polygonCentroid).multiplyScalar(0.97).add(polygonCentroid),
      );
      const inner = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(inset),
        new THREE.LineBasicMaterial({ color: 0x2f6feb, transparent: true, opacity: 0.25 }),
      );
      inner.renderOrder = 990;
      outlineGroup.add(inner);
    }

    let handle = sectionArrowRef.current;
    if (!handle) {
      handle = createSectionHandleSprite();
      group.add(handle);
      sectionArrowRef.current = handle;
    }
    handle.scale.set(handleHeight * (256 / 96), handleHeight, 1);
    handle.position.copy(handlePoint);

    let handleLabel = sectionHandleLabelRef.current;
    if (!handleLabel) {
      handleLabel = createSectionLabelSprite();
      group.add(handleLabel);
      sectionHandleLabelRef.current = handleLabel;
    }

    const sectionValueMm =
      sectionAxis === "custom"
        ? Math.round((sectionT - 0.5) * customRange)
        : Math.round(min[sectionAxis] + (max[sectionAxis] - min[sectionAxis]) * sectionT);
    const sectionValueText = formatNumber(sectionValueMm);
    const labelText =
      sectionAxis === "custom"
        ? t.viewerSectionFace(sectionValueText)
        : `${sectionAxis.toUpperCase()} · ${sectionValueText} mm`;

    drawSectionLabel(handleLabel, labelText);
    const sectionLabelHeight = Math.max(extent * 0.035, 30);
    handleLabel.scale.set(sectionLabelHeight * (256 / 72), sectionLabelHeight, 1);
    handleLabel.position.copy(handlePoint).add(new THREE.Vector3(0, 0, handleHeight * 1.15));

    const cap = sectionCapRef.current;
    const active = sectionFill && model.parts.length < 200;
    if (cap) {
      cap.visible = active;
      if (active) {
        const capWidth =
          sectionAxis === "x"
            ? size.y
            : sectionAxis === "custom"
              ? Math.max(size.x, size.y)
              : size.x;
        const capHeight =
          sectionAxis === "z"
            ? size.y
            : sectionAxis === "custom"
              ? Math.max(size.y, size.z)
              : size.z;
        cap.position.copy(planePoint);
        cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
        cap.scale.set(Math.max(capWidth, 1) * 1.02, Math.max(capHeight, 1) * 1.02, 1);
      }
    }
    for (const entry of partCacheRef.current.values()) {
      if (entry.stencilBack) entry.stencilBack.visible = active;
      if (entry.stencilFront) entry.stencilFront.visible = active;
    }

    sectionDragDataRef.current = {
      origin: sectionAxis === "custom" && sectionCustom ? sectionCustom.base.clone() : center.clone(),
      normal: normal.clone(),
      range: sectionAxis === "custom" ? customRange : Math.max(max[sectionAxis] - min[sectionAxis], 1),
      sign: sectionAxis === "custom" ? 1 : -1,
    };

    state.renderer.shadowMap.needsUpdate = true;
    renderDirtyRef.current = true;
  }, [stateRef, partCacheRef, renderDirtyRef, sectionAxis, sectionT, model, sectionCustom, sectionFill, t, formatNumber]);

  const sectionMm = (() => {
    if (!model?.bounds || sectionAxis === "off") return null;
    const { min, max, size } = model.bounds;
    if (sectionAxis === "custom") {
      if (!sectionCustom) return null;
      const range =
        Math.abs(sectionCustom.normal.x) * size.x +
        Math.abs(sectionCustom.normal.y) * size.y +
        Math.abs(sectionCustom.normal.z) * size.z;
      return { value: Math.round((sectionT - 0.5) * range), range };
    }
    const lo = min[sectionAxis];
    const hi = max[sectionAxis];
    return { value: Math.round(lo + (hi - lo) * sectionT), range: hi - lo };
  })();

  const applySectionMm = (value: number) => {
    if (!model?.bounds || sectionAxis === "off" || !Number.isFinite(value)) return;
    const { min, max, size } = model.bounds;
    if (sectionAxis === "custom") {
      if (!sectionCustom) return;
      const range =
        Math.abs(sectionCustom.normal.x) * size.x +
        Math.abs(sectionCustom.normal.y) * size.y +
        Math.abs(sectionCustom.normal.z) * size.z;
      setSectionT(Math.min(1, Math.max(0, 0.5 + value / Math.max(range, 1))));
      return;
    }
    const lo = min[sectionAxis];
    const hi = max[sectionAxis];
    setSectionT(Math.min(1, Math.max(0, (value - lo) / Math.max(hi - lo, 1))));
  };

  return {
    sectionAxis,
    setSectionAxis,
    sectionT,
    setSectionT,
    sectionCustom,
    setSectionCustom,
    pickingSection,
    setPickingSection,
    pickingSectionRef,
    sectionFill,
    setSectionFill,
    sectionMm,
    applySectionMm,
    sectionArrowRef,
    sectionDragRef,
    sectionDragMovedRef,
    sectionDragDataRef,
    sectionCapRef,
  };
}
