import { useEffect, useRef, type MutableRefObject } from "react";
import type { MaterialDef, ResolvedModel, ResolvedPart } from "@family/spec-core";
import * as THREE from "three";
import { buildPartGeometryAsync, type BuiltPartGeometry } from "../../lib/geometry-pool";
import {
  instanceEdgeGeometry,
  partColor,
  partMaterialProps,
  type PreviewQuality,
} from "../../lib/three-build";
import type { PartCacheEntry, SceneState } from "./types";

export interface UsePartMeshesOptions {
  stateRef: MutableRefObject<SceneState | null>;
  partCacheRef: MutableRefObject<Map<string, PartCacheEntry>>;
  renderDirtyRef: MutableRefObject<boolean>;
  themeRef: MutableRefObject<"light" | "dark">;
  model: ResolvedModel | null;
  materials: MaterialDef[];
  selectedPartId?: string | null;
  pickedPartIds: string[];
  hiddenPartIds: string[];
  transparentPartIds: string[];
  issuePartIds: string[];
  highlightPartIds: string[];
  visiblePartCount: number;
  animatingPartName: string | null;
  hoveredPartId: string | null;
  dimOthers: boolean;
  detailLevel: "coarse" | "medium" | "fine";
  previewQuality: PreviewQuality;
  theme: "light" | "dark";
}

interface PartVisualStyle {
  name: string;
  color: string;
  metalness: number;
  roughness: number;
  isSelected: boolean;
  isTransparent: boolean;
  isClearance: boolean;
  hasIssue: boolean;
  isAffected: boolean;
  isAnimating: boolean;
  isGhost: boolean;
  isHovered: boolean;
  isDimmed: boolean;
}

function computePartStyle(
  part: ResolvedPart,
  materials: MaterialDef[],
  activeSelectedIds: Set<string>,
  transparentPartIds: string[],
  issuePartIds: string[],
  highlightPartIds: string[],
  animatingPartName: string | null,
  hoveredPartId: string | null,
  dimOthers: boolean,
  ghost: boolean,
): PartVisualStyle {
  const isClearance =
    part.id.toLowerCase().includes("clearance") || part.name.toLowerCase().includes("clearance");
  const props = partMaterialProps(part, materials);
  return {
    name: part.name,
    color: partColor(part, materials),
    metalness: props.metalness,
    roughness: props.roughness,
    isSelected: activeSelectedIds.has(part.id),
    isTransparent: transparentPartIds.includes(part.id) || isClearance,
    isClearance,
    hasIssue: issuePartIds.includes(part.id),
    isAffected: highlightPartIds.includes(part.id),
    isAnimating: Boolean(animatingPartName) && part.name === animatingPartName,
    isGhost: ghost,
    isHovered: part.id === hoveredPartId,
    isDimmed:
      activeSelectedIds.size > 0 &&
      dimOthers &&
      !activeSelectedIds.has(part.id) &&
      !ghost &&
      !isClearance,
  };
}

function applyPartStyle(entry: PartCacheEntry, style: PartVisualStyle, theme: "light" | "dark") {
  const { meshMaterial: material, edgeMaterial } = entry;
  entry.group.name = style.name;
  for (const child of entry.group.children) child.name = style.name;

  const transparent = style.isTransparent || style.isGhost || style.isDimmed;
  const transparencyChanged = material.transparent !== transparent;
  material.color.set(style.color);
  if (style.isSelected) {
    material.color.lerp(new THREE.Color(0x4f9dff), 0.25);
  }
  material.metalness = style.metalness;
  material.roughness = style.roughness;
  material.envMapIntensity = style.isTransparent || style.isGhost ? 0.5 : 1.15;
  material.transparent = transparent;
  material.opacity = style.isGhost
    ? 0.1
    : style.isDimmed
      ? 0.85
      : style.isTransparent
        ? style.isClearance
          ? 0.07
          : 0.35
        : 1;
  material.depthWrite = !transparent;
  material.emissive.set(style.isSelected ? 0x2f6fd0 : style.color);
  material.emissiveIntensity = style.isSelected ? 0.25 : style.isAnimating ? 0.55 : 0;
  material.polygonOffsetFactor = style.isSelected ? -1 : 1;
  if (transparencyChanged) material.needsUpdate = true;

  edgeMaterial.visible = true;
  if (style.isSelected) {
    edgeMaterial.color.setHex(0x2f6fd0);
    edgeMaterial.opacity = 0.95;
  } else if (style.isHovered) {
    edgeMaterial.color.setHex(0x4f9dff);
    edgeMaterial.opacity = 0.85;
  } else if (style.isGhost) {
    edgeMaterial.color.setHex(0x8a9199);
    edgeMaterial.opacity = 0.12;
  } else if (style.hasIssue) {
    edgeMaterial.color.setHex(0xcf222e);
    edgeMaterial.opacity = 0.9;
  } else if (style.isAffected) {
    edgeMaterial.color.setHex(0xd28a00);
    edgeMaterial.opacity = 0.85;
  } else if (style.isAnimating) {
    edgeMaterial.color.setHex(0x2f7d5b);
    edgeMaterial.opacity = 0.95;
  } else if (style.isClearance) {
    edgeMaterial.color.setHex(0xd8a53a);
    edgeMaterial.opacity = 0.55;
  } else if (style.isTransparent) {
    edgeMaterial.color.setHex(0x30373b);
    edgeMaterial.opacity = 0.2;
  } else {
    edgeMaterial.color.setHex(theme === "dark" ? 0xc4ccd1 : 0x252c31);
    edgeMaterial.opacity = 0.54;
  }
  edgeMaterial.transparent = true;

  if (entry.silhouette) {
    const silhouetteMaterial = entry.silhouette.material as THREE.ShaderMaterial;
    entry.silhouette.visible = !style.isTransparent && !style.isGhost;
    silhouetteMaterial.uniforms.outlineColor.value.setHex(theme === "dark" ? 0xc4ccd1 : 0x171d21);
    silhouetteMaterial.uniforms.outlineOpacity.value = style.isSelected ? 0.55 : 0.34;
  }

  for (const child of entry.group.children) {
    if (child instanceof THREE.Mesh && child !== entry.silhouette) {
      child.castShadow = !style.isTransparent && !style.isGhost;
    }
  }
}

function buildPartCacheEntry(
  contentRoot: THREE.Group,
  part: ResolvedPart,
  geometryKey: string,
  styleKey: string,
  built: BuiltPartGeometry,
  style: PartVisualStyle,
  silhouetteWidth: number,
  theme: "light" | "dark",
): PartCacheEntry {
  const disposables: { dispose: () => void }[] = [];
  const group = new THREE.Group();
  group.name = part.id;

  const geometry = built.geometry;
  const meshMaterial = new THREE.MeshStandardMaterial({
    polygonOffset: true,
    polygonOffsetUnits: 1,
  });
  const edgeGeometry = built.edges;
  const edgeMaterial = new THREE.LineBasicMaterial({ transparent: true });
  disposables.push(geometry, meshMaterial, edgeGeometry, edgeMaterial);

  const count = Math.max(1, part.array.count);
  let entryStencil: { back: THREE.Mesh; front: THREE.Mesh } | null = null;
  let silhouette: THREE.Mesh | undefined;

  if (count === 1) {
    const silhouetteMaterial = new THREE.ShaderMaterial({
      uniforms: {
        outlineColor: { value: new THREE.Color(theme === "dark" ? 0xc4ccd1 : 0x171d21) },
        outlineOpacity: { value: 0.34 },
        outlineWidth: { value: silhouetteWidth },
      },
      vertexShader: `
        #include <common>
        #include <clipping_planes_pars_vertex>
        attribute vec3 normal;
        uniform float outlineWidth;
        void main() {
          vec3 expanded = position + normalize(normal) * outlineWidth;
          vec4 mvPosition = modelViewMatrix * vec4(expanded, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <clipping_planes_vertex>
        }
      `,
      fragmentShader: `
        #include <common>
        #include <clipping_planes_pars_fragment>
        uniform vec3 outlineColor;
        uniform float outlineOpacity;
        void main() {
          #include <clipping_planes_fragment>
          gl_FragColor = vec4(outlineColor, outlineOpacity);
        }
      `,
      side: THREE.BackSide,
      clipping: true,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    silhouette = new THREE.Mesh(geometry, silhouetteMaterial);
    silhouette.renderOrder = -1;
    silhouette.userData = { silhouette: true };
    group.add(silhouette);
    disposables.push(silhouetteMaterial);
  }

  if (count > 1) {
    const instanced = new THREE.InstancedMesh(geometry, meshMaterial, count);
    const matrix = new THREE.Matrix4();
    for (let index = 0; index < count; index += 1) {
      const offset = { x: 0, y: 0, z: 0 };
      offset[part.array.axis] = part.array.spacing * index;
      matrix.makeTranslation(offset.x, offset.y, offset.z);
      instanced.setMatrixAt(index, matrix);
    }
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
    instanced.name = part.name;
    instanced.userData = { partId: part.id, partName: part.name };
    instanced.receiveShadow = true;
    group.add(instanced);

    const mergedEdges = instanceEdgeGeometry(
      edgeGeometry,
      count,
      part.array.axis,
      part.array.spacing,
    );
    if (mergedEdges) {
      disposables.push(mergedEdges);
      const outline = new THREE.LineSegments(mergedEdges, edgeMaterial);
      outline.userData = { partId: part.id };
      group.add(outline);
    }
  } else {
    const mesh = new THREE.Mesh(geometry, meshMaterial);
    mesh.name = part.name;
    mesh.userData = { partId: part.id, partName: part.name };
    mesh.receiveShadow = true;
    group.add(mesh);

    const outline = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    outline.userData = { partId: part.id };
    group.add(outline);

    const stencilBase = {
      colorWrite: false,
      depthWrite: false,
      depthTest: false,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      transparent: false,
    };
    const stencilBackMaterial = new THREE.MeshBasicMaterial({
      ...stencilBase,
      side: THREE.BackSide,
      stencilFail: THREE.IncrementWrapStencilOp,
      stencilZFail: THREE.IncrementWrapStencilOp,
      stencilZPass: THREE.IncrementWrapStencilOp,
    });
    const stencilFrontMaterial = new THREE.MeshBasicMaterial({
      ...stencilBase,
      side: THREE.FrontSide,
      stencilFail: THREE.DecrementWrapStencilOp,
      stencilZFail: THREE.DecrementWrapStencilOp,
      stencilZPass: THREE.DecrementWrapStencilOp,
    });
    disposables.push(stencilBackMaterial, stencilFrontMaterial);

    const stencilBack = new THREE.Mesh(geometry, stencilBackMaterial);
    const stencilFront = new THREE.Mesh(geometry, stencilFrontMaterial);
    for (const proxy of [stencilBack, stencilFront]) {
      proxy.visible = false;
      proxy.frustumCulled = false;
      proxy.renderOrder = 1;
      group.add(proxy);
    }
    entryStencil = { back: stencilBack, front: stencilFront };
  }

  contentRoot.add(group);
  const entry: PartCacheEntry = {
    geometryKey,
    styleKey,
    group,
    meshMaterial,
    edgeMaterial,
    ...(silhouette ? { silhouette } : {}),
    ...(entryStencil ? { stencilBack: entryStencil.back, stencilFront: entryStencil.front } : {}),
    disposables,
  };
  applyPartStyle(entry, style, theme);
  return entry;
}

/** Builds and caches per-part Three.js meshes asynchronously and updates part highlight/selection styles. */
export function usePartMeshes(options: UsePartMeshesOptions): void {
  const {
    stateRef,
    partCacheRef,
    renderDirtyRef,
    themeRef,
    model,
    materials,
    selectedPartId,
    pickedPartIds,
    hiddenPartIds,
    transparentPartIds,
    issuePartIds,
    highlightPartIds,
    visiblePartCount,
    animatingPartName,
    hoveredPartId,
    dimOthers,
    detailLevel,
    previewQuality,
    theme,
  } = options;

  const shapeKeysRef = useRef(new WeakMap<ResolvedPart, string>());

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    const partCache = partCacheRef.current;
    const shapeKeys = shapeKeysRef.current;

    const dropEntry = (entry: PartCacheEntry) => {
      state.content.remove(entry.group);
      for (const item of entry.disposables) item.dispose();
    };

    if (!model) {
      for (const entry of partCache.values()) dropEntry(entry);
      partCache.clear();
      state.renderer.shadowMap.needsUpdate = true;
      return;
    }

    const limitParts = visiblePartCount > 0 ? visiblePartCount : model.parts.length;
    const wanted = new Set<string>();
    const materialsKey = materials
      .map((material) => `${material.name}:${material.color ?? ""}`)
      .join(",");
    const modelExtent = model?.bounds
      ? Math.max(model.bounds.size.x, model.bounds.size.y, model.bounds.size.z, 500)
      : 1000;
    const silhouetteWidth = Math.max(0.7, Math.min(modelExtent * 0.0018, 4));

    const activeSelectedIds = new Set(
      [selectedPartId, ...pickedPartIds].filter((id): id is string => Boolean(id)),
    );

    let styleChanged = false;
    const pending: {
      part: ResolvedPart;
      geometryKey: string;
      styleKey: string;
      style: PartVisualStyle;
    }[] = [];

    for (const [index, part] of model.parts.entries()) {
      if (hiddenPartIds.includes(part.id)) continue;
      const ghost = visiblePartCount > 0 && index >= limitParts;

      const isClearance =
        part.id.toLowerCase().includes("clearance") || part.name.toLowerCase().includes("clearance");
      const isSmallDetail = /(bolt|nut|screw|washer|pin|label|tag|indicator|hole)/i.test(
        part.name || "",
      );
      if (detailLevel === "coarse" && (isClearance || isSmallDetail)) continue;

      wanted.add(part.id);

      let shapeKey = shapeKeys.get(part);
      if (!shapeKey) {
        shapeKey = `${JSON.stringify(part.solid)}|${JSON.stringify(part.cuts)}|${JSON.stringify(part.array)}`;
        shapeKeys.set(part, shapeKey);
      }

      const geometryKey = `${shapeKey}|${previewQuality}`;
      const style = computePartStyle(
        part,
        materials,
        activeSelectedIds,
        transparentPartIds,
        issuePartIds,
        highlightPartIds,
        animatingPartName,
        hoveredPartId,
        dimOthers,
        ghost,
      );
      const styleKey = [
        part.name,
        part.material ?? "",
        part.color ?? "",
        materialsKey,
        style.isSelected ? "selected" : "",
        style.isTransparent ? "transparent" : "",
        style.isClearance ? "clearance" : "",
        style.hasIssue ? "issue" : "",
        style.isAffected ? "affected" : "",
        style.isAnimating ? "hot" : "",
        style.isGhost ? "ghost" : "",
        style.isHovered ? "hover" : "",
        style.isDimmed ? "dim" : "",
        theme,
      ].join("|");

      const existing = partCache.get(part.id);
      if (existing && existing.geometryKey === geometryKey) {
        if (existing.styleKey !== styleKey) {
          applyPartStyle(existing, style, theme);
          existing.styleKey = styleKey;
          styleChanged = true;
        }
        continue;
      }

      if (existing) dropEntry(existing);
      pending.push({ part, geometryKey, styleKey, style });
    }

    for (const [id, entry] of partCache) {
      if (wanted.has(id)) continue;
      dropEntry(entry);
      partCache.delete(id);
    }

    let cancelled = false;
    let cursor = 0;
    let inFlight = 0;
    let scheduled = false;

    const schedule = () => {
      if (cancelled || scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        pump();
      });
    };

    const pump = () => {
      if (cancelled) return;
      while (inFlight < 3 && cursor < pending.length) {
        const { part, geometryKey, styleKey, style } = pending[cursor];
        cursor += 1;
        inFlight += 1;

        void buildPartGeometryAsync(part, previewQuality)
          .then((built) => {
            if (cancelled) {
              built.geometry.dispose();
              built.edges.dispose();
              return;
            }
            partCache.set(
              part.id,
              buildPartCacheEntry(
                state.content,
                part,
                geometryKey,
                styleKey,
                built,
                style,
                silhouetteWidth,
                themeRef.current,
              ),
            );
            state.renderer.shadowMap.needsUpdate = true;
            renderDirtyRef.current = true;
          })
          .catch((error) => {
            console.warn("Could not build part geometry", part.id, error);
          })
          .finally(() => {
            inFlight -= 1;
            if (!cancelled && (cursor < pending.length || inFlight > 0)) schedule();
          });
      }
    };

    if (pending.length > 0) {
      schedule();
    } else if (styleChanged) {
      state.renderer.shadowMap.needsUpdate = true;
      renderDirtyRef.current = true;
    }

    return () => {
      cancelled = true;
    };
  }, [
    stateRef,
    partCacheRef,
    renderDirtyRef,
    themeRef,
    model,
    materials,
    selectedPartId,
    pickedPartIds,
    hiddenPartIds,
    transparentPartIds,
    issuePartIds,
    highlightPartIds,
    visiblePartCount,
    animatingPartName,
    hoveredPartId,
    dimOthers,
    detailLevel,
    previewQuality,
    theme,
  ]);
}
