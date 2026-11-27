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
import type { PartCacheEntry, SceneState, ViewerDisplayMode } from "./types";

export interface UsePartMeshesOptions {
  stateRef: MutableRefObject<SceneState | null>;
  partCacheRef: MutableRefObject<Map<string, PartCacheEntry>>;
  renderDirtyRef: MutableRefObject<boolean>;
  themeRef: MutableRefObject<"light" | "dark">;
  displayModeRef: MutableRefObject<ViewerDisplayMode>;
  showSilhouettesRef: MutableRefObject<boolean>;
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
  displayMode: ViewerDisplayMode;
  showSilhouettes: boolean;
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

export function applyPartStyle(
  entry: PartCacheEntry,
  style: PartVisualStyle,
  theme: "light" | "dark",
  displayMode: ViewerDisplayMode = "shadedEdges",
  showSilhouettes = true,
) {
  const { meshMaterial: material, edgeMaterial } = entry;
  entry.group.name = style.name;
  for (const child of entry.group.children) child.name = style.name;

  const isWireframe = displayMode === "wireframe";
  const isHiddenLine = displayMode === "hiddenLine";
  const showEdges = displayMode !== "shaded";

  const transparent = style.isTransparent || style.isGhost || style.isDimmed;
  const transparencyChanged = material.transparent !== transparent;
  if (isHiddenLine) {
    const paper = new THREE.Color(theme === "dark" ? 0x22282e : 0xffffff);
    if (style.isSelected) paper.lerp(new THREE.Color(0x4f9dff), 0.22);
    else if (style.hasIssue) paper.lerp(new THREE.Color(0xcf222e), 0.18);
    else if (style.isAffected) paper.lerp(new THREE.Color(0xd28a00), 0.16);
    else if (style.isAnimating) paper.lerp(new THREE.Color(0x2f7d5b), 0.2);
    material.color.setHex(0x000000);
    material.metalness = 0;
    material.roughness = 1;
    material.envMapIntensity = 0;
    material.emissive.copy(paper);
    material.emissiveIntensity = 1;
  } else {
    material.color.set(style.color);
    if (style.isSelected) {
      material.color.lerp(new THREE.Color(0x4f9dff), 0.25);
    }
    material.metalness = style.metalness;
    material.roughness = style.roughness;
    material.envMapIntensity = style.isTransparent || style.isGhost ? 0.5 : 1.15;
    material.emissive.set(style.isSelected ? 0x2f6fd0 : style.color);
    material.emissiveIntensity = style.isSelected ? 0.25 : style.isAnimating ? 0.55 : 0;
  }

  material.colorWrite = !isWireframe;
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
  material.depthWrite = isWireframe ? false : !transparent;
  material.polygonOffsetFactor = style.isSelected ? -1 : 1;
  if (transparencyChanged) material.needsUpdate = true;

  edgeMaterial.visible = showEdges;
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
    edgeMaterial.color.setHex(theme === "dark" ? 0x768390 : 0x30373b);
    edgeMaterial.opacity = isWireframe ? 0.38 : 0.2;
  } else if (isHiddenLine || isWireframe) {
    edgeMaterial.color.setHex(theme === "dark" ? 0xd0d7de : 0x1f252a);
    edgeMaterial.opacity = isHiddenLine ? 0.86 : 0.82;
  } else {
    edgeMaterial.color.setHex(theme === "dark" ? 0xc4ccd1 : 0x252c31);
    edgeMaterial.opacity = 0.54;
  }
  edgeMaterial.transparent = true;

  if (entry.tangentMaterial) {
    entry.tangentMaterial.color.copy(edgeMaterial.color);
    entry.tangentMaterial.opacity = Math.min(1, edgeMaterial.opacity * 0.72);
    entry.tangentMaterial.transparent = true;
    entry.tangentMaterial.visible = isHiddenLine || isWireframe;
  }

  if (entry.smoothLines) {
    const smoothMaterial = entry.smoothLines.material as THREE.ShaderMaterial;
    entry.smoothLines.visible =
      showSilhouettes && (isHiddenLine || isWireframe) && !style.isTransparent && !style.isGhost;
    smoothMaterial.uniforms.lineColor.value.copy(edgeMaterial.color);
    smoothMaterial.uniforms.lineOpacity.value = edgeMaterial.opacity;
  }

  if (entry.silhouette) {
    const silhouetteMaterial = entry.silhouette.material as THREE.ShaderMaterial;
    entry.silhouette.visible =
      showSilhouettes && !isWireframe && !isHiddenLine && !style.isTransparent && !style.isGhost;
    silhouetteMaterial.uniforms.outlineColor.value.setHex(theme === "dark" ? 0xc4ccd1 : 0x171d21);
    silhouetteMaterial.uniforms.outlineOpacity.value = style.isSelected ? 0.55 : 0.36;
    silhouetteMaterial.uniforms.outlinePx.value = style.isSelected ? 1.65 : 1.25;
  }

  for (const child of entry.group.children) {
    if (child instanceof THREE.Mesh && child !== entry.silhouette) {
      child.castShadow = !isWireframe && !style.isTransparent && !style.isGhost;
    }
  }
}

const DEFAULT_SILHOUETTE_PX = 1.25;

/**
 * Computes angle-weighted vertex normals welded by 3D coordinate only, so split
 * bevel/curved triangle strips expand continuously without comb-teeth cracks.
 */
export function computeSmoothNormals(geometry: THREE.BufferGeometry): THREE.Float32BufferAttribute {
  const position = geometry.getAttribute("position");
  const count = position?.count ?? 0;
  const result = new Float32Array(count * 3);
  if (!position || count === 0) {
    return new THREE.Float32BufferAttribute(result, 3);
  }

  const bucketIdByVertex = new Int32Array(count);
  const keyToBucket = new Map<string, number>();
  let bucketCount = 0;
  for (let i = 0; i < count; i += 1) {
    const kx = Math.round(position.getX(i) * 1000) || 0;
    const ky = Math.round(position.getY(i) * 1000) || 0;
    const kz = Math.round(position.getZ(i) * 1000) || 0;
    const key = `${kx}|${ky}|${kz}`;
    let bucket = keyToBucket.get(key);
    if (bucket === undefined) {
      bucket = bucketCount;
      bucketCount += 1;
      keyToBucket.set(key, bucket);
    }
    bucketIdByVertex[i] = bucket;
  }

  const accum = new Float64Array(bucketCount * 3);
  const index = geometry.getIndex();
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(count / 3);

  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const eAB = new THREE.Vector3();
  const eAC = new THREE.Vector3();
  const eBC = new THREE.Vector3();
  const eBA = new THREE.Vector3();
  const eCA = new THREE.Vector3();
  const eCB = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();

  const cornerAngle = (u: THREE.Vector3, v: THREE.Vector3): number => {
    const lu = u.length();
    const lv = v.length();
    if (lu < 1e-10 || lv < 1e-10) return 0;
    const dot = Math.max(-1, Math.min(1, u.dot(v) / (lu * lv)));
    return Math.acos(dot);
  };

  for (let t = 0; t < triCount; t += 1) {
    const iA = index ? index.getX(t * 3) : t * 3;
    const iB = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const iC = index ? index.getX(t * 3 + 2) : t * 3 + 2;

    pA.fromBufferAttribute(position, iA);
    pB.fromBufferAttribute(position, iB);
    pC.fromBufferAttribute(position, iC);

    eAB.subVectors(pB, pA);
    eAC.subVectors(pC, pA);
    faceNormal.crossVectors(eAB, eAC);
    const fnLen = faceNormal.length();
    if (fnLen < 1e-12) continue;
    faceNormal.divideScalar(fnLen);

    eBA.copy(eAB).negate();
    eBC.subVectors(pC, pB);
    eCA.copy(eAC).negate();
    eCB.copy(eBC).negate();

    const wA = cornerAngle(eAB, eAC);
    const wB = cornerAngle(eBC, eBA);
    const wC = cornerAngle(eCA, eCB);

    const bA = bucketIdByVertex[iA] * 3;
    accum[bA] += faceNormal.x * wA;
    accum[bA + 1] += faceNormal.y * wA;
    accum[bA + 2] += faceNormal.z * wA;

    const bB = bucketIdByVertex[iB] * 3;
    accum[bB] += faceNormal.x * wB;
    accum[bB + 1] += faceNormal.y * wB;
    accum[bB + 2] += faceNormal.z * wB;

    const bC = bucketIdByVertex[iC] * 3;
    accum[bC] += faceNormal.x * wC;
    accum[bC + 1] += faceNormal.y * wC;
    accum[bC + 2] += faceNormal.z * wC;
  }

  for (let b = 0; b < bucketCount; b += 1) {
    const base = b * 3;
    const len = Math.hypot(accum[base], accum[base + 1], accum[base + 2]);
    if (len > 1e-12) {
      accum[base] /= len;
      accum[base + 1] /= len;
      accum[base + 2] /= len;
    }
  }

  const fallbackNormal = geometry.getAttribute("normal");
  for (let i = 0; i < count; i += 1) {
    const bBase = bucketIdByVertex[i] * 3;
    const out = i * 3;
    const nx = accum[bBase];
    const ny = accum[bBase + 1];
    const nz = accum[bBase + 2];
    if (nx * nx + ny * ny + nz * nz > 1e-12) {
      result[out] = nx;
      result[out + 1] = ny;
      result[out + 2] = nz;
    } else if (fallbackNormal) {
      result[out] = fallbackNormal.getX(i);
      result[out + 1] = fallbackNormal.getY(i);
      result[out + 2] = fallbackNormal.getZ(i);
    } else {
      result[out + 2] = 1;
    }
  }

  return new THREE.Float32BufferAttribute(result, 3);
}

/** Creates the screen-space back-face silhouette shader material without redeclaring Three.js built-ins. */
export function createPartSilhouetteMaterial(
  outlinePx = DEFAULT_SILHOUETTE_PX,
  theme: "light" | "dark" = "light",
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      outlineColor: { value: new THREE.Color(theme === "dark" ? 0xc4ccd1 : 0x171d21) },
      outlineOpacity: { value: 0.36 },
      outlinePx: { value: outlinePx },
      uResolution: { value: new THREE.Vector2(1280, 820) },
    },
    vertexShader: `
      #include <common>
      #include <clipping_planes_pars_vertex>
      attribute vec3 smoothNormal;
      uniform float outlinePx;
      uniform vec2 uResolution;
      varying float vFrontFacing;
      void main() {
        vec4 localPos = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          vec4 mvPosition = modelViewMatrix * instanceMatrix * localPos;
          vec3 faceViewNormal = normalMatrix * mat3(instanceMatrix) * normal;
        #else
          vec4 mvPosition = modelViewMatrix * localPos;
          vec3 faceViewNormal = normalMatrix * normal;
        #endif
        float faceLen = length(faceViewNormal);
        float viewLen = length(mvPosition.xyz);
        vFrontFacing = (faceLen > 0.0001 && viewLen > 0.0001)
          ? dot(faceViewNormal / faceLen, -mvPosition.xyz / viewLen)
          : -1.0;

        vec4 clipPos = projectionMatrix * mvPosition;
        vec4 mvBiased = mvPosition;
        mvBiased.z -= max(0.02, -mvPosition.z * 0.0008);
        vec4 biasedClip = projectionMatrix * mvBiased;
        if (abs(biasedClip.w) > 0.00001) {
          clipPos.z = biasedClip.z * (clipPos.w / biasedClip.w);
        }

        float normalLen = length(smoothNormal);
        if (normalLen > 0.0001 && uResolution.x > 0.0 && uResolution.y > 0.0) {
          vec3 safeNormal = smoothNormal / normalLen;
          #ifdef USE_INSTANCING
            vec3 viewNormal = normalMatrix * mat3(instanceMatrix) * safeNormal;
          #else
            vec3 viewNormal = normalMatrix * safeNormal;
          #endif
          vec2 clipNormal = (projectionMatrix * vec4(viewNormal, 0.0)).xy;
          vec2 pxDir = clipNormal * uResolution;
          float pxLen = length(pxDir);
          if (pxLen > 0.0001) {
            vec2 pxNormal = pxDir / pxLen;
            clipPos.xy += pxNormal * (outlinePx * 2.0 / uResolution) * clipPos.w;
          }
        }
        gl_Position = clipPos;
        #include <clipping_planes_vertex>
      }
    `,
    fragmentShader: `
      #include <common>
      #include <clipping_planes_pars_fragment>
      uniform vec3 outlineColor;
      uniform float outlineOpacity;
      varying float vFrontFacing;
      void main() {
        #include <clipping_planes_fragment>
        if (vFrontFacing > 0.15) discard;
        gl_FragColor = vec4(outlineColor, outlineOpacity);
      }
    `,
    side: THREE.BackSide,
    clipping: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
  });
}

/**
 * Creates a line shader material that renders only curved-surface interior edges whose two
 * adjacent faces cross the camera horizon `(nA · V)(nB · V) <= 0` (Revit silhouette lines).
 */
export function createCurvedSilhouetteLineMaterial(
  theme: "light" | "dark" = "light",
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      lineColor: { value: new THREE.Color(theme === "dark" ? 0xd0d7de : 0x1f252a) },
      lineOpacity: { value: 0.84 },
    },
    vertexShader: `
      #include <common>
      #include <clipping_planes_pars_vertex>
      attribute vec3 aEdgeMid;
      attribute vec3 aNormalA;
      attribute vec3 aNormalB;
      void main() {
        vec3 midWorld = (modelMatrix * vec4(aEdgeMid, 1.0)).xyz;
        vec3 viewDir = cameraPosition - midWorld;
        mat3 normalMat = mat3(modelMatrix);
        vec3 nA = normalMat * aNormalA;
        vec3 nB = normalMat * aNormalB;
        float dA = dot(nA, viewDir);
        float dB = dot(nB, viewDir);
        bool onHorizon = (dA >= 0.0 && dB < 0.0) || (dB >= 0.0 && dA < 0.0);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = onHorizon ? (projectionMatrix * mvPosition) : vec4(2.0, 2.0, 2.0, 1.0);
        #include <clipping_planes_vertex>
      }
    `,
    fragmentShader: `
      #include <common>
      #include <clipping_planes_pars_fragment>
      uniform vec3 lineColor;
      uniform float lineOpacity;
      void main() {
        #include <clipping_planes_fragment>
        gl_FragColor = vec4(lineColor, lineOpacity);
      }
    `,
    clipping: true,
    transparent: true,
    depthTest: true,
  });
}

function buildPartCacheEntry(
  contentRoot: THREE.Group,
  part: ResolvedPart,
  geometryKey: string,
  styleKey: string,
  built: BuiltPartGeometry,
  style: PartVisualStyle,
  themeRef: MutableRefObject<"light" | "dark">,
  displayModeRef: MutableRefObject<ViewerDisplayMode>,
  showSilhouettesRef: MutableRefObject<boolean>,
): PartCacheEntry {
  const disposables: { dispose: () => void }[] = [];
  const group = new THREE.Group();
  group.name = part.id;

  const geometry = built.geometry;
  if (!geometry.getAttribute("smoothNormal")) {
    geometry.setAttribute("smoothNormal", computeSmoothNormals(geometry));
  }
  const meshMaterial = new THREE.MeshStandardMaterial({
    polygonOffset: true,
    polygonOffsetUnits: 1,
  });
  const edgeGeometry = built.edges;
  const tangentGeometry = built.tangentEdges;
  const smoothGeometry = built.smoothEdges;
  const edgeMaterial = new THREE.LineBasicMaterial({ transparent: true });
  const tangentMaterial = new THREE.LineBasicMaterial({ transparent: true });
  const smoothMaterial = createCurvedSilhouetteLineMaterial(themeRef.current);
  disposables.push(
    geometry,
    meshMaterial,
    edgeGeometry,
    tangentGeometry,
    smoothGeometry,
    edgeMaterial,
    tangentMaterial,
    smoothMaterial,
  );

  const count = Math.max(1, part.array.count);
  let entryStencil: { back: THREE.Mesh; front: THREE.Mesh } | null = null;
  let tangentLines: THREE.LineSegments | undefined;
  let smoothLines: THREE.LineSegments | undefined;
  const silhouetteMaterial = createPartSilhouetteMaterial(
    DEFAULT_SILHOUETTE_PX,
    themeRef.current,
  );
  disposables.push(silhouetteMaterial);

  let silhouette: THREE.Mesh;
  if (count > 1) {
    const instanced = new THREE.InstancedMesh(geometry, meshMaterial, count);
    const silhouetteInstanced = new THREE.InstancedMesh(geometry, silhouetteMaterial, count);
    const matrix = new THREE.Matrix4();
    for (let index = 0; index < count; index += 1) {
      const offset = { x: 0, y: 0, z: 0 };
      offset[part.array.axis] = part.array.spacing * index;
      matrix.makeTranslation(offset.x, offset.y, offset.z);
      instanced.setMatrixAt(index, matrix);
      silhouetteInstanced.setMatrixAt(index, matrix);
    }
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
    instanced.name = part.name;
    instanced.userData = { partId: part.id, partName: part.name };
    instanced.receiveShadow = true;
    group.add(instanced);

    silhouetteInstanced.instanceMatrix.needsUpdate = true;
    silhouetteInstanced.computeBoundingSphere();
    silhouetteInstanced.renderOrder = -1;
    silhouetteInstanced.raycast = () => {};
    silhouetteInstanced.userData = { silhouette: true };
    silhouetteInstanced.onBeforeRender = (renderer) => {
      renderer.getSize(silhouetteMaterial.uniforms.uResolution.value);
    };
    group.add(silhouetteInstanced);
    silhouette = silhouetteInstanced;

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

    const mergedTangents = instanceEdgeGeometry(
      tangentGeometry,
      count,
      part.array.axis,
      part.array.spacing,
    );
    if (mergedTangents && mergedTangents.getAttribute("position")?.count) {
      disposables.push(mergedTangents);
      tangentLines = new THREE.LineSegments(mergedTangents, tangentMaterial);
      tangentLines.raycast = () => {};
      group.add(tangentLines);
    }

    const mergedSmooth = instanceEdgeGeometry(
      smoothGeometry,
      count,
      part.array.axis,
      part.array.spacing,
    );
    if (mergedSmooth && mergedSmooth.getAttribute("position")?.count) {
      disposables.push(mergedSmooth);
      smoothLines = new THREE.LineSegments(mergedSmooth, smoothMaterial);
      smoothLines.raycast = () => {};
      group.add(smoothLines);
    }
  } else {
    silhouette = new THREE.Mesh(geometry, silhouetteMaterial);
    silhouette.renderOrder = -1;
    silhouette.raycast = () => {};
    silhouette.userData = { silhouette: true };
    silhouette.onBeforeRender = (renderer) => {
      renderer.getSize(silhouetteMaterial.uniforms.uResolution.value);
    };
    group.add(silhouette);

    const mesh = new THREE.Mesh(geometry, meshMaterial);
    mesh.name = part.name;
    mesh.userData = { partId: part.id, partName: part.name };
    mesh.receiveShadow = true;
    group.add(mesh);

    const outline = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    outline.userData = { partId: part.id };
    group.add(outline);

    if (tangentGeometry.getAttribute("position")?.count) {
      tangentLines = new THREE.LineSegments(tangentGeometry, tangentMaterial);
      tangentLines.raycast = () => {};
      group.add(tangentLines);
    }

    if (smoothGeometry.getAttribute("position")?.count) {
      smoothLines = new THREE.LineSegments(smoothGeometry, smoothMaterial);
      smoothLines.raycast = () => {};
      group.add(smoothLines);
    }

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
  let latestStyle = style;
  const entry: PartCacheEntry = {
    geometryKey,
    styleKey,
    group,
    meshMaterial,
    edgeMaterial,
    tangentMaterial,
    ...(tangentLines ? { tangentLines } : {}),
    ...(smoothLines ? { smoothLines } : {}),
    silhouette,
    applyDefaultStyle: (defaultTheme) => {
      applyPartStyle(
        entry,
        latestStyle,
        defaultTheme ?? themeRef.current,
        "shadedEdges",
        true,
      );
      return () => {
        applyPartStyle(
          entry,
          latestStyle,
          themeRef.current,
          displayModeRef.current,
          showSilhouettesRef.current,
        );
      };
    },
    ...(entryStencil ? { stencilBack: entryStencil.back, stencilFront: entryStencil.front } : {}),
    disposables,
  };
  applyPartStyle(entry, style, themeRef.current, displayModeRef.current, showSilhouettesRef.current);
  // Wrap applyDefaultStyle capture update whenever style updates below:
  (entry as PartCacheEntry & { setLatestStyle?: (next: PartVisualStyle) => void }).setLatestStyle = (
    next: PartVisualStyle,
  ) => {
    latestStyle = next;
  };
  return entry;
}

/** Builds and caches per-part Three.js meshes asynchronously and updates part highlight/selection styles. */
export function usePartMeshes(options: UsePartMeshesOptions): void {
  const {
    stateRef,
    partCacheRef,
    renderDirtyRef,
    themeRef,
    displayModeRef,
    showSilhouettesRef,
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
    displayMode,
    showSilhouettes,
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
        displayMode,
        showSilhouettes ? "sil1" : "sil0",
      ].join("|");

      const existing = partCache.get(part.id);
      if (existing && existing.geometryKey === geometryKey) {
        if (existing.styleKey !== styleKey) {
          (
            existing as PartCacheEntry & { setLatestStyle?: (next: PartVisualStyle) => void }
          ).setLatestStyle?.(style);
          applyPartStyle(existing, style, theme, displayMode, showSilhouettes);
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
              built.tangentEdges.dispose();
              built.smoothEdges.dispose();
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
                themeRef,
                displayModeRef,
                showSilhouettesRef,
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
    displayModeRef,
    showSilhouettesRef,
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
    displayMode,
    showSilhouettes,
  ]);
}
