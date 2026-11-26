import { useCallback, useEffect, useRef, useState } from "react";
import type { ResolvedModel } from "@family/spec-core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { formatDimensions } from "../lib/format";
import { type PreviewQuality } from "../lib/three-build";
import { useI18n } from "../lib/i18n";
import type { ModelNote } from "../lib/annotations";
import {
  buildDimensionsGroup,
  buildGhostCutsGroup,
  captureViewerThumbnail,
  computeCameraPreset,
  createInfiniteGrid,
  createSectionCap,
  populateConnectors,
  populatePartHandles,
  populateRefPlanes,
} from "./viewer/sceneHelpers";
import { setupViewCube } from "./viewer/viewCube";
import { attachViewerInteractions } from "./viewer/interactions";
import { usePartMeshes } from "./viewer/usePartMeshes";
import { useSection } from "./viewer/useSection";
import { ViewerOverlays } from "./viewer/ViewerOverlays";
import type {
  ActiveHandleState,
  ContextMenuState,
  NoteComposerState,
  PartCacheEntry,
  SceneState,
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
  fitSignal = 0,
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
  const setViewRef = useRef<(direction: ViewDirection) => void>(() => { });
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
  const lastFitSignalRef = useRef(0);
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

  const section = useSection({
    stateRef,
    partCacheRef,
    renderDirtyRef,
    model,
    t,
    formatNumber,
  });

  const [measuring, setMeasuring] = useState(false);
  const [measureLabel, setMeasureLabel] = useState<string | null>(null);
  const [measureCount, setMeasureCount] = useState(0);
  const measuringRef = useRef(false);
  measuringRef.current = measuring;
  const measurePointsRef = useRef<THREE.Vector3[]>([]);
  const measureSegmentsRef = useRef<THREE.Group[]>([]);
  const measureMarkersRef = useRef<THREE.Mesh[]>([]);
  const measurePreviewGroupRef = useRef<THREE.Group | null>(null);

  const [hoveredPartId, setHoveredPartId] = useState<string | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; name: string } | null>(null);
  const [dimOthers, setDimOthers] = useState(true);
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
  const hoverBlockedRef = useRef(false);
  hoverBlockedRef.current = measuring || section.pickingSection || section.sectionAxis !== "off";

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
    section.sectionCapRef.current = sectionCap;

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
      pickingSectionRef: section.pickingSectionRef,
      hoverBlockedRef,
      measurePointsRef,
      measureSegmentsRef,
      measureMarkersRef,
      measurePreviewGroupRef,
      sectionArrowRef: section.sectionArrowRef,
      sectionDragRef: section.sectionDragRef,
      sectionDragMovedRef: section.sectionDragMovedRef,
      sectionDragDataRef: section.sectionDragDataRef,
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
      setSectionCustom: section.setSectionCustom,
      setSectionAxis: section.setSectionAxis,
      setSectionT: section.setSectionT,
      setPickingSection: section.setPickingSection,
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
      section.sectionCapRef.current = null;
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

  usePartMeshes({
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
  });

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
      hasFittedRef.current = false;
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

    if (!hasFittedRef.current || (fitSignal > 0 && fitSignal !== lastFitSignalRef.current)) {
      fit();
      hasFittedRef.current = true;
      lastFitSignalRef.current = fitSignal;
    }
  }, [model, parameters, showGrid, showPlanes, showConnectors, selectedPartId, fit, fitSignal]);

  const dims = formatDimensions(model?.bounds ?? null, units);

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
        sectionAxis={section.sectionAxis}
        setSectionAxis={section.setSectionAxis}
        setSectionT={section.setSectionT}
        sectionCustom={section.sectionCustom}
        setSectionCustom={section.setSectionCustom}
        pickingSection={section.pickingSection}
        setPickingSection={section.setPickingSection}
        sectionFill={section.sectionFill}
        setSectionFill={section.setSectionFill}
        sectionMm={section.sectionMm}
        applySectionMm={section.applySectionMm}
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
