import type { FamilyParameter, MaterialDef, ResolvedModel } from "@family/spec-core";
import type * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ChatTarget, ModelNote, NoteDraft, Vec3Like } from "../../lib/annotations";
import type { Units } from "../../lib/format";

/** Camera presets the ViewCube can request. */
export type ViewDirection =
  | "top"
  | "front"
  | "back"
  | "left"
  | "right"
  | "iso"
  | "tfr"
  | "tfl"
  | "tbr"
  | "tbl"
  | "bfr"
  | "bfl"
  | "bbr"
  | "bbl";

export interface PartCacheEntry {
  geometryKey: string;
  styleKey: string;
  group: THREE.Group;
  meshMaterial: THREE.MeshStandardMaterial;
  edgeMaterial: THREE.LineBasicMaterial;
  /** Stencil helpers that mark the solid part of a section cut. */
  stencilBack?: THREE.Mesh;
  stencilFront?: THREE.Mesh;
  /** Dark back-face shell that makes the outer silhouette read stronger. */
  silhouette?: THREE.Mesh;
  disposables: { dispose: () => void }[];
}

export interface ViewerProps {
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
  /** Add parts to the chat composer from the context menu. */
  onSendPartsToChat?: (targets: ChatTarget[]) => void;
  /** Notes pinned on the model. */
  notes?: ModelNote[];
  onAddNote?: (draft: NoteDraft) => void;
  onFocusNote?: (note: ModelNote) => void;
  focusNote?: ModelNote | null;
  hiddenPartIds?: string[];
  onToggleHidePart?: (partId: string) => void;
  onUnhideAll?: () => void;
  transparentPartIds?: string[];
  onToggleTransparentPart?: (partId: string) => void;
  onResetTransparent?: () => void;
  issuePartIds?: string[];
  highlightPartIds?: string[];
  focusPartId?: string | null;
  onUpdateParameter?: (name: string, value: number) => void;
  /** Empty-state suggestion: start a sample family. */
  onLoadSample?: () => void;
  /** Hands the parent a function that renders and returns a 320px JPEG snapshot. */
  onCaptureReady?: (capture: (() => string | null) | null) => void;
  /** File name used when exporting the current view as PNG. */
  fileName?: string;
  /** Parts whose cuts the add-in will skip (thin prism): drawn as dashed ghosts. */
  skippedCutPartIds?: string[];
  theme?: "light" | "dark";
}

export interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  handlesGroup: THREE.Group;
  grid: THREE.Mesh;
  refPlanesGroup: THREE.Group;
  connectorsGroup: THREE.Group;
  key: THREE.DirectionalLight;
  shadowPlane: THREE.Mesh;
  disposables: { dispose: () => void }[];
}

export interface ActiveHandleState {
  label: string;
  value: number;
  screenX: number;
  screenY: number;
}

export interface ContextMenuState {
  partId: string;
  partName: string;
  x: number;
  y: number;
  normal: THREE.Vector3 | null;
  surfaceNormal: THREE.Vector3 | null;
  point: THREE.Vector3 | null;
  center: THREE.Vector3 | null;
}

export interface NoteComposerState {
  partId: string;
  partName: string;
  x: number;
  y: number;
  point: Vec3Like;
  normal?: Vec3Like;
  text: string;
}

export interface SectionCustomState {
  normal: THREE.Vector3;
  base: THREE.Vector3;
}

export interface SectionDragData {
  origin: THREE.Vector3;
  normal: THREE.Vector3;
  range: number;
  sign: number;
}
