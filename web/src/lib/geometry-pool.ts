import * as THREE from "three";
import type { ResolvedPart } from "@family/spec-core";
import { deserializeGeometry, type SerializedGeometry } from "./geometry-transfer";
import { buildPartGeometry, csgEdgeGeometry } from "./three-build";

export interface BuiltPartGeometry {
  geometry: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
  hasCuts: boolean;
  cutFailed: boolean;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  geometry?: SerializedGeometry;
  edges?: SerializedGeometry;
  hasCuts?: boolean;
  cutFailed?: boolean;
  error?: string;
}

let worker: Worker | null | undefined;
let nextId = 1;
const waiting = new Map<
  number,
  { resolve: (value: BuiltPartGeometry) => void; reject: (error: Error) => void }
>();

function rejectAll(error: Error) {
  for (const entry of waiting.values()) entry.reject(error);
  waiting.clear();
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;

  if (typeof Worker === "undefined") {
    worker = null;
    return null;
  }

  try {
    const instance = new Worker(new URL("./geometry.worker.ts", import.meta.url), {
      type: "module",
    });

    instance.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      const entry = waiting.get(reply.id);
      if (!entry) return;
      waiting.delete(reply.id);

      if (!reply.ok || !reply.geometry || !reply.edges) {
        entry.reject(new Error(reply.error || "geometry worker failed"));
        return;
      }

      entry.resolve({
        geometry: deserializeGeometry(reply.geometry),
        edges: deserializeGeometry(reply.edges),
        hasCuts: Boolean(reply.hasCuts),
        cutFailed: Boolean(reply.cutFailed),
      });
    };

    instance.onerror = () => {
      worker = null;
      rejectAll(new Error("geometry worker crashed"));
    };

    worker = instance;
  } catch {
    worker = null;
  }

  return worker;
}

function buildSync(part: ResolvedPart): BuiltPartGeometry {
  const { geometry, hasCuts, cutFailed } = buildPartGeometry(part);
  const edges = hasCuts
    ? csgEdgeGeometry(geometry, 24)
    : new THREE.EdgesGeometry(geometry, 24);
  return { geometry, edges, hasCuts, cutFailed };
}

/**
 * Builds a part off the main thread. Falls back to a synchronous build when the
 * worker cannot start (SSR, tests, an old browser) so the viewer keeps working.
 */
export async function buildPartGeometryAsync(part: ResolvedPart): Promise<BuiltPartGeometry> {
  const instance = getWorker();
  if (!instance) return buildSync(part);

  const id = nextId++;

  try {
    return await new Promise<BuiltPartGeometry>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      try {
        instance.postMessage({ id, part });
      } catch (error) {
        waiting.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } catch {
    worker = null;
    return buildSync(part);
  }
}
