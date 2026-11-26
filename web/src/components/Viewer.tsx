import { useCallback, useEffect, useRef, useState } from "react";
import type { ResolvedModel, ResolvedPart } from "@family/spec-core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { formatDimensions } from "../lib/format";
import {
  instanceEdgeGeometry,
  partColor,
  partMaterialProps,
  type PreviewQuality,
} from "../lib/three-build";
import { buildPartGeometryAsync, type BuiltPartGeometry } from "../lib/geometry-pool";
import { useI18n } from "../lib/i18n";
import type { ModelNote } from "../lib/annotations";
import {
  buildDimensionsGroup,
  buildGhostCutsGroup,
  captureViewerThumbnail,
  computeCameraPreset,
  createInfiniteGrid,
  createSectionCap,
  planeCrossSection,
  populateConnectors,
  populatePartHandles,
  populateRefPlanes,
} from "./viewer/sceneHelpers";
import { setupViewCube } from "./viewer/viewCube";
import { attachViewerInteractions } from "./viewer/interactions";
import { ViewerOverlays } from "./viewer/ViewerOverlays";
import type {
  ActiveHandleState,
  ContextMenuState,
  NoteComposerState,
  PartCacheEntry,
  SceneState,
  SectionCustomState,
  SectionDragData,
  ViewDirection,
  ViewerProps,
} from "./viewer/types";

export function Viewer({
  model,
  parameters = [],
  materials,
  units,
  showGrid,
  onToggleGrid,
  showPlanes,
  onTogglePlanes,
  showConnectors,
  onToggleConnectors,
  selectedPartId,
  onSelectPart,
  onSendPartsToChat,
  notes = [],
  onAddNote,
  onFocusNote,
  focusNote = null,
  hiddenPartIds = [],
  onToggleHidePart,
  onUnhideAll,
  transparentPartIds = [],
  onToggleTransparentPart,
  onResetTransparent,
  issuePartIds = [],
  highlightPartIds = [],
  focusPartId = null,
  onUpdateParameter,
  onLoadSample,
  onCaptureReady,
  fileName,
  skippedCutPartIds = [],
  theme = "light",
}: ViewerProps) {
  const { t, formatNumber } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const cubeHostRef = useRef<HTMLDivElement>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const formatNumberRef = useRef(formatNumber);
  formatNumberRef.current = formatNumber;
  const onCaptureReadyRef = useRef<ViewerProps["onCaptureReady"]>(onCaptureReady);
  onCaptureReadyRef.current = onCaptureReady;
  const stateRef = useRef<SceneState | null>(null);
  const setViewRef = useRef<(direction: ViewDirection) => void>(() => {});
  const renderDirtyRef = useRef(true);
  const modelRef = useRef<ResolvedModel | null>(model);
  const onSelectPartRef = useRef(onSelectPart);
  onSelectPartRef.current = onSelectPart;
  const onSendPartsToChatRef = useRef(onSendPartsToChat);
  onSendPartsToChatRef.current = onSendPartsToChat;
  const onFocusNoteRef = useRef(onFocusNote);
  onFocusNoteRef.current = onFocusNote;
  const onUpdateParameterRef = useRef(onUpdateParameter);
  onUpdateParameterRef.current = onUpdateParameter;
  const hasFittedRef = useRef(false);
  modelRef.current = model;

  const [activeHandle, setActiveHandle] = useState<ActiveHandleState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [pickedPartIds, setPickedPartIds] = useState<string[]>([]);
  const pickedPartIdsRef = useRef<string[]>([]);
  pickedPartIdsRef.current = pickedPartIds;
  const notesRef = useRef<ModelNote[]>(notes);
  notesRef.current = notes;
  const notePinRefs = useRef(new Map<string, HTMLButtonElement>());
  const [noteComposer, setNoteComposer] = useState<NoteComposerState | null>(null);

  // A selection made in the parameter panel or chat replaces the Ctrl+click set.
  useEffect(() => {
    if (!selectedPartId) {
      setPickedPartIds([]);
      return;
    }
    setPickedPartIds((current) =>
      current.includes(selectedPartId) ? current : [selectedPartId],
    );
  }, [selectedPartId]);

  // Drop ids that no longer exist after a spec edit.
  useEffect(() => {
    const live = new Set((model?.parts ?? []).map((part) => part.id));
    setPickedPartIds((current) => {
      const next = current.filter((id) => live.has(id));
      return next.length === current.length ? current : next;
    });
  }, [model]);

  const [visiblePartCount, setVisiblePartCount] = useState<number>(0);
  const prevModelRef = useRef<ResolvedModel | null>(null);
  const partCacheRef = useRef(new Map<string, PartCacheEntry>());
  const shapeKeysRef = useRef(new WeakMap<ResolvedPart, string>());

  const [animatingPartName, setAnimatingPartName] = useState<string | null>(null);
  const [detailLevel, setDetailLevel] = useState<"coarse" | "medium" | "fine">("fine");
  const previewQuality: PreviewQuality = "high";
  const [turntableActive, setTurntableActive] = useState<boolean>(false);
  const turntableRef = useRef<boolean>(false);
  turntableRef.current = turntableActive;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const [shadowsEnabled, setShadowsEnabled] = useState<boolean>(true);
  const shadowsEnabledRef = useRef<boolean>(true);
  shadowsEnabledRef.current = shadowsEnabled;

  // Section (clipping plane) and measurement tools.
  const [sectionAxis, setSectionAxis] = useState<"off" | "x" | "y" | "z" | "custom">("off");
  const [sectionT, setSectionT] = useState(1);
  const [sectionCustom, setSectionCustom] = useState<SectionCustomState | null>(null);
  const [pickingSection, setPickingSection] = useState(false);
  const pickingSectionRef = useRef(false);
  pickingSectionRef.current = pickingSection;
  const [measuring, setMeasuring] = useState(false);
  const [measureLabel, setMeasureLabel] = useState<string | null>(null);
  const [measureCount, setMeasureCount] = useState(0);
  const measuringRef = useRef(false);
  measuringRef.current = measuring;
  const measurePointsRef = useRef<THREE.Vector3[]>([]);
  const measureSegmentsRef = useRef<THREE.Group[]>([]);
  const measureMarkersRef = useRef<THREE.Mesh[]>([]);
  const measurePreviewGroupRef = useRef<THREE.Group | null>(null);
  const sectionPlaneRef = useRef<THREE.Group | null>(null);
  const sectionOutlineRef = useRef<THREE.Group | null>(null);
  const sectionArrowRef = useRef<THREE.Object3D | null>(null);
  const sectionHandleLabelRef = useRef<THREE.Sprite | null>(null);
  const sectionBuildKeyRef = useRef<string>("off");
  const sectionDragRef = useRef(false);
  const sectionDragMovedRef = useRef(false);
  const sectionDragDataRef = useRef<SectionDragData | null>(null);

  const [hoveredPartId, setHoveredPartId] = useState<string | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; name: string } | null>(null);
  const [dimOthers, setDimOthers] = useState(true);
  const [sectionFill, setSectionFill] = useState(true);
  const [explode, setExplode] = useState(0);
  const [explodeOpen, setExplodeOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [showDimensions, setShowDimensions] = useState(false);
  const [dimView, setDimView] = useState("111");
  const dimViewRef = useRef("111");
  const showDimensionsRef = useRef(false);
  showDimensionsRef.current = showDimensions;
  const explodeDirsRef = useRef(new WeakMap<THREE.Object3D, THREE.Vector3>());
  const explodeFitRef = useRef<{ pos: THREE.Vector3; look: THREE.Vector3 } | null>(null);
  const dimensionsRef = useRef<THREE.Group | null>(null);
  const ghostCutsRef = useRef<THREE.Group | null>(null);
  const sectionCapRef = useRef<THREE.Mesh | null>(null);
  const hoverBlockedRef = useRef(false);
  hoverBlockedRef.current = measuring || pickingSection || sectionAxis !== "off";

  /** Export the current view as a PNG named after the family. */
  const saveImage = () => {
    const state = stateRef.current;
    if (!state) return;
    state.renderer.render(state.scene, state.camera);
    const link = document.createElement("a");
    const safe = (fileName || "family").replace(/[\\/:*?"<>|]+/g, "-");
    link.href = state.renderer.domElement.toDataURL("image/png");
    link.download = `${safe}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  /** Keep HTML note pins attached to their world point without hiding behind geometry. */
  const positionNotePins = useCallback(() => {
    const state = stateRef.current;
    const host = hostRef.current;
    if (!state || !host) return;
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const projected = new THREE.Vector3();
    for (const note of notesRef.current) {
      const pin = notePinRefs.current.get(note.id);
      if (!pin) continue;
      projected.set(note.point.x, note.point.y, note.point.z).project(state.camera);
      const visible = projected.z <= 1 && projected.z >= -1;
      pin.style.display = visible ? "inline-flex" : "none";
      if (!visible) continue;
      const x = (projected.x * 0.5 + 0.5) * rect.width;
      const y = (-projected.y * 0.5 + 0.5) * rect.height;
      pin.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
    }
  }, []);

  useEffect(() => {
    positionNotePins();
  }, [notes, positionNotePins]);

  const clearMeasurements = () => {
    const state = stateRef.current;
    measurePointsRef.current = [];

    if (state) {
      for (const group of measureSegmentsRef.current) {
        state.scene.remove(group);
        group.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            mesh.geometry.dispose();
            const material = mesh.material as THREE.Material | THREE.Material[];
            if (Array.isArray(material)) material.forEach((item) => item.dispose());
            else material.dispose();
          } else if ((child as THREE.Sprite).isSprite) {
            const material = (child as THREE.Sprite).material;
            material.map?.dispose();
            material.dispose();
          }
        });
      }

      for (const marker of measureMarkersRef.current) {
        state.scene.remove(marker);
        marker.geometry.dispose();
        (marker.material as THREE.Material).dispose();
      }
    }

    measureSegmentsRef.current = [];
    measureMarkersRef.current = [];
    if (measurePreviewGroupRef.current) measurePreviewGroupRef.current.visible = false;
    setMeasureCount(0);
    setMeasureLabel(null);
    renderDirtyRef.current = true;
  };

  useEffect(() => {
    if (!model || model.parts.length === 0) {
      setVisiblePartCount(0);
      setAnimatingPartName(null);
      prevModelRef.current = null;
      return;
    }

    const prevParts = prevModelRef.current?.parts;

    if (prevParts && model.parts.length > prevParts.length) {
      prevModelRef.current = model;
      setVisiblePartCount(model.parts.length);
      const newestPart = model.parts[model.parts.length - 1];
      setAnimatingPartName(newestPart?.name || null);
      const timer = setTimeout(() => setAnimatingPartName(null), 1000);
      return () => clearTimeout(timer);
    }

    const isDifferent =
      !prevParts ||
      prevParts.length !== model.parts.length ||
      model.parts.some((p, i) => prevParts[i]?.id !== p.id || prevParts[i]?.name !== p.name);

    prevModelRef.current = model;

    if (isDifferent) {
      setVisiblePartCount(1);
      setAnimatingPartName(model.parts[0]?.name || null);

      const total = model.parts.length;
      const step = total > 40 ? 90 : total > 16 ? 150 : 320;
      let count = 1;

      const interval = setInterval(() => {
        count += 1;
        setVisiblePartCount(count);
        setAnimatingPartName(model.parts[count - 1]?.name || null);
        if (count >= total) {
          clearInterval(interval);
          setTimeout(() => setAnimatingPartName(null), 900);
        }
      }, step);
      return () => clearInterval(interval);
    }

    setVisiblePartCount(model.parts.length);
    setAnimatingPartName(null);
  }, [model]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      stencil: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.96;
    renderer.shadowMap.enabled = shadowsEnabledRef.current;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    host.appendChild(renderer.domElement);

    const debugStats = new URLSearchParams(window.location.search).has("debug");
    let statsEl: HTMLDivElement | null = null;
    if (debugStats) {
      statsEl = document.createElement("div");
      statsEl.className = "viewer-stats";
      host.appendChild(statsEl);
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(themeRef.current === "dark" ? 0x191e22 : 0xece9e2);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = environment;
    scene.environmentIntensity = 0.42;

    const camera = new THREE.PerspectiveCamera(38, 1, 10, 200000);
    camera.up.set(0, 0, 1);
    camera.position.set(3200, -3600, 2400);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 80;
    controls.maxDistance = 60000;
    controls.maxPolarAngle = Math.PI - 0.05;

    controls.addEventListener("start", () => {
      if (turntableRef.current) setTurntableActive(false);
    });
    controls.addEventListener("change", () => {
      renderDirtyRef.current = true;
    });

    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };

    scene.add(new THREE.HemisphereLight(0xffffff, 0x7f776d, 0.62));

    const key = new THREE.DirectionalLight(0xfff7ec, 2.8);
    key.position.set(2800, -3200, 3600);
    key.castShadow = shadowsEnabledRef.current;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 2;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 40000;
    scene.add(key);
    scene.add(key.target);

    const fill = new THREE.DirectionalLight(0xdce8f5, 0.42);
    fill.position.set(-3200, 2400, 1400);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.3);
    rim.position.set(-400, 2600, -3000);
    scene.add(rim);

    const content = new THREE.Group();
    scene.add(content);
    const handlesGroup = new THREE.Group();
    scene.add(handlesGroup);
    const refPlanesGroup = new THREE.Group();
    scene.add(refPlanesGroup);
    const connectorsGroup = new THREE.Group();
    scene.add(connectorsGroup);

    const grid = createInfiniteGrid();
    const gridMaterial = grid.material as THREE.ShaderMaterial;
    scene.add(grid);

    const sectionCap = createSectionCap();
    scene.add(sectionCap);
    sectionCapRef.current = sectionCap;

    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ color: 0x14191d, opacity: 0.32 }),
    );
    shadowPlane.scale.setScalar(12000);
    shadowPlane.position.z = -0.25;
    shadowPlane.receiveShadow = true;
    shadowPlane.visible = shadowsEnabledRef.current;
    scene.add(shadowPlane);

    const resize = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderDirtyRef.current = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const detachInteractions = attachViewerInteractions({
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
    });

    const animStartPos = new THREE.Vector3();
    const animEndPos = new THREE.Vector3();
    const animStartTarget = new THREE.Vector3();
    const animEndTarget = new THREE.Vector3();
    let animProgress = 1;
    let lastFrameTime = performance.now();

    const viewCube = setupViewCube({
      cubeHost: cubeHostRef.current,
      camera,
      modelRef,
      setViewRef,
      onTransitionTo: (targetPos, targetLook) => {
        animStartPos.copy(camera.position);
        animEndPos.copy(targetPos);
        animStartTarget.copy(controls.target);
        animEndTarget.copy(targetLook);
        animProgress = 0;
        lastFrameTime = performance.now();
      },
    });

    let frame = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (!Number.isFinite(now)) now = performance.now();

      if (animProgress < 1) {
        const elapsed = Math.max(0, now - lastFrameTime);
        lastFrameTime = now;
        animProgress = Math.min(1, animProgress + elapsed / 600);
        const step = animProgress - 1;
        const ease = step * step * step * step * step + 1;
        camera.position.lerpVectors(animStartPos, animEndPos, ease);
        controls.target.lerpVectors(animStartTarget, animEndTarget, ease);
        controls.update();
        renderDirtyRef.current = true;
      }

      if (turntableRef.current) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.35;
      } else {
        controls.autoRotate = false;
      }

      const fitTarget = explodeFitRef.current;
      if (fitTarget) {
        camera.position.lerp(fitTarget.pos, 0.12);
        controls.target.lerp(fitTarget.look, 0.12);
        if (camera.position.distanceTo(fitTarget.pos) < 0.5) explodeFitRef.current = null;
        renderDirtyRef.current = true;
      }

      controls.update();
      if (showDimensionsRef.current) {
        const current = modelRef.current;
        if (current?.bounds) {
          const midX = (current.bounds.min.x + current.bounds.max.x) / 2;
          const midY = (current.bounds.min.y + current.bounds.max.y) / 2;
          const midZ = (current.bounds.min.z + current.bounds.max.z) / 2;
          const quadrant =
            `${camera.position.x >= midX ? 1 : 0}` +
            `${camera.position.y >= midY ? 1 : 0}` +
            `${camera.position.z >= midZ ? 1 : 0}`;
          if (quadrant !== dimViewRef.current) {
            dimViewRef.current = quadrant;
            setDimView(quadrant);
          }
        }
      }
      if (renderDirtyRef.current) {
        renderDirtyRef.current = false;
        gridMaterial.uniforms.uCamera.value.copy(camera.position);
        renderer.render(scene, camera);
        if (statsEl) {
          statsEl.textContent = `${renderer.info.render.calls} calls · ${Math.round(
            renderer.info.render.triangles / 1000,
          )}k tris`;
        }
      }
      positionNotePins();
      viewCube.render(camera, controls);
    };
    tick(performance.now());

    stateRef.current = {
      renderer,
      scene,
      camera,
      controls,
      content,
      handlesGroup,
      grid,
      refPlanesGroup,
      connectorsGroup,
      key,
      shadowPlane,
      disposables: [],
    };

    onCaptureReadyRef.current?.(() =>
      captureViewerThumbnail(stateRef.current, modelRef.current, () => {
        renderDirtyRef.current = true;
      }),
    );

    const partCache = partCacheRef.current;

    return () => {
      onCaptureReadyRef.current?.(null);
      cancelAnimationFrame(frame);
      observer.disconnect();
      detachInteractions();
      viewCube.dispose();
      controls.dispose();
      grid.geometry.dispose();
      gridMaterial.dispose();
      renderer.dispose();
      environment.dispose();
      shadowPlane.geometry.dispose();
      (shadowPlane.material as THREE.Material).dispose();
      scene.remove(sectionCap);
      sectionCap.geometry.dispose();
      (sectionCap.material as THREE.Material).dispose();
      sectionCapRef.current = null;
      for (const entry of partCache.values()) {
        for (const item of entry.disposables) item.dispose();
      }
      partCache.clear();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      if (statsEl && statsEl.parentElement === host) host.removeChild(statsEl);
      stateRef.current = null;
    };
  }, [positionNotePins]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    state.scene.background = new THREE.Color(theme === "dark" ? 0x191e22 : 0xece9e2);
    renderDirtyRef.current = true;
  }, [theme]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    state.renderer.shadowMap.enabled = shadowsEnabled;
    state.key.castShadow = shadowsEnabled;
    state.shadowPlane.visible = shadowsEnabled;
    state.renderer.shadowMap.needsUpdate = true;
    renderDirtyRef.current = true;
    state.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material;
      if (Array.isArray(material)) {
        material.forEach((item) => {
          item.needsUpdate = true;
        });
      } else if (material) {
        material.needsUpdate = true;
      }
    });
  }, [shadowsEnabled]);

  const setView = useCallback((direction: ViewDirection) => {
    const state = stateRef.current;
    const current = modelRef.current;
    if (!state || !current?.bounds) return;

    const { pos, center, distance } = computeCameraPreset(
      current.bounds,
      state.camera.fov,
      direction,
    );
    state.camera.position.copy(pos);
    state.camera.near = Math.max(1, distance / 400);
    state.camera.far = distance * 12;
    state.camera.updateProjectionMatrix();
    state.controls.target.copy(center);
    state.controls.update();
    renderDirtyRef.current = true;
  }, []);

  useEffect(() => {
    setViewRef.current = setView;
  }, [setView]);

  const fit = useCallback(() => {
    setView("iso");
  }, [setView]);

  // Incremental part mesh & style cache.
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
    const partsToRender = model.parts;
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
    const styleOf = (part: ResolvedPart, ghost = false) => {
      const isClearance =
        part.id.toLowerCase().includes("clearance") ||
        part.name.toLowerCase().includes("clearance");
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
    };

    const applyStyle = (entry: PartCacheEntry, style: ReturnType<typeof styleOf>) => {
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
        edgeMaterial.transparent = true;
      } else if (style.isHovered) {
        edgeMaterial.color.setHex(0x4f9dff);
        edgeMaterial.opacity = 0.85;
        edgeMaterial.transparent = true;
      } else if (style.isGhost) {
        edgeMaterial.color.setHex(0x8a9199);
        edgeMaterial.opacity = 0.12;
        edgeMaterial.transparent = true;
      } else if (style.hasIssue) {
        edgeMaterial.color.setHex(0xcf222e);
        edgeMaterial.opacity = 0.9;
        edgeMaterial.transparent = true;
      } else if (style.isAffected) {
        edgeMaterial.color.setHex(0xd28a00);
        edgeMaterial.opacity = 0.85;
        edgeMaterial.transparent = true;
      } else if (style.isAnimating) {
        edgeMaterial.color.setHex(0x2f7d5b);
        edgeMaterial.opacity = 0.95;
        edgeMaterial.transparent = true;
      } else if (style.isClearance) {
        edgeMaterial.color.setHex(0xd8a53a);
        edgeMaterial.opacity = 0.55;
        edgeMaterial.transparent = true;
      } else if (style.isTransparent) {
        edgeMaterial.color.setHex(0x30373b);
        edgeMaterial.opacity = 0.2;
        edgeMaterial.transparent = true;
      } else {
        edgeMaterial.color.setHex(theme === "dark" ? 0xc4ccd1 : 0x252c31);
        edgeMaterial.opacity = 0.54;
        edgeMaterial.transparent = true;
      }

      if (entry.silhouette) {
        const silhouetteMaterial = entry.silhouette.material as THREE.ShaderMaterial;
        entry.silhouette.visible = !style.isTransparent && !style.isGhost;
        silhouetteMaterial.uniforms.outlineColor.value.setHex(
          theme === "dark" ? 0xc4ccd1 : 0x171d21,
        );
        silhouetteMaterial.uniforms.outlineOpacity.value = style.isSelected ? 0.55 : 0.34;
      }

      for (const child of entry.group.children) {
        if (child instanceof THREE.Mesh && child !== entry.silhouette) {
          child.castShadow = !style.isTransparent && !style.isGhost;
        }
      }
    };

    const buildEntry = (
      part: ResolvedPart,
      geometryKey: string,
      styleKey: string,
      built: BuiltPartGeometry,
      ghost = false,
    ): PartCacheEntry => {
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
            outlineColor: {
              value: new THREE.Color(themeRef.current === "dark" ? 0xc4ccd1 : 0x171d21),
            },
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

        const clone = new THREE.LineSegments(edgeGeometry, edgeMaterial);
        clone.userData = { partId: part.id };
        group.add(clone);

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

      state.content.add(group);
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
      applyStyle(entry, styleOf(part, ghost));
      return entry;
    };

    let styleChanged = false;
    const pending: { part: ResolvedPart; geometryKey: string; styleKey: string; ghost: boolean }[] =
      [];

    for (const [index, part] of partsToRender.entries()) {
      if (hiddenPartIds.includes(part.id)) continue;
      const ghost = visiblePartCount > 0 && index >= limitParts;

      const isClearance =
        part.id.toLowerCase().includes("clearance") ||
        part.name.toLowerCase().includes("clearance");
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
      const style = styleOf(part, ghost);
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
          applyStyle(existing, style);
          existing.styleKey = styleKey;
          styleChanged = true;
        }
        continue;
      }

      if (existing) dropEntry(existing);
      pending.push({ part, geometryKey, styleKey, ghost });
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
        const { part, geometryKey, styleKey, ghost } = pending[cursor];
        cursor += 1;
        inFlight += 1;

        void buildPartGeometryAsync(part, previewQuality)
          .then((built) => {
            if (cancelled) {
              built.geometry.dispose();
              built.edges.dispose();
              return;
            }

            partCache.set(part.id, buildEntry(part, geometryKey, styleKey, built, ghost));
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

  // Explode: push each part away from the model centre.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const bounds = model?.bounds;
    const amount = explode / 100;
    const center = bounds
      ? new THREE.Vector3(
          (bounds.min.x + bounds.max.x) / 2,
          (bounds.min.y + bounds.max.y) / 2,
          (bounds.min.z + bounds.max.z) / 2,
        )
      : new THREE.Vector3();
    const extent = bounds ? Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 1) : 1;

    for (const child of state.content.children) {
      if (amount <= 0.001) {
        child.position.set(0, 0, 0);
        continue;
      }
      let direction = explodeDirsRef.current.get(child);
      if (!direction) {
        const box = new THREE.Box3().setFromObject(child);
        const partCenter = box.isEmpty() ? center.clone() : box.getCenter(new THREE.Vector3());
        direction = partCenter.sub(center);
        if (direction.lengthSq() < 1e-6) direction.set(0, 0, 1);
        direction.normalize();
        explodeDirsRef.current.set(child, direction);
      }
      child.position.copy(direction).multiplyScalar(extent * 0.55 * amount);
    }

    state.renderer.shadowMap.needsUpdate = true;
    renderDirtyRef.current = true;

    if (bounds) {
      const box = new THREE.Box3().setFromObject(state.content);
      if (!box.isEmpty()) {
        const boxCenter = box.getCenter(new THREE.Vector3());
        const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 120);
        const direction = state.camera.position.clone().sub(state.controls.target);
        if (direction.lengthSq() < 1e-6) direction.set(1, -1, 0.8);
        direction.normalize();
        const distance = (radius / Math.sin((state.camera.fov * Math.PI) / 360)) * 1.15;
        explodeFitRef.current = {
          pos: boxCenter.clone().addScaledVector(direction, distance),
          look: boxCenter,
        };
      }
    }
  }, [explode, model]);

  // Overall dimensions drawn next to the model.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    if (dimensionsRef.current) {
      state.scene.remove(dimensionsRef.current);
      dimensionsRef.current.traverse((object) => {
        const line = object as THREE.Line;
        if (line.geometry) line.geometry.dispose();
      });
      dimensionsRef.current = null;
    }

    if (!showDimensions || !model?.bounds) {
      renderDirtyRef.current = true;
      return;
    }

    const group = buildDimensionsGroup(model.bounds, state.camera, units, formatNumber);
    state.scene.add(group);
    dimensionsRef.current = group;
    renderDirtyRef.current = true;
  }, [showDimensions, model, units, dimView, formatNumber]);

  // Ghost outlines for cuts skipped on thin prisms in Revit.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    if (ghostCutsRef.current) {
      state.scene.remove(ghostCutsRef.current);
      ghostCutsRef.current.traverse((object) => {
        const line = object as THREE.LineSegments;
        if (line.geometry) line.geometry.dispose();
      });
      ghostCutsRef.current = null;
    }

    if (!model || skippedCutPartIds.length === 0) {
      renderDirtyRef.current = true;
      return;
    }

    const group = buildGhostCutsGroup(model, skippedCutPartIds);
    state.scene.add(group);
    ghostCutsRef.current = group;
    renderDirtyRef.current = true;
  }, [model, skippedCutPartIds]);

  // Esc clears the selection when the measuring tool is not active.
  useEffect(() => {
    if (measuring) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHoveredPartId(null);
      setHoverInfo(null);
      setPickedPartIds([]);
      pickedPartIdsRef.current = [];
      setNoteComposer(null);
      onSelectPartRef.current?.(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [measuring]);

  // Zoom the camera to a part when clicked in the parameter/issues list.
  useEffect(() => {
    const state = stateRef.current;
    if (!state || !focusPartId) return;

    const group = state.content.children.find((child) => child.name === focusPartId);
    if (!group) return;

    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 120);
    const distance = (radius / Math.sin((state.camera.fov * Math.PI) / 360)) * 1.7;

    state.camera.position
      .copy(center)
      .add(new THREE.Vector3(0.55, -0.75, 0.45).normalize().multiplyScalar(distance));
    state.camera.near = Math.max(1, distance / 400);
    state.camera.far = distance * 12;
    state.camera.updateProjectionMatrix();
    state.controls.target.copy(center);
    state.controls.update();
    renderDirtyRef.current = true;
  }, [focusPartId]);

  // Zoom to the exact pinned point when a note is opened from the notes panel.
  useEffect(() => {
    const state = stateRef.current;
    if (!state || !focusNote) return;
    const point = new THREE.Vector3(focusNote.point.x, focusNote.point.y, focusNote.point.z);
    const bounds = modelRef.current?.bounds;
    const extent = bounds
      ? Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 300)
      : 1200;
    const distance = Math.max(280, extent * 0.34);
    state.camera.position
      .copy(point)
      .add(new THREE.Vector3(0.55, -0.75, 0.45).normalize().multiplyScalar(distance));
    state.camera.near = Math.max(1, distance / 500);
    state.camera.far = distance * 15;
    state.camera.updateProjectionMatrix();
    state.controls.target.copy(point);
    state.controls.update();
    renderDirtyRef.current = true;
  }, [focusNote]);

  // Section box clipping plane, outline, handle grip, and stencil cap.
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
        previousPlane.traverse((child) => {
          const mesh = child as THREE.Mesh;
          mesh.geometry?.dispose();
          const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(material)) material.forEach((item) => item.dispose());
          else material?.dispose();
          if ((child as THREE.Sprite).isSprite) {
            (child as THREE.Sprite).material.map?.dispose();
          }
        });
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

    let normal: THREE.Vector3 | null = null;
    let planePoint: THREE.Vector3 | null = null;

    const customRange = sectionCustom
      ? Math.abs(sectionCustom.normal.x) * size.x +
        Math.abs(sectionCustom.normal.y) * size.y +
        Math.abs(sectionCustom.normal.z) * size.z
      : extent;

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
      handle = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
      );
      handle.renderOrder = 1000;
      group.add(handle);
      sectionArrowRef.current = handle;
    }

    handle.scale.set(handleHeight * (256 / 96), handleHeight, 1);
    handle.position.copy(handlePoint);

    let handleLabel = sectionHandleLabelRef.current;
    if (!handleLabel) {
      const labelCanvas = document.createElement("canvas");
      labelCanvas.width = 256;
      labelCanvas.height = 72;
      const labelTexture = new THREE.CanvasTexture(labelCanvas);
      labelTexture.anisotropy = 4;
      handleLabel = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthTest: false }),
      );
      handleLabel.renderOrder = 1001;
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

    const labelMaterial = handleLabel.material as THREE.SpriteMaterial;
    const labelCanvas = labelMaterial.map?.image as HTMLCanvasElement | undefined;
    const labelContext = labelCanvas?.getContext("2d");
    if (labelContext && handleLabel.userData.text !== labelText) {
      handleLabel.userData.text = labelText;
      labelContext.clearRect(0, 0, 256, 72);
      labelContext.beginPath();
      labelContext.roundRect(4, 4, 248, 64, 18);
      labelContext.fillStyle = "rgba(255,255,255,0.95)";
      labelContext.fill();
      labelContext.strokeStyle = "#2f6feb";
      labelContext.lineWidth = 3;
      labelContext.stroke();
      labelContext.fillStyle = "#1f2328";
      labelContext.font = "bold 26px 'Segoe UI', Arial, sans-serif";
      labelContext.textAlign = "center";
      labelContext.textBaseline = "middle";
      labelContext.fillText(labelText, 128, 37);
      if (labelMaterial.map) labelMaterial.map.needsUpdate = true;
    }

    const sectionLabelHeight = Math.max(extent * 0.035, 30);
    handleLabel.scale.set(sectionLabelHeight * (256 / 72), sectionLabelHeight, 1);
    handleLabel.position.copy(handlePoint).add(new THREE.Vector3(0, 0, handleHeight * 1.15));

    const cap = sectionCapRef.current;
    const canCap = model.parts.length < 200;
    const active = sectionFill && canCap;
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

    const dragOrigin =
      sectionAxis === "custom" && sectionCustom ? sectionCustom.base.clone() : center.clone();
    const dragRange =
      sectionAxis === "custom" ? customRange : Math.max(max[sectionAxis] - min[sectionAxis], 1);
    sectionDragDataRef.current = {
      origin: dragOrigin,
      normal: normal.clone(),
      range: dragRange,
      sign: sectionAxis === "custom" ? 1 : -1,
    };

    state.renderer.shadowMap.needsUpdate = true;
    renderDirtyRef.current = true;
  }, [sectionAxis, sectionT, model, sectionCustom, sectionFill, t, formatNumber]);

  useEffect(() => {
    if (measuring) return;
    clearMeasurements();
  }, [measuring]);

  // Esc cancels the pending point, or leaves the measuring tool.
  useEffect(() => {
    if (!measuring) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (measurePointsRef.current.length > 0) {
        measurePointsRef.current = [];
        setMeasureLabel(null);
        if (measurePreviewGroupRef.current) measurePreviewGroupRef.current.visible = false;
        const marker = measureMarkersRef.current.pop();
        const state = stateRef.current;
        if (marker && state) {
          state.scene.remove(marker);
          marker.geometry.dispose();
          (marker.material as THREE.Material).dispose();
        }
        renderDirtyRef.current = true;
        return;
      }
      setMeasuring(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [measuring]);

  // Reference planes, direct-manipulation shape handles, and MEP connectors.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    for (const item of state.disposables) item.dispose();
    state.disposables = [];
    state.grid.visible = showGrid;
    renderDirtyRef.current = true;

    if (!model) {
      state.refPlanesGroup.clear();
      state.handlesGroup.clear();
      state.connectorsGroup.clear();
      return;
    }

    const size = Math.max(
      model.bounds?.size.x ?? 0,
      model.bounds?.size.y ?? 0,
      model.bounds?.size.z ?? 0,
      100,
    );
    const gridMaterial = state.grid.material as THREE.ShaderMaterial;
    gridMaterial.uniforms.uFadeStart.value = Math.max(size * 2.5, 5000);
    gridMaterial.uniforms.uFadeEnd.value = Math.max(size * 12, 22000);

    if (model.bounds) {
      const { min, max } = model.bounds;
      const center = new THREE.Vector3(
        (min.x + max.x) / 2,
        (min.y + max.y) / 2,
        (min.z + max.z) / 2,
      );
      state.shadowPlane.position.set(center.x, center.y, -0.25);
      const extent =
        Math.max(model.bounds.size.x, model.bounds.size.y, model.bounds.size.z, 600) * 1.6;
      state.key.position.set(center.x + extent * 0.7, center.y - extent, center.z + extent * 1.5);
      state.key.target.position.copy(center);
      state.key.target.updateMatrixWorld();

      const shadowCamera = state.key.shadow.camera;
      shadowCamera.left = -extent;
      shadowCamera.right = extent;
      shadowCamera.top = extent;
      shadowCamera.bottom = -extent;
      shadowCamera.near = 1;
      shadowCamera.far = extent * 6;
      shadowCamera.updateProjectionMatrix();

      state.shadowPlane.scale.setScalar(Math.max(size * 8, 6000) * 1.15);
      state.renderer.shadowMap.needsUpdate = true;
    }

    state.refPlanesGroup.clear();
    state.handlesGroup.clear();

    const selectedPart =
      selectedPartId && model ? model.parts.find((p) => p.id === selectedPartId) : null;

    if (selectedPart) {
      state.handlesGroup.visible = true;
      populatePartHandles(state, selectedPart, parameters);
    } else {
      state.handlesGroup.visible = false;
    }

    if (showPlanes && model.bounds) {
      populateRefPlanes(state, model.bounds, parameters);
    }

    state.connectorsGroup.clear();
    state.connectorsGroup.visible = Boolean(showConnectors);
    if (showConnectors) {
      populateConnectors(state, model);
    }

    if (!hasFittedRef.current) {
      fit();
      hasFittedRef.current = true;
    }
  }, [model, parameters, showGrid, showPlanes, showConnectors, selectedPartId, fit]);

  const dims = formatDimensions(model?.bounds ?? null, units);

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

  return (
    <div className="viewer">
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      <ViewerOverlays
        model={model}
        units={units}
        dims={dims}
        showGrid={showGrid}
        onToggleGrid={onToggleGrid}
        shadowsEnabled={shadowsEnabled}
        setShadowsEnabled={setShadowsEnabled}
        showPlanes={Boolean(showPlanes)}
        onTogglePlanes={onTogglePlanes}
        toolsMenuOpen={toolsMenuOpen}
        setToolsMenuOpen={setToolsMenuOpen}
        sectionAxis={sectionAxis}
        setSectionAxis={setSectionAxis}
        setSectionT={setSectionT}
        sectionCustom={sectionCustom}
        setSectionCustom={setSectionCustom}
        pickingSection={pickingSection}
        setPickingSection={setPickingSection}
        sectionFill={sectionFill}
        setSectionFill={setSectionFill}
        sectionMm={sectionMm}
        applySectionMm={applySectionMm}
        measuring={measuring}
        setMeasuring={setMeasuring}
        detailLevel={detailLevel}
        setDetailLevel={setDetailLevel}
        showConnectors={Boolean(showConnectors)}
        onToggleConnectors={onToggleConnectors}
        turntableActive={turntableActive}
        setTurntableActive={setTurntableActive}
        dimOthers={dimOthers}
        setDimOthers={setDimOthers}
        explodeOpen={explodeOpen}
        setExplodeOpen={setExplodeOpen}
        explode={explode}
        setExplode={setExplode}
        showDimensions={showDimensions}
        setShowDimensions={setShowDimensions}
        hiddenPartIds={hiddenPartIds}
        transparentPartIds={transparentPartIds}
        onToggleHidePart={onToggleHidePart}
        onUnhideAll={onUnhideAll}
        onToggleTransparentPart={onToggleTransparentPart}
        onResetTransparent={onResetTransparent}
        onSelectPart={onSelectPart}
        onSendPartsToChatRef={onSendPartsToChatRef}
        onAddNote={onAddNote}
        onFocusNoteRef={onFocusNoteRef}
        onLoadSample={onLoadSample}
        fit={fit}
        saveImage={saveImage}
        hoverInfo={hoverInfo}
        measureLabel={measureLabel}
        measureCount={measureCount}
        clearMeasurements={clearMeasurements}
        cubeHostRef={cubeHostRef}
        activeHandle={activeHandle}
        notes={notes}
        notePinRefs={notePinRefs}
        noteComposer={noteComposer}
        setNoteComposer={setNoteComposer}
        contextMenu={contextMenu}
        setContextMenu={setContextMenu}
        pickedPartIds={pickedPartIds}
        selectedPartId={selectedPartId}
        animatingPartName={animatingPartName}
        visiblePartCount={visiblePartCount}
      />
    </div>
  );
}
