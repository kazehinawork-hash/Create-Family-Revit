import type { FamilyParameter, ResolvedModel, ResolvedPart } from "@family/spec-core";
import * as THREE from "three";
import { buildPartGeometry } from "../../lib/three-build";
import type { Units } from "../../lib/format";
import type { SceneState, ViewDirection } from "./types";

/**
 * Cross-section of the model bounds at a plane, ordered around the centroid.
 * Used to draw the section outline exactly where it cuts the model (Dalux style).
 */
export function planeCrossSection(
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
export function snapToAxis(
  from: THREE.Vector3,
  to: THREE.Vector3,
  maxAngleDeg = 10,
): { point: THREE.Vector3; axis: "X" | "Y" | "Z" | null } {
  const delta = to.clone().sub(from);
  const length = delta.length();
  if (length < 1e-3) return { point: to.clone(), axis: null };

  const direction = delta.divideScalar(length);
  const candidates: ["X" | "Y" | "Z", number][] = [
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

export function createInfiniteGrid(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uMinorColor: { value: new THREE.Color(0xb8b0a5) },
      uMajorColor: { value: new THREE.Color(0x8f877d) },
      uMinorOpacity: { value: 0.22 },
      uMajorOpacity: { value: 0.34 },
      uFadeStart: { value: 6000 },
      uFadeEnd: { value: 36000 },
      uCamera: { value: new THREE.Vector3() },
      uProj: { value: new THREE.Matrix4() },
      uInvProj: { value: new THREE.Matrix4() },
      uCameraWorld: { value: new THREE.Matrix4() },
      uGridZ: { value: -0.05 },
    },
    vertexShader: `
      out vec2 vNdc;
      void main() {
        vNdc = position.xy;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform vec3 uMinorColor;
      uniform vec3 uMajorColor;
      uniform float uMinorOpacity;
      uniform float uMajorOpacity;
      uniform float uFadeStart;
      uniform float uFadeEnd;
      uniform vec3 uCamera;
      uniform mat4 uProj;
      uniform mat4 uInvProj;
      uniform mat4 uCameraWorld;
      uniform float uGridZ;

      in vec2 vNdc;
      out vec4 fragColor;

      float gridLine(vec2 world, vec2 worldRel, float spacing) {
        vec2 coord = world / spacing;
        vec2 derivative = max(fwidth(worldRel / spacing), vec2(1e-5));
        vec2 grid = abs(fract(coord - 0.5) - 0.5) / derivative;
        float line = 1.0 - smoothstep(0.0, 1.2, min(grid.x, grid.y));
        // Fade out sub-pixel frequency lines near the horizon to prevent aliasing bands.
        float aa = 1.0 - smoothstep(0.3, 0.8, max(derivative.x, derivative.y));
        return line * aa;
      }

      void main() {
        // Sample NDC z = -1 and z = 0 (near and ~2*near in clip space) so the ray step
        // stays small near the camera and avoids 2 km triangle interpolation loss.
        vec4 p0 = uInvProj * vec4(vNdc, -1.0, 1.0);
        p0 /= p0.w;
        vec4 p1 = uInvProj * vec4(vNdc, 0.0, 1.0);
        p1 /= p1.w;

        mat3 camRot = mat3(uCameraWorld);
        vec3 rayOrigin = camRot * p0.xyz;
        vec3 rayStep = camRot * (p1.xyz - p0.xyz);

        float dz = uGridZ - uCamera.z;
        float safeStepZ = abs(rayStep.z) < 1e-7 ? (rayStep.z < 0.0 ? -1e-7 : 1e-7) : rayStep.z;
        float t = (dz - rayOrigin.z) / safeStepZ;

        vec3 hitCam = p0.xyz + max(t, 0.0) * (p1.xyz - p0.xyz);
        vec4 clipPos = uProj * vec4(hitCam, 1.0);
        float ndcDepth = clipPos.z / clipPos.w;
        bool hit = abs(rayStep.z) >= 1e-7 && t >= 0.0 && ndcDepth > -1.0 && ndcDepth < 1.0;

        float maxSteps = max(uFadeEnd * 1.25, 100.0) / max(length(rayStep), 1e-4);
        float tGrad = clamp(t, 0.0, maxSteps);
        vec2 worldRel = rayOrigin.xy + tGrad * rayStep.xy;
        vec2 world = uCamera.xy + worldRel;

        float footprint = max(fwidth(worldRel.x), fwidth(worldRel.y));
        float target = max(10.0, footprint * 64.0);
        float level = clamp(log(target / 10.0) / log(10.0), 0.0, 3.0);
        float exponent = floor(level);
        float blend = fract(level);
        float base = 10.0 * pow(10.0, exponent);

        float minor = mix(
          gridLine(world, worldRel, base),
          gridLine(world, worldRel, base * 10.0),
          blend
        );
        float major = mix(
          gridLine(world, worldRel, base * 5.0),
          gridLine(world, worldRel, base * 50.0),
          blend
        );

        if (!hit) discard;

        gl_FragDepth = ((gl_DepthRange.diff * ndcDepth) + gl_DepthRange.near + gl_DepthRange.far) * 0.5;

        float distanceToCamera = length(worldRel);
        float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, distanceToCamera);
        float alpha = max(minor * uMinorOpacity, major * uMajorOpacity) * fade;
        if (alpha < 0.002) discard;

        fragColor = vec4(mix(uMinorColor, uMajorColor, major), alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  grid.position.z = -0.05;
  grid.renderOrder = -2;
  grid.frustumCulled = false;
  grid.raycast = () => {};
  grid.onBeforeRender = (_renderer, _scene, camera) => {
    material.uniforms.uProj.value.copy(camera.projectionMatrix);
    material.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    material.uniforms.uCameraWorld.value.copy(camera.matrixWorld);
    material.uniforms.uCamera.value.setFromMatrixPosition(camera.matrixWorld);
    material.uniforms.uGridZ.value = grid.position.z;
  };
  return grid;
}

export function createSectionCap(): THREE.Mesh {
  const sectionCap = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      vertexShader: `
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        void main() {
          vec3 base = vec3(0.898, 0.878, 0.827);
          vec3 line = vec3(0.549, 0.525, 0.478);
          float stripe = step(0.86, fract((gl_FragCoord.x + gl_FragCoord.y) / 14.0));
          gl_FragColor = vec4(mix(base, line, stripe), 1.0);
        }
      `,
      side: THREE.DoubleSide,
      clipping: false,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
      depthWrite: true,
      depthTest: true,
    }),
  );
  sectionCap.renderOrder = 2;
  sectionCap.visible = false;
  return sectionCap;
}

export function computeCameraPreset(
  bounds: NonNullable<ResolvedModel["bounds"]>,
  fovDeg: number,
  direction: ViewDirection,
): { pos: THREE.Vector3; center: THREE.Vector3; distance: number } {
  const { min, max } = bounds;
  const center = new THREE.Vector3(
    (min.x + max.x) / 2,
    (min.y + max.y) / 2,
    (min.z + max.z) / 2,
  );
  const radius = Math.max(
    new THREE.Vector3(max.x - min.x, max.y - min.y, max.z - min.z).length() / 2,
    120,
  );
  const distance = (radius / Math.sin((fovDeg * Math.PI) / 360)) * 1.15;
  const dCorner = distance * 0.7;

  const offset = new THREE.Vector3();
  switch (direction) {
    case "top":
      offset.set(0, -0.001, distance);
      break;
    case "bottom":
      offset.set(0, -0.001, -distance);
      break;
    case "front":
      offset.set(0, -distance, 0);
      break;
    case "back":
      offset.set(0, distance, 0);
      break;
    case "left":
      offset.set(-distance, 0, 0);
      break;
    case "right":
      offset.set(distance, 0, 0);
      break;
    case "tfr":
    case "iso":
      offset.set(dCorner, -dCorner, dCorner * 0.8);
      break;
    case "tfl":
      offset.set(-dCorner, -dCorner, dCorner * 0.8);
      break;
    case "tbr":
      offset.set(dCorner, dCorner, dCorner * 0.8);
      break;
    case "tbl":
      offset.set(-dCorner, dCorner, dCorner * 0.8);
      break;
    case "bfr":
      offset.set(dCorner, -dCorner, -dCorner * 0.5);
      break;
    case "bfl":
      offset.set(-dCorner, -dCorner, -dCorner * 0.5);
      break;
    case "bbr":
      offset.set(dCorner, dCorner, -dCorner * 0.5);
      break;
    case "bbl":
      offset.set(-dCorner, dCorner, -dCorner * 0.5);
      break;
    default:
      offset.set(distance * 0.7, -distance * 0.7, distance * 0.55);
      break;
  }
  return { pos: center.clone().add(offset), center, distance };
}

export function captureViewerThumbnail(
  state: SceneState | null,
  currentModel: ResolvedModel | null,
  markDirty: () => void,
  prepareDefaultRender?: () => () => void,
): string | null {
  if (!state || !currentModel?.bounds) return null;

  const wasVisible = {
    grid: state.grid.visible,
    refPlanes: state.refPlanesGroup.visible,
    connectors: state.connectorsGroup.visible,
    handles: state.handlesGroup.visible,
  };

  const width = 480;
  const height = 270;
  const previousSize = new THREE.Vector2();
  state.renderer.getSize(previousSize);
  const previousPixelRatio = state.renderer.getPixelRatio();
  const previousPosition = state.camera.position.clone();
  const previousQuaternion = state.camera.quaternion.clone();
  const previousAspect = state.camera.aspect;
  const previousNear = state.camera.near;
  const previousFar = state.camera.far;
  const previousTarget = state.controls.target.clone();
  const previousBackground = state.scene.background;

  let image: string | null = null;
  const restoreStyle = prepareDefaultRender?.();
  try {
    state.grid.visible = false;
    state.refPlanesGroup.visible = false;
    state.connectorsGroup.visible = false;
    state.handlesGroup.visible = false;
    state.scene.background = new THREE.Color(0xf4f2ec);

    state.renderer.setPixelRatio(1);
    state.renderer.setSize(width, height, false);

    const { min, max } = currentModel.bounds;
    const center = new THREE.Vector3(
      (min.x + max.x) / 2,
      (min.y + max.y) / 2,
      (min.z + max.z) / 2,
    );
    const radius = Math.max(
      new THREE.Vector3(max.x - min.x, max.y - min.y, max.z - min.z).length() / 2,
      60,
    );
    const verticalFov = (state.camera.fov * Math.PI) / 180;
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * (width / height));
    const fitFov = Math.min(verticalFov, horizontalFov);
    const distance = (radius / Math.sin(fitFov / 2)) * 1.18;

    state.camera.up.set(0, 0, 1);
    state.camera.aspect = width / height;
    state.camera.near = Math.max(0.1, distance - radius * 4);
    state.camera.far = distance + radius * 6;
    state.camera.position
      .copy(center)
      .addScaledVector(new THREE.Vector3(0.7, -0.7, 0.56).normalize(), distance);
    state.camera.lookAt(center);
    state.camera.updateProjectionMatrix();

    state.renderer.shadowMap.needsUpdate = true;
    state.renderer.render(state.scene, state.camera);
    const source = state.renderer.domElement;

    const off = document.createElement("canvas");
    off.width = width;
    off.height = height;
    const context = off.getContext("2d");
    if (context && source.width && source.height) {
      context.fillStyle = "#f4f2ec";
      context.fillRect(0, 0, width, height);
      context.drawImage(source, 0, 0, source.width, source.height, 0, 0, width, height);

      const pixels = context.getImageData(0, 0, width, height).data;
      let sum = 0;
      let sumSquares = 0;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 16) {
        const luminance =
          0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
        sum += luminance;
        sumSquares += luminance * luminance;
        count += 1;
      }
      const mean = sum / Math.max(1, count);
      const deviation = Math.sqrt(Math.max(0, sumSquares / Math.max(1, count) - mean * mean));
      image = deviation < 6 ? null : off.toDataURL("image/jpeg", 0.86);
    }
  } catch {
    image = null;
  } finally {
    restoreStyle?.();
    state.grid.visible = wasVisible.grid;
    state.refPlanesGroup.visible = wasVisible.refPlanes;
    state.connectorsGroup.visible = wasVisible.connectors;
    state.handlesGroup.visible = wasVisible.handles;

    state.renderer.setPixelRatio(previousPixelRatio);
    state.renderer.setSize(previousSize.x, previousSize.y, false);
    state.camera.position.copy(previousPosition);
    state.camera.quaternion.copy(previousQuaternion);
    state.camera.aspect = previousAspect;
    state.camera.near = previousNear;
    state.camera.far = previousFar;
    state.camera.updateProjectionMatrix();
    state.controls.target.copy(previousTarget);
    state.controls.update();
    state.scene.background = previousBackground;
    state.renderer.shadowMap.needsUpdate = true;
    markDirty();
  }

  return image;
}

export function buildDimensionsGroup(
  bounds: NonNullable<ResolvedModel["bounds"]>,
  camera: THREE.PerspectiveCamera | undefined,
  units: Units,
  formatNumber: (n: number) => string,
): THREE.Group {
  const { min, max, size } = bounds;
  const group = new THREE.Group();
  const extent = Math.max(size.x, size.y, size.z, 400);
  const offset = extent * 0.1;
  const material = new THREE.LineBasicMaterial({ color: 0x2f6feb, depthTest: false });

  const addLine = (from: [number, number, number], to: [number, number, number]) => {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...from),
      new THREE.Vector3(...to),
    ]);
    group.add(new THREE.Line(geometry, material));
  };

  const addLabel = (text: string, x: number, y: number, z: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "rgba(255,255,255,0.92)";
    context.fillRect(0, 0, 256, 64);
    context.strokeStyle = "#2f6feb";
    context.lineWidth = 3;
    context.strokeRect(2, 2, 252, 60);
    context.fillStyle = "#1f2328";
    context.font = "bold 30px 'Segoe UI', Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 128, 34);

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        depthTest: false,
      }),
    );
    const height = extent * 0.05;
    sprite.scale.set(height * (256 / 64), height, 1);
    sprite.position.set(x, y, z);
    group.add(sprite);
  };

  const middle = new THREE.Vector3(
    (min.x + max.x) / 2,
    (min.y + max.y) / 2,
    (min.z + max.z) / 2,
  );
  const view = camera ? camera.position.clone().sub(middle) : new THREE.Vector3(1, -1, 1);
  const sx = view.x >= 0 ? 1 : -1;
  const sy = view.y >= 0 ? 1 : -1;
  const sz = view.z >= 0 ? 1 : -1;
  const nearY = sy > 0 ? max.y : min.y;
  const nearX = sx > 0 ? max.x : min.x;
  const nearZ = sz > 0 ? max.z : min.z;

  const xLineY = nearY + sy * offset;
  const xLineZ = nearZ + sz * offset * 0.2;
  addLine([min.x, xLineY, xLineZ], [max.x, xLineY, xLineZ]);
  addLine([min.x, nearY, xLineZ], [min.x, xLineY, xLineZ]);
  addLine([max.x, nearY, xLineZ], [max.x, xLineY, xLineZ]);
  addLabel(
    `${formatNumber(Math.round(size.x))} ${units}`,
    (min.x + max.x) / 2,
    xLineY,
    xLineZ + sz * offset * 0.35,
  );

  const yLineX = nearX + sx * offset;
  const yLineZ = nearZ + sz * offset * 0.2;
  addLine([yLineX, min.y, yLineZ], [yLineX, max.y, yLineZ]);
  addLine([nearX, min.y, yLineZ], [yLineX, min.y, yLineZ]);
  addLine([nearX, max.y, yLineZ], [yLineX, max.y, yLineZ]);
  addLabel(
    `${formatNumber(Math.round(size.y))} ${units}`,
    yLineX + sx * offset * 0.35,
    (min.y + max.y) / 2,
    yLineZ,
  );

  const zLineX = nearX + sx * offset;
  const zLineY = nearY + sy * offset;
  addLine([zLineX, zLineY, min.z], [zLineX, zLineY, max.z]);
  addLine([nearX, zLineY, min.z], [zLineX, zLineY, min.z]);
  addLine([nearX, zLineY, max.z], [zLineX, zLineY, max.z]);
  addLabel(
    `${formatNumber(Math.round(size.z))} ${units}`,
    zLineX + sx * offset * 0.35,
    zLineY,
    (min.z + max.z) / 2,
  );

  return group;
}

export function buildGhostCutsGroup(
  model: ResolvedModel,
  skippedCutPartIds: string[],
): THREE.Group {
  const material = new THREE.LineDashedMaterial({
    color: 0xd28a00,
    dashSize: 10,
    gapSize: 6,
    depthTest: false,
  });
  const group = new THREE.Group();

  for (const part of model.parts) {
    if (!skippedCutPartIds.includes(part.id)) continue;
    for (const cut of part.cuts ?? []) {
      let base: THREE.BufferGeometry | null = null;
      const position = new THREE.Vector3();

      if (cut.kind === "box") {
        base = new THREE.BoxGeometry(
          Math.abs(cut.size.x) || 1,
          Math.abs(cut.size.y) || 1,
          Math.abs(cut.size.z) || 1,
        );
        position.set(cut.origin.x, cut.origin.y, cut.origin.z);
      } else if (cut.kind === "cylinder") {
        const height = Math.abs(cut.height) || 1;
        const radius = Math.abs(cut.radius) || 1;
        base = new THREE.CylinderGeometry(radius, radius, height, 24);
        const axis = cut.axis ?? "z";
        if (axis === "x") base.rotateZ(Math.PI / 2);
        else if (axis === "z") base.rotateX(Math.PI / 2);
        position.set(cut.base.x, cut.base.y, cut.base.z);
        const direction = Math.sign(cut.height) || 1;
        if (axis === "x") position.x += (direction * height) / 2;
        else if (axis === "y") position.y += (direction * height) / 2;
        else position.z += (direction * height) / 2;
      }

      if (!base) continue;
      const edges = new THREE.EdgesGeometry(base);
      base.dispose();
      const line = new THREE.LineSegments(edges, material);
      line.computeLineDistances();
      line.position.copy(position);
      line.renderOrder = 3;
      group.add(line);
    }
  }

  return group;
}

export function populatePartHandles(
  state: SceneState,
  selectedPart: ResolvedPart,
  parameters: FamilyParameter[],
): void {
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
    const scaleFactor = Math.min(1.0, Math.max(0.18, minDimension / 500));

    const partNameKeywords = selectedPart.name.toLowerCase().split(/\s+/);
    const findParamForPartAxis = (
      axisKeywords: string[],
      fallbackName: string,
      fallbackVal: number,
    ) => {
      const exactMatch = parameters.find(
        (p) =>
          partNameKeywords.some((pk) => pk.length > 2 && p.name.toLowerCase().includes(pk)) &&
          axisKeywords.some((ak) => p.name.toLowerCase().includes(ak.toLowerCase())) &&
          typeof p.value === "number",
      );
      if (exactMatch && typeof exactMatch.value === "number") {
        return { name: exactMatch.name, val: exactMatch.value };
      }
      const axisMatch = parameters.find(
        (p) =>
          axisKeywords.some((ak) => p.name.toLowerCase().includes(ak.toLowerCase())) &&
          typeof p.value === "number",
      );
      return {
        name: axisMatch ? axisMatch.name : fallbackName,
        val: axisMatch && typeof axisMatch.value === "number" ? axisMatch.value : fallbackVal,
      };
    };

    const xParam = findParamForPartAxis(
      ["length", "width", "od", "diameter", "radius"],
      `${selectedPart.name} X`,
      sizeX,
    );
    const yParam = findParamForPartAxis(
      ["depth", "width", "od", "diameter", "radius"],
      `${selectedPart.name} Y`,
      sizeY,
    );
    const zParam = findParamForPartAxis(
      ["height", "thickness", "length"],
      `${selectedPart.name} Z`,
      sizeZ,
    );

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

      const stemGeom = new THREE.CylinderGeometry(
        11 * scaleFactor,
        11 * scaleFactor,
        arrowLength,
        12,
      );
      stemGeom.translate(0, arrowLength / 2, 0);

      const handleMat = new THREE.MeshStandardMaterial({
        color: 0x0078d4,
        roughness: 0.2,
        metalness: 0.2,
        depthTest: false,
      });
      state.disposables.push(coneGeom, stemGeom, handleMat);

      const coneMesh = new THREE.Mesh(coneGeom, handleMat);
      const stemMesh = new THREE.Mesh(stemGeom, handleMat);
      coneMesh.renderOrder = 999;
      stemMesh.renderOrder = 999;

      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dir.clone().normalize(),
      );
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

    createShapeHandle(new THREE.Vector3(pBox.max.x, center.y, center.z), new THREE.Vector3(1, 0, 0), "x", 1, xParam);
    createShapeHandle(new THREE.Vector3(pBox.min.x, center.y, center.z), new THREE.Vector3(-1, 0, 0), "x", -1, xParam);
    createShapeHandle(new THREE.Vector3(center.x, pBox.max.y, center.z), new THREE.Vector3(0, 1, 0), "y", 1, yParam);
    createShapeHandle(new THREE.Vector3(center.x, pBox.min.y, center.z), new THREE.Vector3(0, -1, 0), "y", -1, yParam);
    createShapeHandle(new THREE.Vector3(center.x, center.y, pBox.max.z), new THREE.Vector3(0, 0, 1), "z", 1, zParam);
  }
  partGeom.dispose();
}

export function populateRefPlanes(
  state: SceneState,
  bounds: NonNullable<ResolvedModel["bounds"]>,
  parameters: FamilyParameter[],
): void {
  const modelExtent = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 400);
  const planeExtent = modelExtent * 1.4;
  const halfExt = planeExtent / 2;

  const refLineMat = new THREE.LineDashedMaterial({
    color: 0x2e8540,
    dashSize: 45,
    gapSize: 25,
    linewidth: 1.5,
    transparent: true,
    opacity: 0.5,
  });
  state.disposables.push(refLineMat);

  const xzGeom = new THREE.PlaneGeometry(planeExtent, planeExtent);
  xzGeom.rotateX(Math.PI / 2);
  const xzOutline = new THREE.LineSegments(new THREE.EdgesGeometry(xzGeom), refLineMat);
  xzOutline.computeLineDistances();
  xzOutline.position.set(0, 0, 0);
  state.refPlanesGroup.add(xzOutline);
  state.disposables.push(xzGeom, xzOutline.geometry);

  const yzGeom = new THREE.PlaneGeometry(planeExtent, planeExtent);
  yzGeom.rotateY(Math.PI / 2);
  const yzOutline = new THREE.LineSegments(new THREE.EdgesGeometry(yzGeom), refLineMat);
  yzOutline.computeLineDistances();
  state.refPlanesGroup.add(yzOutline);
  state.disposables.push(yzGeom, yzOutline.geometry);

  for (const pts of [
    [new THREE.Vector3(-halfExt, 0, 0), new THREE.Vector3(halfExt, 0, 0)],
    [new THREE.Vector3(0, -halfExt, 0), new THREE.Vector3(0, halfExt, 0)],
    [new THREE.Vector3(0, 0, -200), new THREE.Vector3(0, 0, halfExt)],
  ]) {
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geom, refLineMat);
    line.computeLineDistances();
    state.refPlanesGroup.add(line);
    state.disposables.push(geom);
  }

  const centerX = (bounds.min.x + bounds.max.x) / 2;
  const centerY = (bounds.min.y + bounds.max.y) / 2;
  const centerZ = (bounds.min.z + bounds.max.z) / 2;
  const margin = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 300) * 0.12;
  const spanX = Math.max(bounds.size.x + margin * 2, 300);
  const spanY = Math.max(bounds.size.y + margin * 2, 300);
  const spanZ = Math.max(bounds.size.z + margin * 2, 300);

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
    if (parameter.type !== "Length" || parameter.formula) continue;
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
      coordinate = near(bounds.max.x, value) || near(bounds.size.x, value) ? bounds.max.x : centerX + value / 2;
      width = spanY;
      height = spanZ;
      rotate = (geometry) => geometry.rotateY(Math.PI / 2);
      place = (mesh) => mesh.position.set(coordinate, centerY, centerZ);
    } else if (axis === "y") {
      coordinate = near(bounds.max.y, value) || near(bounds.size.y, value) ? bounds.max.y : centerY + value / 2;
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

export function populateConnectors(state: SceneState, model: ResolvedModel): void {
  if (!model.connectors || model.connectors.length === 0) return;

  for (const conn of model.connectors) {
    const connGroup = new THREE.Group();
    connGroup.position.set(conn.origin.x, conn.origin.y, conn.origin.z);

    let colorHex = 0x0969da;
    if (conn.systemType.includes("SupplyAir")) colorHex = 0x1f883d;
    else if (conn.systemType.includes("ReturnAir")) colorHex = 0xd9381e;
    else if (conn.systemType.includes("HydronicSupply")) colorHex = 0x0969da;
    else if (conn.systemType.includes("HydronicReturn")) colorHex = 0xd47600;
    else if (conn.systemType.includes("Sanitary")) colorHex = 0x8250df;

    const arrowDir = new THREE.Vector3(
      conn.directionVector.x,
      conn.directionVector.y,
      conn.directionVector.z,
    ).normalize();

    if (conn.shape === "round") {
      const radius = (conn.diameter || 50) / 2;
      const torusGeom = new THREE.TorusGeometry(radius, 4, 12, 32);
      const torusMat = new THREE.MeshBasicMaterial({ color: colorHex });
      state.disposables.push(torusGeom, torusMat);
      const torus = new THREE.Mesh(torusGeom, torusMat);
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), arrowDir);
      torus.quaternion.copy(quat);
      connGroup.add(torus);
    } else {
      const w = conn.width || 200;
      const h = conn.height || 200;
      const rectGeom = new THREE.BoxGeometry(w, h, 6);
      const rectEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(rectGeom),
        new THREE.LineBasicMaterial({ color: colorHex, linewidth: 2 }),
      );
      state.disposables.push(rectGeom);

      const up = Math.abs(arrowDir.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      const widthAxis = new THREE.Vector3().crossVectors(up, arrowDir).normalize();
      const heightAxis = new THREE.Vector3().crossVectors(arrowDir, widthAxis).normalize();
      const basis = new THREE.Matrix4().makeBasis(widthAxis, heightAxis, arrowDir);
      rectEdges.quaternion.setFromRotationMatrix(basis);
      connGroup.add(rectEdges);
    }

    const arrowLength = 75;
    connGroup.add(new THREE.ArrowHelper(arrowDir, new THREE.Vector3(0, 0, 0), arrowLength, colorHex, 24, 16));

    try {
      const dir = (conn.direction ?? "bidirectional").toLowerCase();
      const dirLabel = dir === "in" ? "IN" : dir === "out" ? "OUT" : "BIDI";
      const isRound = conn.shape !== "rectangular";
      const sizeStr = isRound ? `Ø${conn.diameter ?? 50}` : `${conn.width ?? 200}×${conn.height ?? 200}`;
      const badgeText = `${dirLabel} · ${sizeStr}`;

      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, 256, 64);
        ctx.beginPath();
        ctx.roundRect(4, 4, 248, 56, 14);
        ctx.fillStyle =
          dir === "in"
            ? "rgba(31, 136, 61, 0.92)"
            : dir === "out"
              ? "rgba(207, 34, 46, 0.92)"
              : "rgba(9, 105, 218, 0.92)";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 26px 'Segoe UI', Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(badgeText, 128, 32);
      }

      const texture = new THREE.CanvasTexture(canvas);
      texture.anisotropy = 4;
      const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
      state.disposables.push(texture, spriteMat);
      const sprite = new THREE.Sprite(spriteMat);
      sprite.scale.set(65, 16.25, 1);
      sprite.position.copy(arrowDir).multiplyScalar(arrowLength + 22);
      sprite.renderOrder = 999;
      connGroup.add(sprite);
    } catch {}

    state.connectorsGroup.add(connGroup);
  }
}
