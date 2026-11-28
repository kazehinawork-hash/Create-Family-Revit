import type { ResolvedModel } from "@family/spec-core";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { computeCameraPreset } from "./sceneHelpers";
import type { ViewDirection } from "./types";

function createCubeMaterial(text: string): THREE.MeshStandardMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#d6d9dc";
  ctx.fillRect(0, 0, 256, 256);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(2, 254);
  ctx.lineTo(2, 2);
  ctx.lineTo(254, 2);
  ctx.stroke();

  ctx.strokeStyle = "#aeb3b7";
  ctx.lineWidth = 3;
  ctx.strokeRect(1, 1, 254, 254);

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
}

export interface ViewCubeHandle {
  render: (camera: THREE.PerspectiveCamera, controls: OrbitControls) => void;
  dispose: () => void;
}

export function setupViewCube({
  cubeHost,
  camera,
  modelRef,
  setViewRef,
  onTransitionTo,
}: {
  cubeHost: HTMLElement | null;
  camera: THREE.PerspectiveCamera;
  modelRef: MutableRefObject<ResolvedModel | null>;
  setViewRef: MutableRefObject<(direction: ViewDirection) => void>;
  onTransitionTo: (pos: THREE.Vector3, look: THREE.Vector3) => void;
}): ViewCubeHandle {
  if (!cubeHost) {
    return { render: () => {}, dispose: () => {} };
  }

  const cubeRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  cubeRenderer.setSize(110, 110);
  cubeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  cubeRenderer.setClearColor(0x000000, 0);
  cubeHost.appendChild(cubeRenderer.domElement);

  const cubeScene = new THREE.Scene();
  cubeScene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const cubeLight = new THREE.DirectionalLight(0xffffff, 1.2);
  cubeLight.position.set(4, -5, 6);
  cubeScene.add(cubeLight);

  const cubeCamera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  cubeCamera.up.set(0, 0, 1);

  const materials = [
    createCubeMaterial("RIGHT"),
    createCubeMaterial("LEFT"),
    createCubeMaterial("BACK"),
    createCubeMaterial("FRONT"),
    createCubeMaterial("TOP"),
    createCubeMaterial("BOTTOM"),
  ];

  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const cubeMesh = new THREE.Mesh(geometry, materials);
  cubeScene.add(cubeMesh);

  const cubeEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0xa3a8ac, linewidth: 1 }),
  );
  cubeScene.add(cubeEdges);

  const faceHighlightMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.65, 1.65),
    new THREE.MeshBasicMaterial({
      color: 0x50a6ff,
      transparent: true,
      opacity: 0.45,
      depthTest: false,
    }),
  );
  faceHighlightMesh.visible = false;
  faceHighlightMesh.renderOrder = 999;
  cubeScene.add(faceHighlightMesh);

  const cornerHighlightMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.55, 0.55),
    new THREE.MeshBasicMaterial({
      color: 0x50a6ff,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
    }),
  );
  cornerHighlightMesh.visible = false;
  cornerHighlightMesh.renderOrder = 999;
  cubeScene.add(cornerHighlightMesh);

  const compassCanvas = document.createElement("canvas");
  compassCanvas.width = 512;
  compassCanvas.height = 512;
  const cCtx = compassCanvas.getContext("2d")!;
  cCtx.clearRect(0, 0, 512, 512);
  cCtx.beginPath();
  cCtx.arc(256, 256, 222, 0, Math.PI * 2);
  cCtx.lineWidth = 30;
  cCtx.strokeStyle = "rgba(70, 76, 82, 0.68)";
  cCtx.stroke();

  cCtx.beginPath();
  cCtx.arc(256, 256, 198, 0, Math.PI * 2);
  cCtx.lineWidth = 1.5;
  cCtx.strokeStyle = "rgba(255, 255, 255, 0.4)";
  cCtx.stroke();

  cCtx.shadowColor = "rgba(0, 0, 0, 0.28)";
  cCtx.shadowBlur = 4;
  cCtx.fillStyle = "#ffffff";
  cCtx.font = "bold 44px 'Segoe UI', Arial, sans-serif";
  cCtx.textAlign = "center";
  cCtx.textBaseline = "middle";
  cCtx.fillText("N", 256, 256 - 222);
  cCtx.fillText("S", 256, 256 + 222);
  cCtx.fillText("E", 256 + 222, 256);
  cCtx.fillText("W", 256 - 222, 256);

  const compassTexture = new THREE.CanvasTexture(compassCanvas);
  compassTexture.anisotropy = 4;
  const compassMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(4.3, 4.3),
    new THREE.MeshBasicMaterial({
      map: compassTexture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  compassMesh.position.z = -1.02;
  cubeScene.add(compassMesh);

  const cornerGeom = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const cornerMat = new THREE.MeshBasicMaterial({
    color: 0x9fbcd1,
    transparent: true,
    opacity: 0.01,
  });

  const corners: {
    mesh: THREE.Mesh;
    view: "tfr" | "tfl" | "tbr" | "tbl" | "bfr" | "bfl" | "bbr" | "bbl";
  }[] = [
    { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "tfr" },
    { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "tfl" },
    { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "tbr" },
    { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "tbl" },
    { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "bfr" },
    { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "bfl" },
    { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "bbr" },
    { mesh: new THREE.Mesh(cornerGeom, cornerMat), view: "bbl" },
  ];

  corners[0].mesh.position.set(0.78, -0.78, 0.78);
  corners[1].mesh.position.set(-0.78, -0.78, 0.78);
  corners[2].mesh.position.set(0.78, 0.78, 0.78);
  corners[3].mesh.position.set(-0.78, 0.78, 0.78);
  corners[4].mesh.position.set(0.78, -0.78, -0.78);
  corners[5].mesh.position.set(-0.78, -0.78, -0.78);
  corners[6].mesh.position.set(0.78, 0.78, -0.78);
  corners[7].mesh.position.set(-0.78, 0.78, -0.78);

  for (const c of corners) cubeScene.add(c.mesh);

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  const updateHighlightByRay = () => {
    raycaster.setFromCamera(mouse, cubeCamera);

    for (const c of corners) {
      if (raycaster.intersectObject(c.mesh).length > 0) {
        cornerHighlightMesh.position.copy(c.mesh.position);
        cornerHighlightMesh.visible = true;
        faceHighlightMesh.visible = false;
        return;
      }
    }
    cornerHighlightMesh.visible = false;

    const intersects = raycaster.intersectObject(cubeMesh);
    if (intersects.length > 0 && intersects[0].face) {
      const index = Math.floor(intersects[0].face.materialIndex);
      faceHighlightMesh.position.set(0, 0, 0);
      faceHighlightMesh.rotation.set(0, 0, 0);
      if (index === 0) {
        faceHighlightMesh.position.set(1.01, 0, 0);
        faceHighlightMesh.rotation.y = Math.PI / 2;
      } else if (index === 1) {
        faceHighlightMesh.position.set(-1.01, 0, 0);
        faceHighlightMesh.rotation.y = -Math.PI / 2;
      } else if (index === 2) {
        faceHighlightMesh.position.set(0, 1.01, 0);
        faceHighlightMesh.rotation.x = -Math.PI / 2;
      } else if (index === 3) {
        faceHighlightMesh.position.set(0, -1.01, 0);
        faceHighlightMesh.rotation.x = Math.PI / 2;
      } else if (index === 4) {
        faceHighlightMesh.position.set(0, 0, 1.01);
      } else if (index === 5) {
        faceHighlightMesh.position.set(0, 0, -1.01);
        faceHighlightMesh.rotation.x = Math.PI;
      }
      faceHighlightMesh.visible = true;
      return;
    }
    faceHighlightMesh.visible = false;
  };

  const onCubeMouseMove = (event: MouseEvent) => {
    const rect = cubeRenderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    updateHighlightByRay();
  };

  const onCubeMouseLeave = () => {
    faceHighlightMesh.visible = false;
    cornerHighlightMesh.visible = false;
  };

  const onCubeClick = (event: MouseEvent) => {
    const rect = cubeRenderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, cubeCamera);
    const bounds = modelRef.current?.bounds;

    for (const c of corners) {
      if (raycaster.intersectObject(c.mesh).length > 0) {
        if (bounds) {
          const target = computeCameraPreset(bounds, camera.fov, c.view);
          onTransitionTo(target.pos, target.center);
        } else {
          setViewRef.current(c.view);
        }
        return;
      }
    }

    const intersects = raycaster.intersectObject(cubeMesh);
    if (intersects.length > 0 && intersects[0].face) {
      const index = Math.floor(intersects[0].face.materialIndex);
      const viewMap: ViewDirection[] = [
        "right",
        "left",
        "back",
        "front",
        "top",
        "bottom",
      ];
      const view = viewMap[index] || "iso";
      if (bounds) {
        const target = computeCameraPreset(bounds, camera.fov, view);
        onTransitionTo(target.pos, target.center);
      } else {
        setViewRef.current(view);
      }
    }
  };

  cubeRenderer.domElement.addEventListener("mousemove", onCubeMouseMove);
  cubeRenderer.domElement.addEventListener("mouseleave", onCubeMouseLeave);
  cubeRenderer.domElement.addEventListener("click", onCubeClick);

  return {
    render: (mainCamera, mainControls) => {
      const dir = mainCamera.position.clone().sub(mainControls.target).normalize();
      // Hide the bottom compass ring when orbiting underneath so the BOTTOM face stays unobstructed.
      compassMesh.visible = dir.z >= -0.15;
      cubeCamera.position.copy(dir.multiplyScalar(6.2));
      cubeCamera.lookAt(0, 0, 0);
      cubeRenderer.render(cubeScene, cubeCamera);
    },
    dispose: () => {
      cubeRenderer.domElement.removeEventListener("mousemove", onCubeMouseMove);
      cubeRenderer.domElement.removeEventListener("mouseleave", onCubeMouseLeave);
      cubeRenderer.domElement.removeEventListener("click", onCubeClick);
      if (cubeRenderer.domElement.parentElement === cubeHost) {
        cubeHost.removeChild(cubeRenderer.domElement);
      }
      cubeRenderer.dispose();
    },
  };
}
