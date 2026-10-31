import { useCallback, useEffect, useRef, useState } from "react";
import type { FamilyParameter, MaterialDef, ResolvedModel, ResolvedPart } from "@family/spec-core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { formatDimensions, type Units } from "../lib/format";
import {
  buildPartGeometry,
  instanceEdgeGeometry,
  partColor,
  partMaterialProps,
} from "../lib/three-build";
import { buildPartGeometryAsync, type BuiltPartGeometry } from "../lib/geometry-pool";

interface PartCacheEntry {
  geometryKey: string;
  styleKey: string;
  group: THREE.Group;
  meshMaterial: THREE.MeshStandardMaterial;
  edgeMaterial: THREE.LineBasicMaterial;
  disposables: { dispose: () => void }[];
}

interface Props {
  model: ResolvedModel | null;
  parameters?: FamilyParameter[];
  materials: MaterialDef[];
  units: Units;
  showGrid: boolean;
  onToggleGrid: () => void;
  showPlanes?: boolean;
  onTogglePlanes?: () => void;
  showConnectors?: boolean;
  onToggleConnectors?: () => void;
  showHandles?: boolean;
  onToggleHandles?: () => void;
  selectedPartId?: string | null;
  onSelectPart?: (partId: string | null) => void;
  hiddenPartIds?: string[];
  onToggleHidePart?: (partId: string) => void;
  onUnhideAll?: () => void;
  transparentPartIds?: string[];
  onToggleTransparentPart?: (partId: string) => void;
  onResetTransparent?: () => void;
  issuePartIds?: string[];
  focusPartId?: string | null;
  onUpdateParameter?: (name: string, value: number) => void;
  status: { stage: string; message: string; elapsed: string | null } | null;
}

const RUN_STEPS = ["Read the brief", "Design the family", "Check the model"];

function stepIndex(stage: string): number {
  if (stage === "thinking" || stage === "reading") return 0;
  if (stage === "checking") return 2;
  if (stage === "generating" || stage === "working" || stage === "repairing") return 1;
  return 0;
}

function stepTitle(stage: string): string {
  if (stage === "thinking" || stage === "reading") return "Reading the brief";
  if (stage === "checking") return "Checking the model";
  if (stage === "repairing") return "Repairing the spec";
  return "Designing the family";
}

/**
 * Cross-section of the model bounds at a plane, ordered around the centroid.
 * Used to draw the section outline exactly where it cuts the model (Dalux style).
 */
function planeCrossSection(
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  },
  normal: THREE.Vector3,
  point: THREE.Vector3,
): THREE.Vector3[] {
  const corners: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i += 1) {
    corners.push(
      new THREE.Vector3(
        i & 1 ? bounds.max.x : bounds.min.x,
        i & 2 ? bounds.max.y : bounds.min.y,
        i & 4 ? bounds.max.z : bounds.min.z,
      ),
    );
  }
  const edges: [number, number][] = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];

  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
  const epsilon = 1e-4;
  const points: THREE.Vector3[] = [];

  for (const [a, b] of edges) {
    const da = plane.distanceToPoint(corners[a]);
    const db = plane.distanceToPoint(corners[b]);
    if (Math.abs(da) < epsilon) points.push(corners[a].clone());
    if (Math.abs(db) < epsilon) points.push(corners[b].clone());
    if (da * db < 0) {
      const t = da / (da - db);
      points.push(corners[a].clone().lerp(corners[b], t));
    }
  }

  const unique: THREE.Vector3[] = [];
  for (const candidate of points) {
    if (!unique.some((item) => item.distanceToSquared(candidate) < 1e-4)) unique.push(candidate);
  }
  if (unique.length < 3) return [];

  const centroid = unique
    .reduce((acc, item) => acc.add(item), new THREE.Vector3())
    .divideScalar(unique.length);
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(normal.x) > 0.9) u.set(0, 1, 0);
  u.crossVectors(normal, u).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();

  unique.sort((a, b) => {
    const av = a.clone().sub(centroid);
    const bv = b.clone().sub(centroid);
    return Math.atan2(v.dot(av), u.dot(av)) - Math.atan2(v.dot(bv), u.dot(bv));
  });

  return unique;
}

/**
 * Align the second measurement point to the nearest world axis (X/Y/Z) through
 * the first point when it is close enough, so distances snap to straight,
 * parallel or perpendicular runs.
 */
function snapToAxis(
  from: THREE.Vector3,
  to: THREE.Vector3,
  maxAngleDeg = 10,
): { point: THREE.Vector3; axis: "X" | "Y" | "Z" | null } {
  const delta = to.clone().sub(from);
  const length = delta.length();
  if (length < 1e-3) return { point: to.clone(), axis: null };

  const direction = delta.divideScalar(length);
  const candidates: [("X" | "Y" | "Z"), number][] = [
    ["X", Math.abs(direction.x)],
    ["Y", Math.abs(direction.y)],
    ["Z", Math.abs(direction.z)],
  ];
  candidates.sort((left, right) => right[1] - left[1]);
  const [axis, alignment] = candidates[0];
  if (alignment < Math.cos((maxAngleDeg * Math.PI) / 180)) {
    return { point: to.clone(), axis: null };
  }

  const point = from.clone();
  if (axis === "X") point.x = to.x;
  if (axis === "Y") point.y = to.y;
  if (axis === "Z") point.z = to.z;
  return { point, axis };
}

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  handlesGroup: THREE.Group;
  grid: THREE.GridHelper;
  gridSize: number;
  refPlanesGroup: THREE.Group;
  connectorsGroup: THREE.Group;
  key: THREE.DirectionalLight;
  shadowPlane: THREE.Mesh;
  disposables: (THREE.BufferGeometry | THREE.Material)[];
}

export function Viewer({
  model,
  parameters = [],
  materials,
  units,
  showGrid,
  onToggleGrid,
  showPlanes = true,
  onTogglePlanes,
  showConnectors = true,
  onToggleConnectors,
  selectedPartId,
  onSelectPart,
  hiddenPartIds = [],
  onToggleHidePart,
  onUnhideAll,
  transparentPartIds = [],
  onToggleTransparentPart,
  onResetTransparent,
  issuePartIds = [],
  focusPartId = null,
  onUpdateParameter,
  status,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cubeHostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);
  // The scene only renders when something actually changed: camera motion fires a
  // "change" event, geometry/style effects mark it dirty. Saves GPU when idle.
  const renderDirtyRef = useRef(true);
  const modelRef = useRef<ResolvedModel | null>(model);
  const onSelectPartRef = useRef(onSelectPart);
  onSelectPartRef.current = onSelectPart;
  const onUpdateParameterRef = useRef(onUpdateParameter);
  onUpdateParameterRef.current = onUpdateParameter;
  const onToggleHidePartRef = useRef(onToggleHidePart);
  onToggleHidePartRef.current = onToggleHidePart;
  const onToggleTransparentPartRef = useRef(onToggleTransparentPart);
  onToggleTransparentPartRef.current = onToggleTransparentPart;
  const onUnhideAllRef = useRef(onUnhideAll);
  onUnhideAllRef.current = onUnhideAll;
  const onResetTransparentRef = useRef(onResetTransparent);
  onResetTransparentRef.current = onResetTransparent;
  const hasFittedRef = useRef(false);
  modelRef.current = model;

  const [activeHandle, setActiveHandle] = useState<{
    label: string;
    value: number;
    screenX: number;
    screenY: number;
  } | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    partId: string;
    partName: string;
    x: number;
    y: number;
    normal: THREE.Vector3 | null;
    center: THREE.Vector3 | null;
  } | null>(null);

  const [visiblePartCount, setVisiblePartCount] = useState<number>(0);
  const prevModelRef = useRef<ResolvedModel | null>(null);
  // Rendered parts survive re-runs of the scene effect: only new or changed parts are
  // rebuilt, so the assembly animation adds meshes instead of redrawing everything.
  const partCacheRef = useRef(new Map<string, PartCacheEntry>());
  // Solid outlines never change for a given resolved part, so the expensive
  // JSON.stringify pass is cached per part object instead of running every effect.
  const shapeKeysRef = useRef(new WeakMap<ResolvedPart, string>());

  const [animatingPartName, setAnimatingPartName] = useState<string | null>(null);
  const [turntableActive, setTurntableActive] = useState<boolean>(false);
  const turntableRef = useRef<boolean>(false);
  turntableRef.current = turntableActive;

  const [shadowsEnabled, setShadowsEnabled] = useState<boolean>(true);
  const shadowsEnabledRef = useRef<boolean>(true);
  shadowsEnabledRef.current = shadowsEnabled;

  // Section (clipping plane) and measurement tools.
  const [sectionAxis, setSectionAxis] = useState<"off" | "x" | "y" | "z" | "custom">("off");
  const [sectionT, setSectionT] = useState(1);
  const [sectionCustom, setSectionCustom] = useState<{
    normal: THREE.Vector3;
    base: THREE.Vector3;
  } | null>(null);
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
  const sectionDragDataRef = useRef<{
    origin: THREE.Vector3;
    normal: THREE.Vector3;
    range: number;
    sign: number;
  } | null>(null);

  const statusRef = useRef(status);
  statusRef.current = status;

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

    // Nếu số lượng part đang tăng dần từng bước (khi Agent trực tiếp đắp part)
    if (prevParts && model.parts.length > prevParts.length) {
      prevModelRef.current = model;
      setVisiblePartCount(model.parts.length);
      const newestPart = model.parts[model.parts.length - 1];
      setAnimatingPartName(newestPart?.name || null);
      const timer = setTimeout(() => {
        setAnimatingPartName(null);
      }, 1000);
      return () => clearTimeout(timer);
    }

    const isDifferent =
      !prevParts ||
      prevParts.length !== model.parts.length ||
      model.parts.some((p, i) => prevParts[i]?.id !== p.id || prevParts[i]?.name !== p.name);

    prevModelRef.current = model;

    if (isDifferent) {
      // A finished model arrives in one go: build it up part by part instead of popping
      // the whole thing in, so the user sees it assemble. Big families step faster.
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
    } else {
      setVisiblePartCount(model.parts.length);
      setAnimatingPartName(null);
    }
  }, [model]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xecebe5, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.96;
    renderer.shadowMap.enabled = shadowsEnabledRef.current;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The shadow map only depends on geometry and the light, not on the camera:
    // refresh it when the scene changes instead of re-rendering it every frame.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    host.appendChild(renderer.domElement);

    // Opt-in draw-call HUD: open the studio with ?debug=1.
    const debugStats = new URLSearchParams(window.location.search).has("debug");
    let statsEl: HTMLDivElement | null = null;
    if (debugStats) {
      statsEl = document.createElement("div");
      statsEl.className = "viewer-stats";
      host.appendChild(statsEl);
    }

    const scene = new THREE.Scene();

    // A neutral room probe gives the metals something to reflect; without it every
    // metalness > 0 surface renders as flat grey.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = environment;
    scene.environmentIntensity = 0.5;

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

    // Tự động tắt Turntable khi người dùng chủ động tương tác/xoay/zoom bằng chuột
    controls.addEventListener("start", () => {
      if (turntableRef.current) {
        setTurntableActive(false);
      }
    });

    controls.addEventListener("change", () => {
      renderDirtyRef.current = true;
    });

    // Standard CAD / Revit mouse mapping:
    // Left click: Rotate / Orbit
    // Middle click (or Right click): Pan / Rê khung hình
    // Right click: Pan / Rotate
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };

    scene.add(new THREE.HemisphereLight(0xffffff, 0xa7a29a, 1.05));

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2800, -3200, 3600);
    key.castShadow = shadowsEnabledRef.current;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 2;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 40000;
    scene.add(key);
    scene.add(key.target);

    const fill = new THREE.DirectionalLight(0xffffff, 0.75);
    fill.position.set(-3200, 2400, 1400);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.35);
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

    const grid = new THREE.GridHelper(6000, 30, 0xcfccc4, 0xdedbd4);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.4;
    scene.add(grid);

    // Catches the key light's shadow so parts read as sitting on the floor.
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.ShadowMaterial({ color: 0x1f2328, opacity: 0.24 }),
    );
    shadowPlane.position.z = -0.25;
    shadowPlane.receiveShadow = true;
    shadowPlane.visible = shadowsEnabledRef.current;
    scene.add(shadowPlane);

    const resize = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderDirtyRef.current = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let downPos = { x: 0, y: 0 };
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

    /**
     * Snap a measurement point to a vertex, an edge or the face under the cursor.
     * Shared by the live hover preview and the click handler.
     */
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
      let kind = "mặt";

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

        // 1. Nearest vertex of the whole part. Only vertices close to the hit
        // point are projected, so large CSG meshes stay cheap.
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
            kind = "điểm góc";
          }
        }

        // 2. Otherwise snap to the closest edge of the hit triangle.
        if (kind === "mặt" && position && hit.face) {
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
            kind = "cạnh";
          }
        }
      }

      return { point, kind };
    };

    const onCanvasMouseDown = (e: MouseEvent) => {
      downPos = { x: e.clientX, y: e.clientY };
      setContextMenu(null);

      const rect = renderer.domElement.getBoundingClientRect();
      dragPointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      dragRaycaster.setFromCamera(dragPointer, camera);
      const handleHits = dragRaycaster.intersectObjects(handlesGroup.children, true);

      if (handleHits.length > 0) {
        let handleObj: THREE.Object3D | null = handleHits[0].object;
        while (handleObj && !handleObj.userData.isShapeHandle && handleObj.parent !== handlesGroup && handleObj.parent) {
          handleObj = handleObj.parent;
        }

        if (handleObj && handleObj.userData.isShapeHandle) {
          e.stopPropagation();
          controls.enabled = false;

          const axis = handleObj.userData.axis as "x" | "y" | "z";
          const dir = handleObj.userData.dir as number;
          const paramName = handleObj.userData.paramName as string;
          const initialVal = handleObj.userData.currentVal as number;

          // Drag plane perpendicular to camera direction
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
          const sx = ((screenPos.x + 1) / 2) * rect.width;
          const sy = ((-screenPos.y + 1) / 2) * rect.height;
          setActiveHandle({
            label: paramName,
            value: Math.round(initialVal),
            screenX: sx,
            screenY: sy,
          });
          return;
        }
      }
    };

    const onCanvasMouseMove = (e: MouseEvent) => {
      if (!draggingHandle) {
        if (sectionDragRef.current) return;
        // Hover cursor check
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

        // Project delta onto handle axis
        const axisDelta = deltaWorld.dot(axisVector) * draggingHandle.dir;
        
        // Multiplier: if dimension is centered (like origin centered bounding box), delta is 2x for full width
        const deltaMultiplier = 2;
        const rawNewVal = draggingHandle.initialVal + axisDelta * deltaMultiplier;
        // Snap to nearest 10mm (Revit style snap)
        const snapped = Math.max(50, Math.round(rawNewVal / 10) * 10);

        const screenPos = draggingHandle.arrow.position.clone().project(camera);
        const sx = ((screenPos.x + 1) / 2) * rect.width;
        const sy = ((-screenPos.y + 1) / 2) * rect.height;

        setActiveHandle({
          label: draggingHandle.paramName,
          value: snapped,
          screenX: sx,
          screenY: sy,
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

      // Dimension arrowheads at both ends, pointing outward.
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
        ctx.fillText(`${Math.round(length)} mm`, 128, 37);
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

    // Dalux-style live preview while measuring: hover dot plus rubber-band line.
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

      // Snapping scans vertices, so recompute only when the cursor really moved.
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
      const kindLabel =
        picked.kind === "điểm góc" ? "Góc" : picked.kind === "cạnh" ? "Cạnh" : "Mặt";
      if (points.length === 0) {
        // Snap target chip: tells you what will be picked before clicking.
        previewLine.visible = false;
        previewLabel.visible = true;
        previewLabel.scale.set(labelHeight * (256 / 72), labelHeight, 1);
        previewLabel.position
          .copy(picked.point)
          .add(new THREE.Vector3(0, 0, labelHeight * 0.9));
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
      previewLabel.position.copy(previewLine.position).add(new THREE.Vector3(0, 0, labelHeight * 0.8));
      drawPreviewLabel(
        `${constrained.axis ? `Trục ${constrained.axis} · ` : ""}${Math.round(length)} mm`,
      );

      renderDirtyRef.current = true;
    };

    const onCanvasClick = (e: MouseEvent) => {
      // Ignore the click that ends a section-arrow drag.
      if (sectionDragMovedRef.current) {
        sectionDragMovedRef.current = false;
        return;
      }
      // Ignore if user was dragging / orbiting
      const dx = Math.abs(e.clientX - downPos.x);
      const dy = Math.abs(e.clientY - downPos.y);
      if (dx > 4 || dy > 4) return;

      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );

      const mainRaycaster = new THREE.Raycaster();
      mainRaycaster.setFromCamera(pointer, camera);

      if (pickingSectionRef.current) {
        const meshHits = mainRaycaster
          .intersectObjects(content.children, true)
          .filter((entry) => (entry.object as THREE.Mesh).isMesh);
        const hit = meshHits[0];
        if (hit?.face) {
          const mesh = hit.object as THREE.Mesh;
          // Face normals point outward; flip so the interior side is kept and the
          // camera side is cut away.
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
        const rect = renderer.domElement.getBoundingClientRect();
        const picked = pickMeasurePoint(
          mainRaycaster,
          e.clientX - rect.left,
          e.clientY - rect.top,
        );
        if (picked) {
          const { kind: snapKind } = picked;
          const points = measurePointsRef.current;
          const constrained =
            points.length === 1 ? snapToAxis(points[0], picked.point) : null;
          const point = constrained ? constrained.point : picked.point;

          const bounds = modelRef.current?.bounds;
          const modelExtent = bounds
            ? Math.max(bounds.size.x, bounds.size.y, bounds.size.z)
            : 0;

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
            setMeasureLabel(`Điểm 1 (bắt ${snapKind}) · bấm điểm thứ hai (Esc để huỷ)`);
          } else {
            const a = points[0];
            const distance = a.distanceTo(point);
            points.length = 0;
            addMeasurement(a, point, modelExtent);
            hideMeasurePreview();
            setMeasureLabel(
              `${Math.round(distance)} mm · bắt ${snapKind}${
                constrained?.axis ? ` · trục ${constrained.axis}` : ""
              }`,
            );
          }
          renderDirtyRef.current = true;
        }
        return;
      }

      // Check handle click first
      const handleHits = mainRaycaster.intersectObjects(handlesGroup.children, true);
      if (handleHits.length > 0) return;

      const intersects = mainRaycaster.intersectObjects(content.children, true);

      if (intersects.length > 0) {
        let currentObj: THREE.Object3D | null = intersects[0].object;
        while (currentObj && !currentObj.userData.partId && currentObj.parent !== content && currentObj.parent) {
          currentObj = currentObj.parent;
        }
        const hitId = currentObj?.userData.partId || null;
        onSelectPartRef.current?.(hitId);
      } else {
        onSelectPartRef.current?.(null);
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      // Prevent browser right-click menu
      e.preventDefault();

      // If user dragged with right mouse button (pan), don't show context menu
      const dx = Math.abs(e.clientX - downPos.x);
      const dy = Math.abs(e.clientY - downPos.y);
      if (dx > 4 || dy > 4) {
        return;
      }

      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );

      const hitRaycaster = new THREE.Raycaster();
      hitRaycaster.setFromCamera(pointer, camera);

      const intersects = hitRaycaster.intersectObjects(content.children, true);
      if (intersects.length > 0) {
        const hit = intersects[0];
        let currentObj: THREE.Object3D | null = hit.object;
        while (currentObj && !currentObj.userData.partId && currentObj.parent !== content && currentObj.parent) {
          currentObj = currentObj.parent;
        }
        const hitId = currentObj?.userData.partId || null;
        if (hitId) {
          const partDef = modelRef.current?.parts.find((p) => p.id === hitId);
          const partName = partDef?.name || hitId;

          // Section placed from this click: plane normal follows the clicked face and
          // is flipped to face away from the camera, so the near half gets cut.
          const normal: THREE.Vector3 = hit.face
            ? hit.face.normal
                .clone()
                .transformDirection((hit.object as THREE.Mesh).matrixWorld)
                .normalize()
                .negate()
            : camera.getWorldDirection(new THREE.Vector3());

          // Cut through the middle of the part so it is visibly sliced, not flush
          // with the surface that was clicked.
          let center: THREE.Vector3 | null = null;
          if (currentObj) {
            const box = new THREE.Box3().setFromObject(currentObj);
            if (!box.isEmpty()) center = box.getCenter(new THREE.Vector3());
          }
          if (!center) center = hit.point.clone();

          onSelectPartRef.current?.(hitId);
          setContextMenu({
            partId: hitId,
            partName,
            x: e.clientX,
            y: e.clientY,
            normal,
            center,
          });
          return;
        }
      }

      setContextMenu(null);
    };

    renderer.domElement.addEventListener("contextmenu", onContextMenu);
    renderer.domElement.addEventListener("mousedown", onCanvasMouseDown);
    window.addEventListener("mousemove", onCanvasMouseMove);
    window.addEventListener("mouseup", onCanvasMouseUp);
    renderer.domElement.addEventListener("click", onCanvasClick);

    // Section plane drag handle: grab the red arrow and drag it along the normal.
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

      // Capture phase: stop OrbitControls from starting a rotation.
      e.stopPropagation();
      e.preventDefault();
      sectionDragRef.current = true;
      controls.enabled = false;
      renderer.domElement.style.cursor = "grabbing";
    };

    const onSectionPointerMove = (e: PointerEvent) => {
      const data = sectionDragDataRef.current;

      if (!sectionDragRef.current) return;

      if (!data) return;
      readSectionPointer(e);
      sectionRay.setFromCamera(sectionPointer, camera);

      const span = data.range * 2;
      const start = data.origin.clone().addScaledVector(data.normal, -span);
      const end = data.origin.clone().addScaledVector(data.normal, span);
      const hitPoint = new THREE.Vector3();
      sectionRay.ray.distanceSqToSegment(start, end, undefined, hitPoint);
      const offset = hitPoint.sub(data.origin).dot(data.normal);
      const next = Math.min(1, Math.max(0, 0.5 + (data.sign * offset) / data.range));
      setSectionT(next);
    };

    const onSectionPointerUp = () => {
      if (!sectionDragRef.current) return;
      sectionDragRef.current = false;
      sectionDragMovedRef.current = true;
      controls.enabled = true;
      renderer.domElement.style.cursor = "";
    };

    renderer.domElement.addEventListener("pointerdown", onSectionPointerDown, true);
    window.addEventListener("pointermove", onSectionPointerMove);
    window.addEventListener("pointerup", onSectionPointerUp);

    let frame = 0;

    // ViewCube Setup
    const cubeHost = cubeHostRef.current;
    let cubeRenderer: THREE.WebGLRenderer | null = null;
    let cubeScene: THREE.Scene | null = null;
    let cubeCamera: THREE.PerspectiveCamera | null = null;
    let cubeMesh: THREE.Mesh | null = null;
    let faceHighlightMesh: THREE.Mesh | null = null;
    let cornerHighlightMesh: THREE.Mesh | null = null;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // Camera animation state for smooth Revit transition
    const animStartPos = new THREE.Vector3();
    const animEndPos = new THREE.Vector3();
    const animStartTarget = new THREE.Vector3();
    const animEndTarget = new THREE.Vector3();
    let animProgress = 1; // 1 = done

    const createCubeMaterial = (text: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d")!;

      // Neutral matte gray background like Revit ViewCube
      ctx.fillStyle = "#d6d9dc";
      ctx.fillRect(0, 0, 256, 256);

      // Subtle top/left light bevel
      ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(2, 254);
      ctx.lineTo(2, 2);
      ctx.lineTo(254, 2);
      ctx.stroke();

      // Clean Revit border
      ctx.strokeStyle = "#aeb3b7";
      ctx.lineWidth = 3;
      ctx.strokeRect(1, 1, 254, 254);

      // Revit typography: italic sans-serif bold, subtle dark ink
      ctx.fillStyle = "#4d545a";
      ctx.font = "italic bold 44px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 128, 128);

      const texture = new THREE.CanvasTexture(canvas);
      texture.anisotropy = 4;
      return new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.55,
        metalness: 0.1,
      });
    };

    if (cubeHost) {
      cubeRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      cubeRenderer.setSize(110, 110);
      cubeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      cubeRenderer.setClearColor(0x000000, 0); // 100% transparent background
      cubeHost.appendChild(cubeRenderer.domElement);

      cubeScene = new THREE.Scene();
      cubeScene.add(new THREE.AmbientLight(0xffffff, 1.4));
      const cubeLight = new THREE.DirectionalLight(0xffffff, 1.2);
      cubeLight.position.set(4, -5, 6);
      cubeScene.add(cubeLight);

      // Camera FOV 42 with distance 6.2 ensures large ring and cube never get clipped
      cubeCamera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
      cubeCamera.up.set(0, 0, 1);

      // Face order in BoxGeometry: +X (Right), -X (Left), +Y (Back), -Y (Front), +Z (Top), -Z (Bottom)
      const materials = [
        createCubeMaterial("RIGHT"),
        createCubeMaterial("LEFT"),
        createCubeMaterial("BACK"),
        createCubeMaterial("FRONT"),
        createCubeMaterial("TOP"),
        createCubeMaterial("BOTTOM"),
      ];

      const geometry = new THREE.BoxGeometry(2, 2, 2);
      cubeMesh = new THREE.Mesh(geometry, materials);
      cubeScene.add(cubeMesh);

      // Add crisp edges to the cube
      const cubeEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0xa3a8ac, linewidth: 1 })
      );
      cubeScene.add(cubeEdges);

      // Revit blue face highlight overlay (shows on click/hover face)
      const faceHighlightGeom = new THREE.PlaneGeometry(1.65, 1.65);
      const faceHighlightMat = new THREE.MeshBasicMaterial({
        color: 0x50a6ff,
        transparent: true,
        opacity: 0.45,
        depthTest: false,
      });
      faceHighlightMesh = new THREE.Mesh(faceHighlightGeom, faceHighlightMat);
      faceHighlightMesh.visible = false;
      faceHighlightMesh.renderOrder = 999;
      cubeScene.add(faceHighlightMesh);

      // Revit corner highlight overlay (shows on click corner)
      const cornerHighlightGeom = new THREE.BoxGeometry(0.55, 0.55, 0.55);
      const cornerHighlightMat = new THREE.MeshBasicMaterial({
        color: 0x50a6ff,
        transparent: true,
        opacity: 0.55,
        depthTest: false,
      });
      cornerHighlightMesh = new THREE.Mesh(cornerHighlightGeom, cornerHighlightMat);
      cornerHighlightMesh.visible = false;
      cornerHighlightMesh.renderOrder = 999;
      cubeScene.add(cornerHighlightMesh);

      // Compass Ring with S, E, N, W (Z is UP, X is Right, Y is Front(-Y)/Back(+Y))
      const compassCanvas = document.createElement("canvas");
      compassCanvas.width = 512;
      compassCanvas.height = 512;
      const cCtx = compassCanvas.getContext("2d")!;
      cCtx.clearRect(0, 0, 512, 512);

      // Outer ring band (larger ring around the cube as in Revit)
      cCtx.beginPath();
      cCtx.arc(256, 256, 222, 0, Math.PI * 2);
      cCtx.lineWidth = 30;
      cCtx.strokeStyle = "rgba(70, 76, 82, 0.68)";
      cCtx.stroke();

      // Inner ring thin contour
      cCtx.beginPath();
      cCtx.arc(256, 256, 198, 0, Math.PI * 2);
      cCtx.lineWidth = 1.5;
      cCtx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      cCtx.stroke();

      // Cardinal direction letters (N, S, E, W) - crisp light gray
      cCtx.shadowColor = "rgba(0, 0, 0, 0.28)";
      cCtx.shadowBlur = 4;
      cCtx.fillStyle = "#ffffff";
      cCtx.font = "bold 44px 'Segoe UI', Arial, sans-serif";
      cCtx.textAlign = "center";
      cCtx.textBaseline = "middle";

      // N is towards +Y (top of canvas)
      cCtx.fillText("N", 256, 256 - 222);
      // S is towards -Y (bottom of canvas)
      cCtx.fillText("S", 256, 256 + 222);
      // E is towards +X (right of canvas)
      cCtx.fillText("E", 256 + 222, 256);
      // W is towards -X (left of canvas)
      cCtx.fillText("W", 256 - 222, 256);

      const compassTexture = new THREE.CanvasTexture(compassCanvas);
      compassTexture.anisotropy = 4;
      // Larger diameter compass plane (4.3 vs 3.6)
      const compassGeom = new THREE.PlaneGeometry(4.3, 4.3);
      const compassMat = new THREE.MeshBasicMaterial({
        map: compassTexture,
        transparent: true,
        side: THREE.DoubleSide,
      });
      const compassMesh = new THREE.Mesh(compassGeom, compassMat);
      compassMesh.position.z = -1.02;
      cubeScene.add(compassMesh);

      // 8 Interactive Corners for ISO/Perspective views
      const cornerGeom = new THREE.BoxGeometry(0.5, 0.5, 0.5);
      const cornerMat = new THREE.MeshBasicMaterial({
        color: 0x9fbcd1,
        transparent: true,
        opacity: 0.01, // Invisible click targets normally, highlight mesh appears on click
      });

      const corners: { mesh: THREE.Mesh; view: "tfr" | "tfl" | "tbr" | "tbl" | "bfr" | "bfl" | "bbr" | "bbl" }[] = [
        { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "tfr" },
        { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "tfl" },
        { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "tbr" },
        { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "tbl" },
        { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "bfr" },
        { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "bfl" },
        { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "bbr" },
        { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "bbl" },
      ];

      // Set positions for all 8 corners
      corners[0].mesh.position.set(0.78, -0.78, 0.78); // Top-Front-Right (+X, -Y, +Z)
      corners[1].mesh.position.set(-0.78, -0.78, 0.78); // Top-Front-Left (-X, -Y, +Z)
      corners[2].mesh.position.set(0.78, 0.78, 0.78); // Top-Back-Right (+X, +Y, +Z)
      corners[3].mesh.position.set(-0.78, 0.78, 0.78); // Top-Back-Left (-X, +Y, +Z)
      corners[4].mesh.position.set(0.78, -0.78, -0.78); // Bottom-Front-Right (+X, -Y, -Z)
      corners[5].mesh.position.set(-0.78, -0.78, -0.78); // Bottom-Front-Left (-X, -Y, -Z)
      corners[6].mesh.position.set(0.78, 0.78, -0.78); // Bottom-Back-Right (+X, +Y, -Z)
      corners[7].mesh.position.set(-0.78, 0.78, -0.78); // Bottom-Back-Left (-X, +Y, -Z)

      for (const c of corners) {
        cubeScene.add(c.mesh);
      }

      // Smooth camera transition function
      const smoothTransitionTo = (targetPos: THREE.Vector3, targetLook: THREE.Vector3) => {
        animStartPos.copy(camera.position);
        animEndPos.copy(targetPos);
        animStartTarget.copy(controls.target);
        animEndTarget.copy(targetLook);
        animProgress = 0; // Trigger smooth animation in tick()
      };

      const calculateViewCameraPos = (direction: "top" | "front" | "back" | "left" | "right" | "iso" | "tfr" | "tfl" | "tbr" | "tbl" | "bfr" | "bfl" | "bbr" | "bbl") => {
        const current = modelRef.current;
        if (!current?.bounds) return null;
        const { min, max } = current.bounds;
        const center = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
        const radius = Math.max(
          new THREE.Vector3(max.x - min.x, max.y - min.y, max.z - min.z).length() / 2,
          120,
        );
        const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.15;
        const dCorner = distance * 0.7;

        const offset = new THREE.Vector3();
        switch (direction) {
          case "top": offset.set(0, -0.001, distance); break;
          case "front": offset.set(0, -distance, 0); break;
          case "back": offset.set(0, distance, 0); break;
          case "left": offset.set(-distance, 0, 0); break;
          case "right": offset.set(distance, 0, 0); break;
          case "tfr":
          case "iso": offset.set(dCorner, -dCorner, dCorner * 0.8); break;
          case "tfl": offset.set(-dCorner, -dCorner, dCorner * 0.8); break;
          case "tbr": offset.set(dCorner, dCorner, dCorner * 0.8); break;
          case "tbl": offset.set(-dCorner, dCorner, dCorner * 0.8); break;
          case "bfr": offset.set(dCorner, -dCorner, -dCorner * 0.5); break;
          case "bfl": offset.set(-dCorner, -dCorner, -dCorner * 0.5); break;
          case "bbr": offset.set(dCorner, dCorner, -dCorner * 0.5); break;
          case "bbl": offset.set(-dCorner, dCorner, -dCorner * 0.5); break;
          default: offset.set(distance * 0.7, -distance * 0.7, distance * 0.55); break;
        }
        return { pos: center.clone().add(offset), center };
      };

      const updateHighlightByRay = () => {
        if (!cubeCamera) return;
        raycaster.setFromCamera(mouse, cubeCamera);

        // Check corners hover
        for (const c of corners) {
          const hits = raycaster.intersectObject(c.mesh);
          if (hits.length > 0) {
            if (cornerHighlightMesh) {
              cornerHighlightMesh.position.copy(c.mesh.position);
              cornerHighlightMesh.visible = true;
            }
            if (faceHighlightMesh) faceHighlightMesh.visible = false;
            return;
          }
        }
        if (cornerHighlightMesh) cornerHighlightMesh.visible = false;

        // Check face hover
        if (cubeMesh) {
          const intersects = raycaster.intersectObject(cubeMesh);
          if (intersects.length > 0 && intersects[0].face) {
            const index = Math.floor(intersects[0].face.materialIndex);
            if (faceHighlightMesh) {
              faceHighlightMesh.position.set(0, 0, 0);
              faceHighlightMesh.rotation.set(0, 0, 0);
              if (index === 0) { // Right (+X)
                faceHighlightMesh.position.set(1.01, 0, 0);
                faceHighlightMesh.rotation.y = Math.PI / 2;
              } else if (index === 1) { // Left (-X)
                faceHighlightMesh.position.set(-1.01, 0, 0);
                faceHighlightMesh.rotation.y = -Math.PI / 2;
              } else if (index === 2) { // Back (+Y)
                faceHighlightMesh.position.set(0, 1.01, 0);
                faceHighlightMesh.rotation.x = -Math.PI / 2;
              } else if (index === 3) { // Front (-Y)
                faceHighlightMesh.position.set(0, -1.01, 0);
                faceHighlightMesh.rotation.x = Math.PI / 2;
              } else if (index === 4) { // Top (+Z)
                faceHighlightMesh.position.set(0, 0, 1.01);
              } else if (index === 5) { // Bottom (-Z)
                faceHighlightMesh.position.set(0, 0, -1.01);
                faceHighlightMesh.rotation.x = Math.PI;
              }
              faceHighlightMesh.visible = true;
            }
            return;
          }
        }
        if (faceHighlightMesh) faceHighlightMesh.visible = false;
      };

      const onCubeMouseMove = (event: MouseEvent) => {
        if (!cubeRenderer) return;
        const rect = cubeRenderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        updateHighlightByRay();
      };

      const onCubeMouseLeave = () => {
        if (faceHighlightMesh) faceHighlightMesh.visible = false;
        if (cornerHighlightMesh) cornerHighlightMesh.visible = false;
      };

      const onCubeClick = (event: MouseEvent) => {
        if (!cubeRenderer) return;
        const rect = cubeRenderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        if (cubeCamera) {
          raycaster.setFromCamera(mouse, cubeCamera);

          // Check 8 corners first
          for (const c of corners) {
            const hits = raycaster.intersectObject(c.mesh);
            if (hits.length > 0) {
              const target = calculateViewCameraPos(c.view);
              if (target) smoothTransitionTo(target.pos, target.center);
              else setView(c.view);
              return;
            }
          }

          if (cubeMesh) {
            const intersects = raycaster.intersectObject(cubeMesh);
            if (intersects.length > 0 && intersects[0].face) {
              const index = Math.floor(intersects[0].face.materialIndex);
              const viewMap: ("right" | "left" | "back" | "front" | "top" | "iso")[] = [
                "right",
                "left",
                "back",
                "front",
                "top",
                "iso",
              ];

              const target = calculateViewCameraPos(viewMap[index] || "iso");
              if (target) smoothTransitionTo(target.pos, target.center);
              else setView(viewMap[index] || "iso");
            }
          }
        }
      };

      cubeRenderer.domElement.addEventListener("mousemove", onCubeMouseMove);
      cubeRenderer.domElement.addEventListener("mouseleave", onCubeMouseLeave);
      cubeRenderer.domElement.addEventListener("click", onCubeClick);
    }

    const tick = () => {
      frame = requestAnimationFrame(tick);
      
      // Smooth camera transition when user clicks ViewCube - slower, cinematic & silky smooth (~800ms)
      if (animProgress < 1) {
        animProgress = Math.min(1, animProgress + 0.02); // 0.02 step = ~50 frames (~800ms)
        // Quintic ease-out formula for super smooth, gentle glide into position
        const t = animProgress - 1;
        const ease = t * t * t * t * t + 1;
        camera.position.lerpVectors(animStartPos, animEndPos, ease);
        controls.target.lerpVectors(animStartTarget, animEndTarget, ease);
        controls.update();
        renderDirtyRef.current = true;
      }

      // Turntable exhibition rotation when explicitly toggled by user
      if (turntableRef.current) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.35; // Gentle, cinematic exhibition turntable speed
      } else {
        controls.autoRotate = false;
      }

      controls.update();
      if (renderDirtyRef.current) {
        renderDirtyRef.current = false;
        renderer.render(scene, camera);
        if (statsEl) {
          statsEl.textContent = `${renderer.info.render.calls} calls · ${Math.round(
            renderer.info.render.triangles / 1000,
          )}k tris`;
        }
      }

      if (cubeRenderer && cubeScene && cubeCamera) {
        // Sync cube camera rotation with main scene camera
        const dir = camera.position.clone().sub(controls.target).normalize();
        cubeCamera.position.copy(dir.multiplyScalar(6.2)); // Distance 6.2 accommodates larger compass ring without clipping
        cubeCamera.lookAt(0, 0, 0);
        cubeRenderer.render(cubeScene, cubeCamera);
      }
    };
    tick();

    stateRef.current = { renderer, scene, camera, controls, content, handlesGroup, grid, gridSize: 6000, refPlanesGroup, connectorsGroup, key, shadowPlane, disposables: [] };

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      renderer.domElement.removeEventListener("mousedown", onCanvasMouseDown);
      window.removeEventListener("mousemove", onCanvasMouseMove);
      window.removeEventListener("mouseup", onCanvasMouseUp);
      renderer.domElement.removeEventListener("click", onCanvasClick);
      renderer.domElement.removeEventListener("pointerdown", onSectionPointerDown, true);
      window.removeEventListener("pointermove", onSectionPointerMove);
      window.removeEventListener("pointerup", onSectionPointerUp);
      controls.dispose();
      renderer.dispose();
      environment.dispose();
      shadowPlane.geometry.dispose();
      (shadowPlane.material as THREE.Material).dispose();
      for (const entry of partCacheRef.current.values()) {
        for (const item of entry.disposables) item.dispose();
      }
      partCacheRef.current.clear();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      if (statsEl && statsEl.parentElement === host) host.removeChild(statsEl);
      if (cubeRenderer && cubeHost && cubeRenderer.domElement.parentElement === cubeHost) {
        cubeHost.removeChild(cubeRenderer.domElement);
        cubeRenderer.dispose();
      }
      stateRef.current = null;
    };
  }, []);

  // Bật/Tắt đổ bóng: tắt shadow map của renderer + nguồn sáng và ẩn mặt phẳng hứng bóng,
  // đồng thời buộc biên dịch lại vật liệu để shader nhận cờ shadow mới.
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
      if (Array.isArray(material)) material.forEach((item) => { item.needsUpdate = true; });
      else if (material) material.needsUpdate = true;
    });
  }, [shadowsEnabled]);

  const setView = useCallback(
    (direction: "top" | "front" | "back" | "left" | "right" | "iso" | "tfr" | "tfl" | "tbr" | "tbl" | "bfr" | "bfl" | "bbr" | "bbl") => {
      const state = stateRef.current;
      const current = modelRef.current;
      if (!state || !current?.bounds) return;

      const { min, max } = current.bounds;
      const center = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
      const radius = Math.max(
        new THREE.Vector3(max.x - min.x, max.y - min.y, max.z - min.z).length() / 2,
        120,
      );
      const distance = (radius / Math.sin((state.camera.fov * Math.PI) / 360)) * 1.15;
      const dCorner = distance * 0.7;

      const offset = new THREE.Vector3();
      switch (direction) {
        case "top":
          offset.set(0, -0.001, distance);
          break;
        case "front": // -Y
          offset.set(0, -distance, 0);
          break;
        case "back": // +Y
          offset.set(0, distance, 0);
          break;
        case "left": // -X
          offset.set(-distance, 0, 0);
          break;
        case "right": // +X
          offset.set(distance, 0, 0);
          break;
        // 8 Corners of the cube
        case "tfr": // Top-Front-Right (+X, -Y, +Z)
        case "iso":
          offset.set(dCorner, -dCorner, dCorner * 0.8);
          break;
        case "tfl": // Top-Front-Left (-X, -Y, +Z)
          offset.set(-dCorner, -dCorner, dCorner * 0.8);
          break;
        case "tbr": // Top-Back-Right (+X, +Y, +Z)
          offset.set(dCorner, dCorner, dCorner * 0.8);
          break;
        case "tbl": // Top-Back-Left (-X, +Y, +Z)
          offset.set(-dCorner, dCorner, dCorner * 0.8);
          break;
        case "bfr": // Bottom-Front-Right (+X, -Y, -Z)
          offset.set(dCorner, -dCorner, -dCorner * 0.5);
          break;
        case "bfl": // Bottom-Front-Left (-X, -Y, -Z)
          offset.set(-dCorner, -dCorner, -dCorner * 0.5);
          break;
        case "bbr": // Bottom-Back-Right (+X, +Y, -Z)
          offset.set(dCorner, dCorner, -dCorner * 0.5);
          break;
        case "bbl": // Bottom-Back-Left (-X, +Y, -Z)
          offset.set(-dCorner, dCorner, -dCorner * 0.5);
          break;
        default:
          offset.set(distance * 0.7, -distance * 0.7, distance * 0.55);
          break;
      }

      state.camera.position.copy(center).add(offset);
      state.camera.near = Math.max(1, distance / 400);
      state.camera.far = distance * 12;
      state.camera.updateProjectionMatrix();
      state.controls.target.copy(center);
      state.controls.update();
      renderDirtyRef.current = true;
    },
    [],
  );

  const fit = useCallback(() => {
    setView("iso");
  }, [setView]);

  // Parts live in their own effect: the assembly animation only changes how many parts
  // are visible, so it must not re-run the overlay, reference-plane and connector work.
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
    const partsToRender = model.parts.slice(0, limitParts);
    const wanted = new Set<string>();
    const materialsKey = materials.map((material) => `${material.name}:${material.color ?? ""}`).join(",");

    const styleOf = (part: ResolvedPart) => {
      const isClearance =
        part.id.toLowerCase().includes("clearance") || part.name.toLowerCase().includes("clearance");
      const props = partMaterialProps(part, materials);
      return {
        color: partColor(part, materials),
        metalness: props.metalness,
        roughness: props.roughness,
        isSelected: part.id === selectedPartId,
        isTransparent: transparentPartIds.includes(part.id) || isClearance,
        isClearance,
        hasIssue: issuePartIds.includes(part.id),
        isAnimating: Boolean(animatingPartName) && part.name === animatingPartName,
      };
    };

    const applyStyle = (entry: PartCacheEntry, style: ReturnType<typeof styleOf>) => {
      const { meshMaterial: material, edgeMaterial } = entry;
      // Selection keeps the block solid; only "Make transparent" in the context menu
      // turns a part see-through.
      const transparent = style.isTransparent;
      const transparencyChanged = material.transparent !== transparent;
      material.color.set(style.isSelected ? 0xb7cff0 : style.color);
      material.metalness = style.metalness;
      material.roughness = style.roughness;
      material.transparent = transparent;
      material.opacity = style.isTransparent ? (style.isClearance ? 0.07 : 0.35) : 1;
      material.depthWrite = !transparent;
      material.emissive.set(style.isSelected ? 0x2f6fd0 : style.color);
      material.emissiveIntensity = style.isSelected ? 0.04 : style.isAnimating ? 0.55 : 0;
      material.polygonOffsetFactor = style.isSelected ? -1 : 1;
      if (transparencyChanged) material.needsUpdate = true;

      edgeMaterial.visible = true;

      if (style.isSelected) {
        edgeMaterial.color.setHex(0x3f8ce8); // Viền xanh Revit dịu quanh part đang chọn
        edgeMaterial.opacity = 0.75;
        edgeMaterial.transparent = true;
      } else if (style.hasIssue) {
        edgeMaterial.color.setHex(0xcf222e); // cảnh báo bố trí: viền đỏ
        edgeMaterial.opacity = 0.9;
        edgeMaterial.transparent = true;
      } else if (style.isAnimating) {
        edgeMaterial.color.setHex(0x2f7d5b); // green edge on the part that just appeared
        edgeMaterial.opacity = 0.95;
        edgeMaterial.transparent = true;
      } else if (style.isClearance) {
        edgeMaterial.color.setHex(0xd8a53a); // viền vàng mảnh cho vùng clearance
        edgeMaterial.opacity = 0.55;
        edgeMaterial.transparent = true;
      } else if (style.isTransparent) {
        edgeMaterial.color.setHex(0x30373b);
        edgeMaterial.opacity = 0.14;
        edgeMaterial.transparent = true;
      } else {
        edgeMaterial.color.setHex(0x30373b);
        edgeMaterial.opacity = 0.32;
        edgeMaterial.transparent = true;
      }

      for (const child of entry.group.children) {
        if (child instanceof THREE.Mesh) child.castShadow = !style.isTransparent;
      }
    };

    const buildEntry = (
      part: ResolvedPart,
      geometryKey: string,
      styleKey: string,
      built: BuiltPartGeometry,
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

      if (count > 1) {
        // Repeated parts (bolts, fins, louvres) are one draw call, not one per copy.
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
      }

      state.content.add(group);
      const entry: PartCacheEntry = { geometryKey, styleKey, group, meshMaterial, edgeMaterial, disposables };
      applyStyle(entry, styleOf(part));
      return entry;
    };

    let styleChanged = false;
    const pending: { part: ResolvedPart; geometryKey: string; styleKey: string }[] = [];

    for (const part of partsToRender) {
      if (hiddenPartIds.includes(part.id)) continue;

      wanted.add(part.id);

      let shapeKey = shapeKeys.get(part);
      if (!shapeKey) {
        shapeKey = `${JSON.stringify(part.solid)}|${JSON.stringify(part.cuts)}|${JSON.stringify(part.array)}`;
        shapeKeys.set(part, shapeKey);
      }

      const geometryKey = `${shapeKey}|${part.name}|${part.material ?? ""}|${part.color ?? ""}|${materialsKey}`;
      const style = styleOf(part);
      const styleKey = [
        style.isSelected ? "selected" : "",
        style.isTransparent ? "transparent" : "",
        style.isClearance ? "clearance" : "",
        style.hasIssue ? "issue" : "",
        style.isAnimating ? "hot" : "",
      ].join("|");

      const existing = partCache.get(part.id);
      if (existing && existing.geometryKey === geometryKey) {
        // Only the highlight/selection changed: recolour instead of re-cutting the solid.
        if (existing.styleKey !== styleKey) {
          applyStyle(existing, style);
          existing.styleKey = styleKey;
          styleChanged = true;
        }
        continue;
      }

      if (existing) dropEntry(existing);
      pending.push({ part, geometryKey, styleKey });
    }

    for (const [id, entry] of partCache) {
      if (wanted.has(id)) continue;
      dropEntry(entry);
      partCache.delete(id);
    }

    // Build a few parts per frame instead of cutting every solid in one tick: a large
    // LOD 400 assembly would otherwise freeze the window while it assembles.
    let cancelled = false;
    let cursor = 0;

    const step = async () => {
      if (cancelled || cursor >= pending.length) return;
      const { part, geometryKey, styleKey } = pending[cursor];
      cursor += 1;

      let built: BuiltPartGeometry;
      try {
        built = await buildPartGeometryAsync(part);
      } catch (error) {
        console.warn("Could not build part geometry", part.id, error);
        if (!cancelled && cursor < pending.length) {
          requestAnimationFrame(() => { void step(); });
        }
        return;
      }

      if (cancelled) {
        built.geometry.dispose();
        built.edges.dispose();
        return;
      }

      partCache.set(part.id, buildEntry(part, geometryKey, styleKey, built));
      state.renderer.shadowMap.needsUpdate = true;
      renderDirtyRef.current = true;

      if (cursor < pending.length) {
        requestAnimationFrame(() => { void step(); });
      }
    };

    if (pending.length > 0) {
      requestAnimationFrame(() => { void step(); });
    } else if (styleChanged) {
      state.renderer.shadowMap.needsUpdate = true;
      renderDirtyRef.current = true;
    }

    return () => {
      cancelled = true;
    };
  }, [model, materials, selectedPartId, hiddenPartIds, transparentPartIds, issuePartIds, visiblePartCount, animatingPartName]);

  // Zoom the camera to a part when an issue is clicked in the chat.
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

  // Section box: one global clipping plane in front of the chosen axis.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    // Rebuild only when the plane orientation/base changes; sliding reuses the meshes.
    const modelKey = model?.bounds
      ? `${model.bounds.size.x.toFixed(1)},${model.bounds.size.y.toFixed(1)},${model.bounds.size.z.toFixed(1)}`
      : "none";
    const buildKey =
      sectionAxis === "off" || !model?.bounds
        ? "off"
        : sectionAxis === "custom"
          ? sectionCustom
            ? `custom:${sectionCustom.normal.toArray().map((v) => v.toFixed(4)).join(",")}:${sectionCustom.base.toArray().map((v) => v.toFixed(2)).join(",")}:${modelKey}`
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

    // Travel range of a diagonal plane = the model's projected extent on its normal.
    const customRange = sectionCustom
      ? Math.abs(sectionCustom.normal.x) * size.x +
        Math.abs(sectionCustom.normal.y) * size.y +
        Math.abs(sectionCustom.normal.z) * size.z
      : extent;

    if (sectionAxis === "custom" && sectionCustom) {
      // Plane picked from a face: it slides along that face normal.
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

    state.renderer.clippingPlanes = [
      new THREE.Plane(normal.clone(), -normal.dot(planePoint)),
    ];

    // Keep the arrow on the plane, near the middle of the model.
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
    // Push the billboard handle clear of the clip plane so it is never cut in half.
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

    // The cross-section changes as the plane slides, so rebuild its two loops.
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

    // Live position chip next to the grip.
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
    const labelText =
      sectionAxis === "custom"
        ? `Mặt · ${sectionValueMm} mm`
        : `${sectionAxis.toUpperCase()} · ${sectionValueMm} mm`;

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

    const dragOrigin =
      sectionAxis === "custom" && sectionCustom ? sectionCustom.base.clone() : center.clone();
    const dragRange =
      sectionAxis === "custom" ? customRange : Math.max(max[sectionAxis] - min[sectionAxis], 1);
    sectionDragDataRef.current = {
      origin: dragOrigin,
      normal: normal.clone(),
      range: dragRange,
      // Axis planes slide against their normal (-axis), face planes along it.
      sign: sectionAxis === "custom" ? 1 : -1,
    };

    state.renderer.shadowMap.needsUpdate = true;
    renderDirtyRef.current = true;
  }, [sectionAxis, sectionT, model, sectionCustom]);

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

    const size = Math.max(model.bounds?.size.x ?? 0, model.bounds?.size.y ?? 0, 3000);
    const gridSize = Math.ceil((size * 2.4) / 1000) * 1000;
    if (state.gridSize !== gridSize) {
      state.scene.remove(state.grid);
      state.grid.geometry.dispose();
      state.grid.dispose();
      const nextGrid = new THREE.GridHelper(gridSize, Math.max(12, Math.round(gridSize / 200)), 0xcfccc4, 0xdedbd4);
      nextGrid.rotation.x = Math.PI / 2;
      nextGrid.position.z = -0.4;
      nextGrid.visible = showGrid;
      state.scene.add(nextGrid);
      state.grid = nextGrid;
      state.gridSize = gridSize;
    }
    state.grid.visible = showGrid;

    // Fit the key light and its shadow frustum to the model so the shadow stays crisp.
    if (model.bounds) {
      const { min, max } = model.bounds;
      const center = new THREE.Vector3(
        (min.x + max.x) / 2,
        (min.y + max.y) / 2,
        (min.z + max.z) / 2,
      );
      const extent = Math.max(model.bounds.size.x, model.bounds.size.y, model.bounds.size.z, 600) * 1.6;
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

      state.shadowPlane.scale.setScalar(gridSize / 6000);
      state.renderer.shadowMap.needsUpdate = true;
    }

    // Reference Planes (Revit Style Green Dashed Lines & Translucent Planes)
    state.refPlanesGroup.clear();
    state.handlesGroup.clear();

    // Shape Handles (Revit Blue Arrows for Direct Dimension Manipulation)
    state.handlesGroup.clear();

    // Hiện handle khi người dùng click chọn 1 Part cụ thể
    const selectedPart = selectedPartId && model ? model.parts.find((p) => p.id === selectedPartId) : null;

    if (selectedPart) {
      state.handlesGroup.visible = true;

      // Tính bounds riêng của Part đang được chọn
      const { geometry: partGeom } = buildPartGeometry(selectedPart);
      partGeom.computeBoundingBox();
      const pBox = partGeom.boundingBox;

      if (pBox) {
        const center = new THREE.Vector3(
          (pBox.min.x + pBox.max.x) / 2,
          (pBox.min.y + pBox.max.y) / 2,
          (pBox.min.z + pBox.max.z) / 2,
        );
        const sizeX = Math.max(pBox.max.x - pBox.min.x, 10);
        const sizeY = Math.max(pBox.max.y - pBox.min.y, 10);
        const sizeZ = Math.max(pBox.max.z - pBox.min.z, 10);
        const minDimension = Math.min(sizeX, sizeY, sizeZ);

        // Auto-scale shape handles to fit part size
        const scaleFactor = Math.min(1.0, Math.max(0.18, minDimension / 500));

        // Tìm parameter phù hợp nhất với Part đang chọn
        const partNameKeywords = selectedPart.name.toLowerCase().split(/\s+/);
        const findParamForPartAxis = (axisKeywords: string[], fallbackName: string, fallbackVal: number) => {
          // Ưu tiên param có chứa cả tên part lẫn keyword trục (vd: Casing Length, Flange Thickness,...)
          const exactMatch = parameters.find((p) =>
            partNameKeywords.some((pk) => pk.length > 2 && p.name.toLowerCase().includes(pk)) &&
            axisKeywords.some((ak) => p.name.toLowerCase().includes(ak.toLowerCase())) &&
            typeof p.value === "number",
          );
          if (exactMatch && typeof exactMatch.value === "number") {
            return { name: exactMatch.name, val: exactMatch.value };
          }
          const axisMatch = parameters.find((p) =>
            axisKeywords.some((ak) => p.name.toLowerCase().includes(ak.toLowerCase())) &&
            typeof p.value === "number",
          );
          return {
            name: axisMatch ? axisMatch.name : fallbackName,
            val: axisMatch && typeof axisMatch.value === "number" ? axisMatch.value : fallbackVal,
          };
        };

        const xParam = findParamForPartAxis(["length", "width", "od", "diameter", "radius"], `${selectedPart.name} X`, sizeX);
        const yParam = findParamForPartAxis(["depth", "width", "od", "diameter", "radius"], `${selectedPart.name} Y`, sizeY);
        const zParam = findParamForPartAxis(["height", "thickness", "length"], `${selectedPart.name} Z`, sizeZ);

        const createShapeHandle = (
          pos: THREE.Vector3,
          dir: THREE.Vector3,
          axis: "x" | "y" | "z",
          sign: number,
          paramInfo: { name: string; val: number },
        ) => {
          const handle = new THREE.Group();
          handle.position.copy(pos);

          const arrowLength = 70 * scaleFactor;
          const arrowHead = 95 * scaleFactor;
          const arrowRadius = 32 * scaleFactor;

          const coneGeom = new THREE.ConeGeometry(arrowRadius, arrowHead, 16);
          coneGeom.translate(0, arrowHead / 2 + arrowLength, 0);

          const stemGeom = new THREE.CylinderGeometry(11 * scaleFactor, 11 * scaleFactor, arrowLength, 12);
          stemGeom.translate(0, arrowLength / 2, 0);

          const handleMat = new THREE.MeshStandardMaterial({
            color: 0x0078d4, // Revit blue handle
            roughness: 0.2,
            metalness: 0.2,
            depthTest: false,
          });
          state.disposables.push(coneGeom, stemGeom, handleMat);

          const coneMesh = new THREE.Mesh(coneGeom, handleMat);
          const stemMesh = new THREE.Mesh(stemGeom, handleMat);
          coneMesh.renderOrder = 999;
          stemMesh.renderOrder = 999;

          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
          handle.quaternion.copy(q);

          handle.add(coneMesh);
          handle.add(stemMesh);

          handle.userData = {
            isShapeHandle: true,
            axis,
            dir: sign,
            paramName: paramInfo.name,
            currentVal: paramInfo.val,
          };

          state.handlesGroup.add(handle);
        };

        // +X handle
        createShapeHandle(
          new THREE.Vector3(pBox.max.x, center.y, center.z),
          new THREE.Vector3(1, 0, 0),
          "x",
          1,
          xParam,
        );
        // -X handle
        createShapeHandle(
          new THREE.Vector3(pBox.min.x, center.y, center.z),
          new THREE.Vector3(-1, 0, 0),
          "x",
          -1,
          xParam,
        );
        // +Y handle
        createShapeHandle(
          new THREE.Vector3(center.x, pBox.max.y, center.z),
          new THREE.Vector3(0, 1, 0),
          "y",
          1,
          yParam,
        );
        // -Y handle
        createShapeHandle(
          new THREE.Vector3(center.x, pBox.min.y, center.z),
          new THREE.Vector3(0, -1, 0),
          "y",
          -1,
          yParam,
        );
        // +Z handle
        createShapeHandle(
          new THREE.Vector3(center.x, center.y, pBox.max.z),
          new THREE.Vector3(0, 0, 1),
          "z",
          1,
          zParam,
        );
      }
      partGeom.dispose();
    } else {
      state.handlesGroup.visible = false;
    }

    if (showPlanes && model.bounds) {
      // Keep the plane frame close to the model: a full-grid frame tints the whole viewport.
      const modelExtent = Math.max(
        model.bounds.size.x,
        model.bounds.size.y,
        model.bounds.size.z,
        400,
      );
      const planeExtent = modelExtent * 1.4;
      const halfExt = planeExtent / 2;

      const refLineMat = new THREE.LineDashedMaterial({
        color: 0x2e8540, // Revit Reference Plane Green
        dashSize: 45,
        gapSize: 25,
        linewidth: 1.5,
        transparent: true,
        opacity: 0.5,
      });
      state.disposables.push(refLineMat);

      // Reference planes read as green dashed lines in Revit; fills only wash the view out.
      // Center (Front/Back) plane: Y = 0, drawn as an outline on the floor.
      const xzGeom = new THREE.PlaneGeometry(planeExtent, planeExtent);
      xzGeom.rotateX(Math.PI / 2);
      const xzOutline = new THREE.LineSegments(new THREE.EdgesGeometry(xzGeom), refLineMat);
      xzOutline.computeLineDistances();
      xzOutline.position.set(0, 0, 0);
      state.refPlanesGroup.add(xzOutline);
      state.disposables.push(xzGeom, xzOutline.geometry);

      // Center (Left/Right) plane: X = 0.
      const yzGeom = new THREE.PlaneGeometry(planeExtent, planeExtent);
      yzGeom.rotateY(Math.PI / 2);
      const yzOutline = new THREE.LineSegments(new THREE.EdgesGeometry(yzGeom), refLineMat);
      yzOutline.computeLineDistances();
      state.refPlanesGroup.add(yzOutline);
      state.disposables.push(yzGeom, yzOutline.geometry);

      // Reference cross lines through Origin
      // X-Axis line (along X)
      const xLinePts = [new THREE.Vector3(-halfExt, 0, 0), new THREE.Vector3(halfExt, 0, 0)];
      const xLineGeom = new THREE.BufferGeometry().setFromPoints(xLinePts);
      const xLine = new THREE.Line(xLineGeom, refLineMat);
      xLine.computeLineDistances();
      state.refPlanesGroup.add(xLine);
      state.disposables.push(xLineGeom);

      // Y-Axis line (along Y)
      const yLinePts = [new THREE.Vector3(0, -halfExt, 0), new THREE.Vector3(0, halfExt, 0)];
      const yLineGeom = new THREE.BufferGeometry().setFromPoints(yLinePts);
      const yLine = new THREE.Line(yLineGeom, refLineMat);
      yLine.computeLineDistances();
      state.refPlanesGroup.add(yLine);
      state.disposables.push(yLineGeom);

      // Z-Axis line (along Z)
      const zLinePts = [new THREE.Vector3(0, 0, -200), new THREE.Vector3(0, 0, halfExt)];
      const zLineGeom = new THREE.BufferGeometry().setFromPoints(zLinePts);
      const zLine = new THREE.Line(zLineGeom, refLineMat);
      zLine.computeLineDistances();
      state.refPlanesGroup.add(zLine);
      state.disposables.push(zLineGeom);

      // One plane per length parameter — the same skeleton the Revit add-in builds,
      // so the studio shows where the family's reference planes will sit.
      const bounds = model.bounds;
      const centerX = (bounds.min.x + bounds.max.x) / 2;
      const centerY = (bounds.min.y + bounds.max.y) / 2;
      const centerZ = (bounds.min.z + bounds.max.z) / 2;
      const margin = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 300) * 0.12;
      const spanX = Math.max(bounds.size.x + margin * 2, 300);
      const spanY = Math.max(bounds.size.y + margin * 2, 300);
      const spanZ = Math.max(bounds.size.z + margin * 2, 300);

      // Very light line work: a dozen overlapping planes would otherwise tint the model.
      const paramLineMat = new THREE.LineDashedMaterial({
        color: 0x2e8540,
        dashSize: 40,
        gapSize: 30,
        transparent: true,
        opacity: 0.4,
      });
      state.disposables.push(paramLineMat);

      const axisForParameter = (name: string): "x" | "y" | "z" => {
        const text = name.toLowerCase();
        if (text.includes("width") || text.includes("length") || text.includes("left") || text.includes("right")) {
          return "x";
        }
        if (text.includes("depth") || text.includes("front") || text.includes("back")) return "y";
        return "z";
      };

      let drawn = 0;
      for (const parameter of parameters) {
        if (drawn >= 12) break;
        if (parameter.type !== "Length") continue;
        if (parameter.formula) continue;
        if (typeof parameter.value !== "number" || Math.abs(parameter.value) < 1) continue;

        const value = Math.abs(parameter.value);
        const axis = axisForParameter(parameter.name);
        const near = (a: number, b: number) => Math.abs(a - b) <= 1;

        let coordinate: number;
        let width: number;
        let height: number;
        let rotate: (geometry: THREE.PlaneGeometry) => void;
        let place: (mesh: THREE.Object3D) => void;

        if (axis === "x") {
          // Envelope dimensions sit on the far face, anything else is placed half-way out.
          coordinate = near(bounds.max.x, value) || near(bounds.size.x, value)
            ? bounds.max.x
            : centerX + value / 2;
          width = spanY;
          height = spanZ;
          rotate = (geometry) => geometry.rotateY(Math.PI / 2);
          place = (mesh) => mesh.position.set(coordinate, centerY, centerZ);
        } else if (axis === "y") {
          coordinate = near(bounds.max.y, value) || near(bounds.size.y, value)
            ? bounds.max.y
            : centerY + value / 2;
          width = spanX;
          height = spanZ;
          rotate = (geometry) => geometry.rotateX(Math.PI / 2);
          place = (mesh) => mesh.position.set(centerX, coordinate, centerZ);
        } else {
          coordinate = near(bounds.size.z, value) ? bounds.max.z : bounds.min.z + value;
          width = spanX;
          height = spanY;
          rotate = () => undefined;
          place = (mesh) => mesh.position.set(centerX, centerY, coordinate);
        }

        // Outline only: a dozen filled planes would tint the whole model green.
        const planeGeom = new THREE.PlaneGeometry(width, height);
        rotate(planeGeom);

        const outlineGeom = new THREE.EdgesGeometry(planeGeom);
        const outline = new THREE.LineSegments(outlineGeom, paramLineMat);
        outline.computeLineDistances();
        place(outline);
        state.refPlanesGroup.add(outline);
        state.disposables.push(planeGeom, outlineGeom);

        drawn += 1;
      }
    }

    // -------------------------------------------------------------
    // MEP Connectors 3D Symbols (Revit Style Flow Arrows & Rings)
    // -------------------------------------------------------------
    state.connectorsGroup.clear();
    state.connectorsGroup.visible = Boolean(showConnectors);

    if (showConnectors && model.connectors && model.connectors.length > 0) {
      for (const conn of model.connectors) {
        const connGroup = new THREE.Group();
        connGroup.position.set(conn.origin.x, conn.origin.y, conn.origin.z);

        // System color mapping
        let colorHex = 0x0969da; // Default Blue
        if (conn.systemType.includes("SupplyAir")) colorHex = 0x1f883d; // Green
        else if (conn.systemType.includes("ReturnAir")) colorHex = 0xd9381e; // Red/Magenta
        else if (conn.systemType.includes("HydronicSupply")) colorHex = 0x0969da; // Blue
        else if (conn.systemType.includes("HydronicReturn")) colorHex = 0xd47600; // Orange
        else if (conn.systemType.includes("Sanitary")) colorHex = 0x8250df; // Purple

        const arrowDir = new THREE.Vector3(
          conn.directionVector.x,
          conn.directionVector.y,
          conn.directionVector.z
        ).normalize();

        // Connector Boundary Rim / Ring
        if (conn.shape === "round") {
          const radius = (conn.diameter || 50) / 2;
          const torusGeom = new THREE.TorusGeometry(radius, 4, 12, 32);
          const torusMat = new THREE.MeshBasicMaterial({ color: colorHex });
          state.disposables.push(torusGeom, torusMat);
          const torus = new THREE.Mesh(torusGeom, torusMat);

          // Align torus normal with arrow direction
          const defaultNormal = new THREE.Vector3(0, 0, 1);
          const quat = new THREE.Quaternion().setFromUnitVectors(defaultNormal, arrowDir);
          torus.quaternion.copy(quat);
          connGroup.add(torus);
        } else {
          const w = conn.width || 200;
          const h = conn.height || 200;
          const rectGeom = new THREE.BoxGeometry(w, h, 6);
          const rectEdges = new THREE.LineSegments(
            new THREE.EdgesGeometry(rectGeom),
            new THREE.LineBasicMaterial({ color: colorHex, linewidth: 2 })
          );
          state.disposables.push(rectGeom);
          const defaultNormal = new THREE.Vector3(0, 0, 1);
          const quat = new THREE.Quaternion().setFromUnitVectors(defaultNormal, arrowDir);
          rectEdges.quaternion.copy(quat);
          connGroup.add(rectEdges);
        }

        // Flow Arrow helper
        const arrowLength = 70;
        const arrowHelper = new THREE.ArrowHelper(
          arrowDir,
          new THREE.Vector3(0, 0, 0),
          arrowLength,
          colorHex,
          24,
          16
        );
        connGroup.add(arrowHelper);

        state.connectorsGroup.add(connGroup);
      }
    }

    const initialLoad = !hasFittedRef.current;
    if (initialLoad) {
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

      <div className="viewer-tools">
        <button type="button" className="tool" onClick={fit} title="Fit view (Vừa khung)">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
          </svg>
          <span className="tool-label">Fit</span>
        </button>
        <button
          type="button"
          className={`tool ${showGrid ? "active" : ""}`}
          onClick={onToggleGrid}
          title="Toggle the ground grid"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M2 2h12v12H2zM2 6h12M2 10h12M6 2v12M10 2v12" />
          </svg>
          <span className="tool-label">Grid</span>
        </button>
        <button
          type="button"
          className={`tool ${shadowsEnabled ? "active" : ""}`}
          onClick={() => setShadowsEnabled((curr) => !curr)}
          title="Bật/Tắt đổ bóng (Shadows)"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <circle cx="8" cy="7" r="3" />
            <path d="M8 1v1.6M8 11.4V13M2 7h1.6M12.4 7H14M3.8 2.8l1.1 1.1M10.5 9.5l1.1 1.1M12.2 2.8l-1.1 1.1M5.1 9.5l-1.1 1.1" />
          </svg>
          <span className="tool-label">Shadows</span>
        </button>
        {onTogglePlanes && (
          <button
            type="button"
            className={`tool ${showPlanes ? "active" : ""}`}
            onClick={onTogglePlanes}
            title="Toggle Reference Planes (Mặt phẳng tham chiếu)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path strokeDasharray="3 2" d="M8 1v14M1 8h14" />
            </svg>
            <span className="tool-label">Ref Planes</span>
          </button>
        )}
        <button
          type="button"
          className={`tool ${sectionAxis !== "off" ? "active" : ""}`}
          onClick={() => {
            if (sectionAxis === "off") {
              setSectionT(1);
              setSectionAxis("x");
            } else {
              setSectionAxis("off");
              setPickingSection(false);
            }
          }}
          title="Cắt khối để xem bên trong (Section)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 7l9-4 9 4-9 4-9-4z" />
            <path d="M3 12l9 4 9-4M3 17l9 4 9-4" />
          </svg>
          <span className="tool-label">Section</span>
        </button>
        <button
          type="button"
          className={`tool ${measuring ? "active" : ""}`}
          onClick={() => setMeasuring((current) => !current)}
          title="Đo khoảng cách: bật rồi bấm 2 điểm trên mô hình"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 15 15 3l6 6L9 21l-6-6z" />
            <path d="M7 11l2 2M10 8l2 2M13 5l2 2" />
          </svg>
          <span className="tool-label">Measure</span>
        </button>
        {onToggleConnectors && (
          <button
            type="button"
            className={`tool ${showConnectors ? "active" : ""}`}
            onClick={onToggleConnectors}
            title="Toggle MEP Connectors (Cổng kết nối Cơ điện & Mũi tên hướng dòng chảy)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 4v8M5 7l3-3 3 3" />
            </svg>
            <span className="tool-label">Connectors</span>
          </button>
        )}
        <button
          type="button"
          className={`tool ${turntableActive ? "active" : ""}`}
          onClick={() => setTurntableActive((curr) => !curr)}
          title="Bật/Tắt hiệu ứng xoay tròn 360° tự động như bàn xoay trưng bày (Turntable)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
          </svg>
          <span className="tool-label">Turntable</span>
        </button>
        {hiddenPartIds.length > 0 && onUnhideAll && (
          <button
            type="button"
            className="tool unhide-all-btn"
            onClick={onUnhideAll}
            title="Unhide all hidden parts (Hiện lại tất cả các cấu kiện đang ẩn)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span className="tool-label">Unhide all ({hiddenPartIds.length})</span>
          </button>
        )}
      </div>

      {sectionAxis !== "off" && (
        <div className="section-card">
          <div className="section-card-head">
            <span>Section · mặt cắt</span>
            <button
              type="button"
              className="modal-close"
              onClick={() => setSectionAxis("off")}
              aria-label="Đóng section"
            >
              ×
            </button>
          </div>
          <div className="section-axis">
            {(["x", "y", "z"] as const).map((axis) => (
              <button
                key={axis}
                type="button"
                className={sectionAxis === axis ? "active" : ""}
                onClick={() => {
                  setSectionAxis(axis);
                  setPickingSection(false);
                  setSectionT(1);
                }}
              >
                {axis.toUpperCase()}
              </button>
            ))}
            <button
              type="button"
              className={sectionAxis === "custom" ? "active" : ""}
              onClick={() => setPickingSection(true)}
              title="Chọn mặt phẳng cắt bằng cách bấm vào một mặt của mô hình"
            >
              ⌖
            </button>
          </div>

          {pickingSection && (
            <div className="section-hint">Bấm vào một mặt của mô hình để đặt mặt cắt…</div>
          )}

          {sectionAxis === "custom" && sectionCustom && (
            <button
              type="button"
              className="section-flip"
              onClick={() =>
                setSectionCustom((current) =>
                  current ? { ...current, normal: current.normal.clone().negate() } : current,
                )
              }
            >
              Đảo chiều mặt cắt
            </button>
          )}

          <div className="section-value">
            <input
              type="number"
              step={10}
              value={sectionMm?.value ?? 0}
              onChange={(event) => applySectionMm(Number(event.target.value))}
              disabled={!sectionMm}
              aria-label="Section position in millimetres"
            />
            <span>mm</span>
          </div>
          <div className="section-tip">Kéo tay nắm trên mô hình hoặc nhập số để dịch mặt cắt</div>
        </div>
      )}

      {model && dims && <div className="viewer-dims">{dims}</div>}

      {measuring && !measureLabel && (
        <div className="measure-badge">Bấm điểm thứ nhất trên mô hình · Esc để huỷ</div>
      )}
      {measureLabel && (
        <div className="measure-badge">
          <span>{measureLabel}</span>
          {measureCount > 0 && (
            <button type="button" onClick={clearMeasurements}>
              Xoá {measureCount} phép đo
            </button>
          )}
        </div>
      )}

      <div className="viewcube-container" ref={cubeHostRef} title="Click a face to align view" />

      {status && (
        <div className="run-card">
          <div className="run-head">
            <span className="spinner" />
            <span className="run-title">{stepTitle(status.stage)}</span>
            {status.elapsed && <span className="run-time">{status.elapsed}</span>}
          </div>

          <div className="run-steps">
            {RUN_STEPS.map((label, index) => {
              const current = stepIndex(status.stage);
              const state = index < current ? "done" : index === current ? "active" : "todo";
              return (
                <div key={label} className={`run-step ${state}`}>
                  <span className="run-dot">{state === "done" ? "✓" : ""}</span>
                  <span>{label}</span>
                </div>
              );
            })}
          </div>

          {status.stage === "working" && status.message && (
            <div className="run-detail">{status.message}</div>
          )}
        </div>
      )}

      {!status && model && model.issues.some((issue) => issue.severity === "error") && (
        <div className="viewer-status" style={{ color: "#ae463b" }}>
          {model.issues.filter((issue) => issue.severity === "error").length} problem(s) in the model
        </div>
      )}

      {!model && (
        <div className="viewer-empty">
          <div>
            <strong>Nothing to show yet</strong>
            Describe a unit in the chat and the model appears here.
          </div>
        </div>
      )}

      {activeHandle && (
        <div
          className="viewer-handle-tooltip"
          style={{
            left: `${activeHandle.screenX}px`,
            top: `${activeHandle.screenY}px`,
          }}
        >
          <span className="name">{activeHandle.label}</span>
          <span className="val">{activeHandle.value} {units}</span>
        </div>
      )}

      {contextMenu && (
        <div
          className="viewer-context-menu"
          style={{
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="menu-header">
            <span className="menu-part-icon" />
            <span className="menu-part-name" title={contextMenu.partName}>
              {contextMenu.partName}
            </span>
          </div>
          <div className="menu-divider" />
          
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              onToggleHidePart?.(contextMenu.partId);
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {hiddenPartIds.includes(contextMenu.partId) ? (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              ) : (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </>
              )}
            </svg>
            <span>{hiddenPartIds.includes(contextMenu.partId) ? "Hiện cấu kiện (Unhide)" : "Ẩn cấu kiện (Hide)"}</span>
          </button>

          <button
            type="button"
            className="menu-item"
            onClick={() => {
              onToggleTransparentPart?.(contextMenu.partId);
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z" />
              <path d="M12 6a6 6 0 0 0 0 12z" fill="currentColor" opacity="0.6" />
            </svg>
            <span>
              {transparentPartIds.includes(contextMenu.partId)
                ? "Làm đặc lại (Solid / Opaque)"
                : "Làm mờ (Ghost / Translucent)"}
            </span>
          </button>

          <div className="menu-divider" />

          <button
            type="button"
            className="menu-item"
            onClick={() => {
              // Isolate element: hide all other parts except this one
              if (model) {
                const otherIds = model.parts.map((p) => p.id).filter((id) => id !== contextMenu.partId);
                // hide all other parts
                otherIds.forEach((id) => {
                  if (!hiddenPartIds.includes(id)) {
                    onToggleHidePart?.(id);
                  }
                });
              }
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3" />
              <rect x="7" y="7" width="10" height="10" fill="currentColor" fillOpacity="0.3" />
            </svg>
            <span>Cô lập cấu kiện (Isolate)</span>
          </button>

          <button
            type="button"
            className="menu-item"
            title="Cắt mặt cắt ngay qua cấu kiện này"
            onClick={() => {
              if (contextMenu.normal && contextMenu.center) {
                setSectionCustom({
                  normal: contextMenu.normal.clone(),
                  base: contextMenu.center.clone(),
                });
                setSectionAxis("custom");
                setSectionT(0.5);
                setPickingSection(false);
              }
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3h18v18H3z" strokeDasharray="3 3" />
              <path d="M3 12h18" />
              <path d="M12 3v18" opacity="0.4" />
            </svg>
            <span>Section từ cấu kiện này</span>
          </button>

          {(hiddenPartIds.length > 0 || transparentPartIds.length > 0) && (
            <>
              <div className="menu-divider" />
              {hiddenPartIds.length > 0 && (
                <button
                  type="button"
                  className="menu-item secondary"
                  onClick={() => {
                    onUnhideAll?.();
                    setContextMenu(null);
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  <span>Hiện lại tất cả ({hiddenPartIds.length})</span>
                </button>
              )}
              {transparentPartIds.length > 0 && (
                <button
                  type="button"
                  className="menu-item secondary"
                  onClick={() => {
                    onResetTransparent?.();
                    setContextMenu(null);
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                  <span>Khôi phục độ mờ tất cả</span>
                </button>
              )}
            </>
          )}
        </div>
      )}

      {animatingPartName && !status && (
        <div className="viewer-assembly-badge">
          <span className="assembly-pulse" />
          <span>Assembling: <strong>{animatingPartName}</strong> ({visiblePartCount}/{model?.parts.length})</span>
        </div>
      )}

      {selectedPartId && (
        <div className="viewer-selected-chip">
          <span className="dot" />
          <span>Part: <strong>{model?.parts.find((p) => p.id === selectedPartId)?.name || selectedPartId}</strong></span>
          {onToggleHidePart && (
            <button
              type="button"
              className="chip-action-btn"
              title="Hide this part (Ẩn cấu kiện này)"
              onClick={() => {
                onToggleHidePart(selectedPartId);
                onSelectPart?.(null);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
              <span>Hide</span>
            </button>
          )}
          <button
            type="button"
            className="chip-close"
            title="Deselect"
            onClick={() => onSelectPart?.(null)}
          >
            ×
          </button>
        </div>
      )}

      {model && (
        <div className="viewer-caption">
          {model.parts.length} parts · {model.instances} solids
        </div>
      )}
    </div>
  );
}
