import { useCallback, useEffect, useRef, useState } from "react";
import type { FamilyParameter, MaterialDef, ResolvedModel } from "@family/spec-core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { formatDimensions, type Units } from "../lib/format";
import { buildPartGeometry, partColor, partMaterialProps } from "../lib/three-build";

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

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  handlesGroup: THREE.Group;
  grid: THREE.GridHelper;
  refPlanesGroup: THREE.Group;
  connectorsGroup: THREE.Group;
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
  onUpdateParameter,
  status,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cubeHostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);
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
  } | null>(null);

  const [visiblePartCount, setVisiblePartCount] = useState<number>(0);
  const prevModelRef = useRef<ResolvedModel | null>(null);

  const [animatingPartName, setAnimatingPartName] = useState<string | null>(null);
  const [turntableActive, setTurntableActive] = useState<boolean>(false);
  const turntableRef = useRef<boolean>(false);
  turntableRef.current = turntableActive;

  const statusRef = useRef(status);
  statusRef.current = status;

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
      // Khi nạp 1 model mới hoàn chỉnh vào
      setVisiblePartCount(1);
      setAnimatingPartName(model.parts[0]?.name || null);
      let count = 1;
      const total = model.parts.length;
      const interval = setInterval(() => {
        count += 1;
        setVisiblePartCount(count);
        setAnimatingPartName(model.parts[count - 1]?.name || null);
        if (count >= total) {
          clearInterval(interval);
          setTimeout(() => setAnimatingPartName(null), 1200);
        }
      }, 350);
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
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
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

    // Standard CAD / Revit mouse mapping:
    // Left click: Rotate / Orbit
    // Middle click (or Right click): Pan / Rê khung hình
    // Right click: Pan / Rotate
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };

    scene.add(new THREE.HemisphereLight(0xffffff, 0xa7a29a, 1.25));

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2800, -3200, 3600);
    scene.add(key);

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

    const resize = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
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
        } else {
          renderer.domElement.style.cursor = "default";
        }
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

    const onCanvasClick = (e: MouseEvent) => {
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
        let currentObj: THREE.Object3D | null = intersects[0].object;
        while (currentObj && !currentObj.userData.partId && currentObj.parent !== content && currentObj.parent) {
          currentObj = currentObj.parent;
        }
        const hitId = currentObj?.userData.partId || null;
        if (hitId) {
          const partDef = modelRef.current?.parts.find((p) => p.id === hitId);
          const partName = partDef?.name || hitId;
          onSelectPartRef.current?.(hitId);
          setContextMenu({
            partId: hitId,
            partName,
            x: e.clientX,
            y: e.clientY,
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
    let animStartPos = new THREE.Vector3();
    let animEndPos = new THREE.Vector3();
    let animStartTarget = new THREE.Vector3();
    let animEndTarget = new THREE.Vector3();
    let animProgress = 1; // 1 = done

    const createCubeMaterial = (text: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d")!;

      // Neutral matte gray background like Revit ViewCube
      ctx.fillStyle = "#8a8f94";
      ctx.fillRect(0, 0, 256, 256);

      // Subtle top/left light bevel
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(2, 254);
      ctx.lineTo(2, 2);
      ctx.lineTo(254, 2);
      ctx.stroke();

      // Clean Revit border
      ctx.strokeStyle = "#5f656a";
      ctx.lineWidth = 3;
      ctx.strokeRect(1, 1, 254, 254);

      // Revit typography: italic sans-serif bold, subtle dark ink
      ctx.fillStyle = "#2c3034";
      ctx.font = "italic bold 42px 'Segoe UI', Arial, sans-serif";
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
        new THREE.LineBasicMaterial({ color: 0x5a6066, linewidth: 1 })
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
      cCtx.lineWidth = 44;
      cCtx.strokeStyle = "rgba(65, 70, 75, 0.7)";
      cCtx.stroke();

      // Inner ring thin contour
      cCtx.beginPath();
      cCtx.arc(256, 256, 198, 0, Math.PI * 2);
      cCtx.lineWidth = 1.5;
      cCtx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      cCtx.stroke();

      // Cardinal direction letters (N, S, E, W) - crisp light gray
      cCtx.fillStyle = "#ffffff";
      cCtx.font = "bold 46px 'Segoe UI', Arial, sans-serif";
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

        let offset = new THREE.Vector3();
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
      }

      // Turntable exhibition rotation when explicitly toggled by user
      if (turntableRef.current) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.35; // Gentle, cinematic exhibition turntable speed
      } else {
        controls.autoRotate = false;
      }

      controls.update();
      renderer.render(scene, camera);

      if (cubeRenderer && cubeScene && cubeCamera) {
        // Sync cube camera rotation with main scene camera
        const dir = camera.position.clone().sub(controls.target).normalize();
        cubeCamera.position.copy(dir.multiplyScalar(6.2)); // Distance 6.2 accommodates larger compass ring without clipping
        cubeCamera.lookAt(0, 0, 0);
        cubeRenderer.render(cubeScene, cubeCamera);
      }
    };
    tick();

    stateRef.current = { renderer, scene, camera, controls, content, handlesGroup, grid, refPlanesGroup, connectorsGroup, disposables: [] };

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      renderer.domElement.removeEventListener("mousedown", onCanvasMouseDown);
      window.removeEventListener("mousemove", onCanvasMouseMove);
      window.removeEventListener("mouseup", onCanvasMouseUp);
      renderer.domElement.removeEventListener("click", onCanvasClick);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      if (cubeRenderer && cubeHost && cubeRenderer.domElement.parentElement === cubeHost) {
        cubeHost.removeChild(cubeRenderer.domElement);
        cubeRenderer.dispose();
      }
      stateRef.current = null;
    };
  }, []);

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

      let offset = new THREE.Vector3();
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
    },
    [],
  );

  const fit = useCallback(() => {
    setView("iso");
  }, [setView]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    for (const item of state.disposables) item.dispose();
    state.disposables = [];
    state.content.clear();

    state.grid.visible = showGrid;

    if (!model) return;

    const materialCache = new Map<string, THREE.MeshStandardMaterial>();
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x30373b,
      transparent: true,
      opacity: 0.18,
    });
    state.disposables.push(edgeMaterial);

    const limitParts = visiblePartCount > 0 ? visiblePartCount : model.parts.length;
    const partsToRender = model.parts.slice(0, limitParts);

    for (const part of partsToRender) {
      if (hiddenPartIds.includes(part.id)) {
        continue;
      }

      const { geometry } = buildPartGeometry(part);
      state.disposables.push(geometry);

      const color = partColor(part, materials);
      const props = partMaterialProps(part, materials);

      const isClearance = part.id.toLowerCase().includes("clearance") || part.name.toLowerCase().includes("clearance");
      const isSelected = part.id === selectedPartId;
      const isTransparent = transparentPartIds.includes(part.id) || isClearance;
      const key = `${color}|${props.metalness}|${props.roughness}|${isTransparent ? (isClearance ? "clearance" : "trans") : "solid"}`;

      const activeOpacity = isTransparent ? (isClearance ? 0.22 : 0.35) : 1.0;

      let material: THREE.MeshStandardMaterial;

      if (isSelected) {
        // Giữ màu gốc của part, chỉ làm mờ/bán trong suốt (translucent) nhẹ kèm viền xanh nổi bật
        material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(color),
          metalness: Math.max(0.1, props.metalness),
          roughness: Math.max(0.2, props.roughness),
          transparent: true,
          opacity: 0.55, // Mờ nhẹ thanh thoát
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        });
        state.disposables.push(material);
      } else {
        let cached = materialCache.get(key);
        if (!cached) {
          cached = new THREE.MeshStandardMaterial({
            color: new THREE.Color(color),
            metalness: props.metalness,
            roughness: props.roughness,
            transparent: isTransparent,
            opacity: activeOpacity,
            depthWrite: !isTransparent,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          });
          materialCache.set(key, cached);
          state.disposables.push(cached);
        }
        material = cached;
      }

      let edges: THREE.LineSegments | null = null;
      if (part.cuts.length === 0) {
        const edgeGeometry = new THREE.EdgesGeometry(geometry, 24);
        state.disposables.push(edgeGeometry);
        const thisEdgeMat = isSelected
          ? new THREE.LineBasicMaterial({
              color: 0x0078d4, // Viền xanh Revit sắc nét bao quanh part đang chọn
              linewidth: 2,
              transparent: false,
              opacity: 1.0,
            })
          : isTransparent
          ? new THREE.LineBasicMaterial({
              color: 0x30373b,
              transparent: true,
              opacity: 0.1,
            })
          : edgeMaterial;
        if (isSelected || isTransparent) state.disposables.push(thisEdgeMat);
        edges = new THREE.LineSegments(edgeGeometry, thisEdgeMat);
      }

      for (let index = 0; index < part.array.count; index += 1) {
        const mesh = new THREE.Mesh(geometry, material);
        const offset = { x: 0, y: 0, z: 0 };
        offset[part.array.axis] = part.array.spacing * index;
        mesh.position.set(offset.x, offset.y, offset.z);
        mesh.name = part.name;
        mesh.userData = { partId: part.id, partName: part.name };
        state.content.add(mesh);

        if (edges) {
          const clone = edges.clone();
          clone.position.copy(mesh.position);
          clone.userData = { partId: part.id };
          state.content.add(clone);
        }
      }
    }

    const size = Math.max(model.bounds?.size.x ?? 0, model.bounds?.size.y ?? 0, 3000);
    const gridSize = Math.ceil((size * 2.4) / 1000) * 1000;
    state.scene.remove(state.grid);
    state.grid.geometry.dispose();
    state.grid.dispose();
    const nextGrid = new THREE.GridHelper(gridSize, Math.max(12, Math.round(gridSize / 200)), 0xcfccc4, 0xdedbd4);
    nextGrid.rotation.x = Math.PI / 2;
    nextGrid.position.z = -0.4;
    nextGrid.visible = showGrid;
    state.scene.add(nextGrid);
    state.grid = nextGrid;

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
      const planeExtent = Math.max(gridSize * 0.7, 2400);
      const halfExt = planeExtent / 2;

      const refLineMat = new THREE.LineDashedMaterial({
        color: 0x2e8540, // Revit Reference Plane Green
        dashSize: 45,
        gapSize: 25,
        linewidth: 1.5,
      });
      state.disposables.push(refLineMat);

      const refPlaneMat = new THREE.MeshBasicMaterial({
        color: 0x5cb85c,
        transparent: true,
        opacity: 0.04,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      state.disposables.push(refPlaneMat);

      // Center (Front/Back) Plane: Y = 0 (XZ Plane)
      const xzGeom = new THREE.PlaneGeometry(planeExtent, planeExtent);
      xzGeom.rotateX(Math.PI / 2);
      xzGeom.translate(0, 0, halfExt / 2);
      const xzMesh = new THREE.Mesh(xzGeom, refPlaneMat);
      state.refPlanesGroup.add(xzMesh);
      state.disposables.push(xzGeom);

      // Center (Left/Right) Plane: X = 0 (YZ Plane)
      const yzGeom = new THREE.PlaneGeometry(planeExtent, planeExtent);
      yzGeom.rotateY(Math.PI / 2);
      yzGeom.translate(0, 0, halfExt / 2);
      const yzMesh = new THREE.Mesh(yzGeom, refPlaneMat);
      state.refPlanesGroup.add(yzMesh);
      state.disposables.push(yzGeom);

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
  }, [model, parameters, materials, showGrid, showPlanes, showConnectors, selectedPartId, hiddenPartIds, transparentPartIds, visiblePartCount, fit]);

  const dims = formatDimensions(model?.bounds ?? null, units);

  return (
    <div className="viewer">
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />

      <div className="viewer-tools">
        <button type="button" className="tool" onClick={fit}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
          </svg>
          Fit
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
          Grid
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
            Ref Planes
          </button>
        )}
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
            Connectors
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
          Turntable
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
            Unhide all ({hiddenPartIds.length})
          </button>
        )}
      </div>

      {dims && <div className="viewer-dims">{dims}</div>}

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

      {animatingPartName && (
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
