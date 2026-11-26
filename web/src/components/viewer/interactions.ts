import type { ResolvedModel } from "@family/spec-core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Strings } from "../../lib/strings";
import { createInteractionContext } from "./interactionContext";
import { attachPickHoverSelect } from "./pickHoverSelect";
import { attachMeasureTool } from "./measureTool";
import { attachSectionDrag } from "./sectionDrag";
import { attachParamHandleDrag } from "./paramHandleDrag";
import { attachContextMenuNotes } from "./contextMenuNotes";
import type {
  ActiveHandleState,
  ContextMenuState,
  NoteComposerState,
  SectionCustomState,
  SectionDragData,
} from "./types";

export interface ViewerInteractionDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  handlesGroup: THREE.Group;
  modelRef: MutableRefObject<ResolvedModel | null>;
  tRef: MutableRefObject<Strings>;
  formatNumberRef: MutableRefObject<(value: number) => string>;
  renderDirtyRef: MutableRefObject<boolean>;
  measuringRef: MutableRefObject<boolean>;
  pickingSectionRef: MutableRefObject<boolean>;
  hoverBlockedRef: MutableRefObject<boolean>;
  measurePointsRef: MutableRefObject<THREE.Vector3[]>;
  measureSegmentsRef: MutableRefObject<THREE.Group[]>;
  measureMarkersRef: MutableRefObject<THREE.Mesh[]>;
  measurePreviewGroupRef: MutableRefObject<THREE.Group | null>;
  sectionArrowRef: MutableRefObject<THREE.Object3D | null>;
  sectionDragRef: MutableRefObject<boolean>;
  sectionDragMovedRef: MutableRefObject<boolean>;
  sectionDragDataRef: MutableRefObject<SectionDragData | null>;
  pickedPartIdsRef: MutableRefObject<string[]>;
  onSelectPartRef: MutableRefObject<((partId: string | null) => void) | undefined>;
  onUpdateParameterRef: MutableRefObject<((name: string, value: number) => void) | undefined>;
  setActiveHandle: Dispatch<SetStateAction<ActiveHandleState | null>>;
  setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
  setNoteComposer: Dispatch<SetStateAction<NoteComposerState | null>>;
  setHoveredPartId: Dispatch<SetStateAction<string | null>>;
  setHoverInfo: Dispatch<SetStateAction<{ x: number; y: number; name: string } | null>>;
  setPickedPartIds: Dispatch<SetStateAction<string[]>>;
  setMeasureLabel: Dispatch<SetStateAction<string | null>>;
  setMeasureCount: Dispatch<SetStateAction<number>>;
  setSectionCustom: Dispatch<SetStateAction<SectionCustomState | null>>;
  setSectionAxis: Dispatch<SetStateAction<"off" | "x" | "y" | "z" | "custom">>;
  setSectionT: Dispatch<SetStateAction<number>>;
  setPickingSection: Dispatch<SetStateAction<boolean>>;
}

/** Wires focused interaction modules using a single shared lightweight interaction context. */
export function attachViewerInteractions(deps: ViewerInteractionDeps): () => void {
  const ctx = createInteractionContext(
    deps.renderer,
    deps.camera,
    deps.content,
    () => {
      deps.renderDirtyRef.current = true;
    },
  );

  const detachers = [
    attachContextMenuNotes(ctx, {
      modelRef: deps.modelRef,
      pickedPartIdsRef: deps.pickedPartIdsRef,
      onSelectPartRef: deps.onSelectPartRef,
      setPickedPartIds: deps.setPickedPartIds,
      setContextMenu: deps.setContextMenu,
      setNoteComposer: deps.setNoteComposer,
    }),
    attachParamHandleDrag(ctx, {
      controls: deps.controls,
      handlesGroup: deps.handlesGroup,
      sectionDragRef: deps.sectionDragRef,
      onUpdateParameterRef: deps.onUpdateParameterRef,
      setActiveHandle: deps.setActiveHandle,
    }),
    attachSectionDrag(ctx, {
      controls: deps.controls,
      sectionArrowRef: deps.sectionArrowRef,
      sectionDragRef: deps.sectionDragRef,
      sectionDragMovedRef: deps.sectionDragMovedRef,
      sectionDragDataRef: deps.sectionDragDataRef,
      setSectionT: deps.setSectionT,
    }),
    attachMeasureTool(ctx, {
      scene: deps.scene,
      modelRef: deps.modelRef,
      tRef: deps.tRef,
      formatNumberRef: deps.formatNumberRef,
      measuringRef: deps.measuringRef,
      sectionDragMovedRef: deps.sectionDragMovedRef,
      measurePointsRef: deps.measurePointsRef,
      measureSegmentsRef: deps.measureSegmentsRef,
      measureMarkersRef: deps.measureMarkersRef,
      measurePreviewGroupRef: deps.measurePreviewGroupRef,
      setMeasureLabel: deps.setMeasureLabel,
      setMeasureCount: deps.setMeasureCount,
    }),
    attachPickHoverSelect(ctx, {
      handlesGroup: deps.handlesGroup,
      measuringRef: deps.measuringRef,
      pickingSectionRef: deps.pickingSectionRef,
      hoverBlockedRef: deps.hoverBlockedRef,
      sectionDragMovedRef: deps.sectionDragMovedRef,
      pickedPartIdsRef: deps.pickedPartIdsRef,
      onSelectPartRef: deps.onSelectPartRef,
      setPickedPartIds: deps.setPickedPartIds,
      setHoveredPartId: deps.setHoveredPartId,
      setHoverInfo: deps.setHoverInfo,
      onPickSectionFace: (normal, base) => {
        if (normal.lengthSq() > 0) {
          deps.setSectionCustom({ normal, base });
          deps.setSectionAxis("custom");
          deps.setSectionT(0.5);
        }
        deps.setPickingSection(false);
      },
    }),
  ];

  return () => {
    for (const detach of detachers) detach();
  };
}
