import type { ResolvedPart } from "@family/spec-core";
import { geometryTransferables, serializeGeometry } from "./geometry-transfer";
import { buildPartGeometry, extractPartEdges, type PreviewQuality } from "./three-build";

interface BuildRequest {
  id: number;
  part: ResolvedPart;
  quality?: PreviewQuality;
}

const scope = self as unknown as {
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

self.onmessage = (event: MessageEvent<BuildRequest>) => {
  const { id, part, quality } = event.data;

  try {
    const { geometry, hasCuts, cutFailed } = buildPartGeometry(part, quality);
    const { edges, tangentEdges, smoothEdges } = extractPartEdges(geometry, 24);

    const payload = {
      id,
      ok: true as const,
      geometry: serializeGeometry(geometry),
      edges: serializeGeometry(edges),
      tangentEdges: serializeGeometry(tangentEdges),
      smoothEdges: serializeGeometry(smoothEdges),
      hasCuts,
      cutFailed,
    };

    // The source geometries are not needed after serialisation: the main thread only
    // receives typed arrays, so dispose them here instead of leaking worker memory.
    geometry.dispose();
    edges.dispose();
    tangentEdges.dispose();
    smoothEdges.dispose();

    scope.postMessage(payload, [
      ...geometryTransferables(payload.geometry),
      ...geometryTransferables(payload.edges),
      ...geometryTransferables(payload.tangentEdges),
      ...geometryTransferables(payload.smoothEdges),
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
