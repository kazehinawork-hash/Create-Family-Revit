import * as THREE from "three";

/** Geometry flattened into typed arrays so it can cross the worker boundary. */
export interface SerializedGeometry {
  positions: Float32Array;
  normals: Float32Array | null;
  index: Uint32Array | null;
  edgeMid?: Float32Array | null;
  normalA?: Float32Array | null;
  normalB?: Float32Array | null;
}

export function serializeGeometry(geometry: THREE.BufferGeometry): SerializedGeometry {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const normal = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const index = geometry.getIndex();
  const edgeMid = geometry.getAttribute("aEdgeMid") as THREE.BufferAttribute | undefined;
  const normalA = geometry.getAttribute("aNormalA") as THREE.BufferAttribute | undefined;
  const normalB = geometry.getAttribute("aNormalB") as THREE.BufferAttribute | undefined;

  return {
    positions: new Float32Array(position.array as ArrayLike<number>),
    normals: normal ? new Float32Array(normal.array as ArrayLike<number>) : null,
    index: index ? new Uint32Array(index.array as ArrayLike<number>) : null,
    ...(edgeMid ? { edgeMid: new Float32Array(edgeMid.array as ArrayLike<number>) } : {}),
    ...(normalA ? { normalA: new Float32Array(normalA.array as ArrayLike<number>) } : {}),
    ...(normalB ? { normalB: new Float32Array(normalB.array as ArrayLike<number>) } : {}),
  };
}

export function deserializeGeometry(data: SerializedGeometry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  if (data.normals) geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  if (data.index) geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
  if (data.edgeMid) geometry.setAttribute("aEdgeMid", new THREE.BufferAttribute(data.edgeMid, 3));
  if (data.normalA) geometry.setAttribute("aNormalA", new THREE.BufferAttribute(data.normalA, 3));
  if (data.normalB) geometry.setAttribute("aNormalB", new THREE.BufferAttribute(data.normalB, 3));
  return geometry;
}

export function geometryTransferables(data: SerializedGeometry): ArrayBuffer[] {
  return [
    data.positions.buffer,
    data.normals?.buffer,
    data.index?.buffer,
    data.edgeMid?.buffer,
    data.normalA?.buffer,
    data.normalB?.buffer,
  ].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
}
