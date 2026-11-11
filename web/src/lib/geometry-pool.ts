import * as THREE from "three";
import type { ResolvedPart } from "@family/spec-core";
import { deserializeGeometry, type SerializedGeometry } from "./geometry-transfer";
import {
  buildPartGeometry,
  csgEdgeGeometry,
  type PreviewQuality,
} from "./three-build";

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

let workers: Worker[] | null | undefined;
let workerIndex = 0;
let nextId = 1;
const waiting = new Map<
  number,
  { resolve: (value: BuiltPartGeometry) => void; reject: (error: Error) => void }
>();

function rejectAll(error: Error) {
  for (const entry of waiting.values()) entry.reject(error);
  waiting.clear();
}

function handleReply(event: MessageEvent<WorkerReply>) {
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
}

function getWorkers(): Worker[] | null {
  if (workers !== undefined) return workers;

  if (typeof Worker === "undefined") {
    workers = null;
    return null;
  }

  try {
    const hardware = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
    const size = Math.min(3, Math.max(1, hardware - 1));
    const pool: Worker[] = [];

    for (let index = 0; index < size; index += 1) {
      const instance = new Worker(new URL("./geometry.worker.ts", import.meta.url), {
        type: "module",
      });
      instance.onmessage = handleReply;
      instance.onerror = () => {
        workers = null;
        rejectAll(new Error("geometry worker crashed"));
      };
      pool.push(instance);
    }

    workers = pool;
  } catch {
    workers = null;
  }

  return workers;
}

function buildSync(part: ResolvedPart, quality: PreviewQuality): BuiltPartGeometry {
  const { geometry, hasCuts, cutFailed } = buildPartGeometry(part, quality);
  const edges = hasCuts
    ? csgEdgeGeometry(geometry, 24)
    : new THREE.EdgesGeometry(geometry, 24);
  return { geometry, edges, hasCuts, cutFailed };
}

/**
 * Builds a part off the main thread. A small worker pool lets large assemblies
 * use more than one core, while the viewer still adds completed parts in order.
 * Falls back to a synchronous build when workers are unavailable.
 */
export async function buildPartGeometryAsync(
  part: ResolvedPart,
  quality: PreviewQuality = "high",
): Promise<BuiltPartGeometry> {
  const pool = getWorkers();
  if (!pool || pool.length === 0) return buildSync(part, quality);
  const instance = pool[workerIndex++ % pool.length];

  const id = nextId++;

  try {
    return await new Promise<BuiltPartGeometry>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      try {
        instance.postMessage({ id, part, quality });
      } catch (error) {
        waiting.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } catch {
    // A dead worker should not block the viewer: finish this part synchronously.
    return buildSync(part, quality);
  }
}
