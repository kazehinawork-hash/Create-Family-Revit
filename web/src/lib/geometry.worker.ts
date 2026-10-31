import * as THREE from "three";
import type { ResolvedPart } from "@family/spec-core";
import { geometryTransferables, serializeGeometry } from "./geometry-transfer";
import { buildPartGeometry, csgEdgeGeometry } from "./three-build";

interface BuildRequest {
  id: number;
  part: ResolvedPart;
}

const scope = self as unknown as {
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

self.onmessage = (event: MessageEvent<BuildRequest>) => {
  const { id, part } = event.data;

  try {
    const { geometry, hasCuts, cutFailed } = buildPartGeometry(part);
    const edges = hasCuts
      ? csgEdgeGeometry(geometry, 24)
      : new THREE.EdgesGeometry(geometry, 24);

    const payload = {
      id,
      ok: true as const,
      geometry: serializeGeometry(geometry),
      edges: serializeGeometry(edges),
      hasCuts,
      cutFailed,
    };

    // The source geometries are not needed after serialisation: the main thread only
    // receives typed arrays, so dispose them here instead of leaking worker memory.
    geometry.dispose();
    edges.dispose();

    scope.postMessage(payload, [
      ...geometryTransferables(payload.geometry),
      ...geometryTransferables(payload.edges),
    ]);
  } catch (error) {
    scope.postMessage(
      {
        id,
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      },
      [],
    );
  }
};
