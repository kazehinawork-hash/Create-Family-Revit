import * as THREE from "three";

/** Geometry flattened into typed arrays so it can cross the worker boundary. */
export interface SerializedGeometry {
  positions: Float32Array;
  normals: Float32Array | null;
  index: Uint32Array | null;
}

export function serializeGeometry(geometry: THREE.BufferGeometry): SerializedGeometry {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const normal = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const index = geometry.getIndex();

  return {
    positions: new Float32Array(position.array as ArrayLike<number>),
    normals: normal ? new Float32Array(normal.array as ArrayLike<number>) : null,
    index: index ? new Uint32Array(index.array as ArrayLike<number>) : null,
  };
}

export function deserializeGeometry(data: SerializedGeometry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  if (data.normals) geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  if (data.index) geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
  return geometry;
}

export function geometryTransferables(data: SerializedGeometry): ArrayBuffer[] {
  return [data.positions.buffer, data.normals?.buffer, data.index?.buffer].filter(
    (buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer,
  );
}
