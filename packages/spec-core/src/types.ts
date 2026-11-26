export type Numeric = number | string;

export interface Vec3 {
  x: Numeric;
  y: Numeric;
  z: Numeric;
}

export type Axis = "x" | "y" | "z";

export type ParameterType = "Length" | "Angle" | "Number" | "Integer" | "Text" | "YesNo";

export type ParameterGroup =
  | "Dimensions"
  | "Constraints"
  | "Data"
  | "Identity Data"
  | "Graphics"
  | "Materials and Finishes"
  | "Mechanical"
  | "Electrical"
  | "Plumbing"
  | "Energy Analysis"
  | "Structural"
  | "Construction"
  | "Visibility"
  | "Fire Protection"
  | "General"
  | "Other";

export interface FamilyParameter {
  name: string;
  type: ParameterType;
  value?: number | string | boolean;
  formula?: string | null;
  instance?: boolean;
  group?: ParameterGroup;
  description?: string;
  /** Explicit axis this length parameter measures; overrides the name heuristic. */
  axis?: Axis;
}

export interface BoxSolid {
  kind: "box";
  origin: Vec3;
  size: Vec3;
  /** Rotation about the Z axis, in degrees. */
  rotationZ?: Numeric;
  /** Rounds the four vertical corners, in millimetres. Clamped to half the footprint. */
  cornerRadius?: Numeric;
}

export interface CylinderSolid {
  kind: "cylinder";
  /** Centre of the base face. */
  base: Vec3;
  radius: Numeric;
  /** May be negative to extrude against the axis direction. */
  height: Numeric;
  axis?: Axis;
  /** When set, the solid becomes a tube. */
  innerRadius?: Numeric;
  segments?: number;
}

export interface FrustumSolid {
  kind: "frustum";
  /** Centre of the base face. */
  base: Vec3;
  /** Radius at the base. */
  radiusBottom: Numeric;
  /** Radius at the far end. Zero makes a cone. */
  radiusTop: Numeric;
  /** May be negative to extrude against the axis direction. */
  height: Numeric;
  axis?: Axis;
  segments?: number;
}

export interface BendSolid {
  kind: "bend";
  /** Point on the revolution axis (the centre of the torus). */
  center: Vec3;
  /** Distance from the axis to the tube centreline. */
  radius: Numeric;
  /** Radius of the circular section. */
  tubeRadius: Numeric;
  /** Sweep angle in degrees. Defaults to 90 (an elbow). */
  angle?: Numeric;
  /** Rotation of the start of the bend around the axis, in degrees. */
  startAngle?: Numeric;
  /** Plane containing the arc: xy (axis Z), xz (axis Y), yz (axis X). */
  plane?: "xy" | "xz" | "yz";
  segments?: number;
}

export interface PrismSolid {
  kind: "prism";
  plane: "xy" | "xz" | "yz";
  /** 2D points in the plane axes order: xy => [x, y], xz => [x, z], yz => [y, z]. */
  points: [Numeric, Numeric][];
  /** Optional inner loops cut out of the extrusion, in the same coordinate order as points. */
  holes?: [Numeric, Numeric][][];
  /** Extrusion start and end along the plane normal. */
  from: Numeric;
  to: Numeric;
}

export type LoftProfile =
  | { kind: "circle"; radius: Numeric }
  | { kind: "rect"; width: Numeric; height: Numeric; cornerRadius?: Numeric }
  | { kind: "polygon"; points: [Numeric, Numeric][] };

export interface LoftSection {
  /** Position along the loft axis, in millimetres. Sections must be in increasing order. */
  at: Numeric;
  profile: LoftProfile;
}

export interface LoftSolid {
  kind: "loft";
  /** Axis the sections are stacked along. Defaults to z. */
  axis?: Axis;
  /** Number of points each profile is resampled to. Defaults to 32. */
  segments?: number;
  sections: LoftSection[];
}

export interface RevolveSolid {
  kind: "revolve";
  /** Axis of revolution: x, y, or z. Defaults to z. */
  axis?: Axis;
  /** Point on the revolution axis. Defaults to (0, 0, 0). */
  origin?: Vec3;
  /** 2D profile points in [radial >= 0, height] coordinates. */
  points: [Numeric, Numeric][];
  /** Revolution sweep angle in degrees. Defaults to 360. */
  angle?: Numeric;
  /** Start angle in degrees. Defaults to 0. */
  startAngle?: Numeric;
  segments?: number;
}

export interface TubeSolid {
  kind: "tube";
  /** Centre of the start face. */
  start: Vec3;
  /** Centre of the end face. */
  end: Vec3;
  radius: Numeric;
  /** Optional inner radius; the tube becomes a hollow pipe. */
  innerRadius?: Numeric;
  segments?: number;
}

export type SolidPrimitive =
  | BoxSolid
  | CylinderSolid
  | FrustumSolid
  | BendSolid
  | PrismSolid
  | LoftSolid
  | RevolveSolid
  | TubeSolid;

export interface PartArray {
  /** Number, or an expression resolving to a whole number (e.g. "[Fin Count]"). */
  count: Numeric;
  axis: Axis;
  spacing: Numeric;
}

export interface PartAnchor {
  /** Which face of this part is driven on the X axis. */
  x?: "min" | "max";
  y?: "min" | "max";
  z?: "min" | "max";
}

export interface FamilyPart {
  id: string;
  name: string;
  solid: SolidPrimitive;
  cuts?: SolidPrimitive[];
  material?: string;
  color?: string;
  array?: PartArray;
  /** Pins which face the builder locks to the reference planes, per axis. */
  anchor?: PartAnchor;
  /**
   * Id of the sheet-metal macro that generated this part. Such parts are
   * regenerated on every expansion and must not be hand-edited.
   */
  from?: string;
}

export interface MaterialDef {
  name: string;
  color?: string;
  metalness?: number;
  roughness?: number;
}

export interface MepConnector {
  id: string;
  name: string;
  systemType:
    | "SupplyAir"
    | "ReturnAir"
    | "ExhaustAir"
    | "HydronicSupply"
    | "HydronicReturn"
    | "Sanitary"
    | "DomesticColdWater"
    | "DomesticHotWater"
    | "Electrical"
    | "Other Air"
    | "Supply Air"
    | "Return Air"
    | "Exhaust Air"
    | "Hydronic Supply"
    | "Hydronic Return"
    | "Domestic Cold Water"
    | "Domestic Hot Water"
    | "CableTray"
    | "Cable Tray"
    | "Power - Unbalanced"
    | "Power - Balanced"
    | "Fire Protection Wet"
    | "Fire Protection Dry"
    | "Fire Protection Preaction"
    | "Fire Protection Other";
  shape: "round" | "rectangular";
  direction: "in" | "out" | "bidirectional";
  /** solid = host on a real face; reference-plane = host on an invisible datum plane. */
  host?: "solid" | "reference-plane";
  origin: Vec3;
  directionVector?: Vec3;
  width?: Numeric;
  height?: Numeric;
  diameter?: Numeric;
  flow?: Numeric;
  flowUnit?: "L/s" | "m3/h" | "CFM";
  pressureDrop?: Numeric;
  /** Id of the macro that generated this connector; regenerated on expansion. */
  from?: string;
}

export interface FamilySpec {
  schemaVersion: "1.0";
  /** Internal schema revision used to migrate legacy saved specs on load. */
  specVersion?: number;
  name: string;
  typeName?: string;
  category: string;
  template?: string;
  /** Revit "Part Type" for MEP fittings (Elbow, Tee, Cross, …). */
  partType?: FamilyPartType;
  units: "mm";
  revitVersion?: string;
  /** Level of detail the family was designed for. */
  lod?: 200 | 300 | 350 | 400;
  description?: string;
  parameters: FamilyParameter[];
  parts: FamilyPart[];
  /** Compact sheet-metal macros expanded into ordinary parts before analysis. */
  macros?: SpecMacro[];
  connectors?: MepConnector[];
  materials?: MaterialDef[];
  /** Family types exported together with the family, one row per size. */
  types?: FamilyTypeEntry[];
  notes?: string[];
}

export interface TrayRunStraight {
  kind: "straight";
  /** Centreline length between the two miter joints. Number or formula. */
  length: Numeric;
}

export interface TrayRunBend {
  kind: "bend";
  /** Plan turn in degrees. 45 and 90 are supported. */
  angle: Numeric;
  direction: "left" | "right";
}

export type TrayRunSegment = TrayRunStraight | TrayRunBend;

/**
 * A folded tray/ladder run. Each straight leg becomes a bottom plate, two mitred
 * side walls and two top flanges; consecutive legs share the exact miter edge, so
 * the run closes without gaps or overlaps. All sizes stay formulas.
 */
export interface TrayRunMacro {
  kind: "trayRun";
  /** Stable id prefix for generated parts, e.g. "run-main". */
  id?: string;
  material?: string;
  width: Numeric;
  height: Numeric;
  thickness: Numeric;
  /** Width of the folded top flange/lip; 0 disables it. */
  flange?: Numeric;
  lid?: boolean;
  /** Adds one rectangular connector at each free end. Defaults to true. */
  connectors?: boolean;
  start?: { x: Numeric; y: Numeric; z: Numeric };
  segments: TrayRunSegment[];
}

export type SpecMacro = TrayRunMacro;

/** One row of the Types tab: a family type and the driver values it sets. */
export interface FamilyTypeEntry {
  name: string;
  /** Parameter name -> value in the spec unit (mm for Length). */
  values: Record<string, number>;
  /** True while the name is generated from the values and follows them. */
  autoName?: boolean;
}

export interface Issue {
  severity: "error" | "warning" | "info";
  path: string;
  message: string;
  /** Machine-readable message + params added by the server for client-side translation. */
  code?: string;
  params?: Record<string, unknown>;
}

export const PARAMETER_TYPES: ParameterType[] = [
  "Length",
  "Angle",
  "Number",
  "Integer",
  "Text",
  "YesNo",
];

export const PARAMETER_GROUPS: ParameterGroup[] = [
  "Dimensions",
  "Constraints",
  "Data",
  "Identity Data",
  "Graphics",
  "Materials and Finishes",
  "Mechanical",
  "Electrical",
  "Plumbing",
  "Energy Analysis",
  "Structural",
  "Construction",
  "Visibility",
  "Fire Protection",
  "General",
  "Other",
];

/** Revit family part type, written to FAMILY_CONTENT_PART_TYPE for fittings. */
export type FamilyPartType = "Elbow" | "Tee" | "Cross" | "Transition" | "Union" | "Other";

export const PART_TYPES: FamilyPartType[] = [
  "Elbow",
  "Tee",
  "Cross",
  "Transition",
  "Union",
  "Other",
];

/** Categories whose families expose a Part Type in Revit. */
export const FITTING_CATEGORIES = ["Duct Fitting", "Pipe Fitting", "Cable Tray Fitting"];

/** Revit category name -> metric family template used by the add-in. */
export const CATEGORY_TEMPLATES: Record<string, string> = {
  "Mechanical Equipment": "Metric Mechanical Equipment.rft",
  "Duct Fitting": "Metric Duct Elbow.rft",
  "Duct Elbow": "Metric Duct Elbow.rft",
  "Duct Transition": "Metric Duct Transition.rft",
  "Duct Tee": "Metric Duct Tee.rft",
  "Duct Cross": "Metric Duct Cross.rft",
  "Pipe Fitting": "Metric Generic Model.rft",
  "Cable Tray Fitting": "Metric Generic Model.rft",
  "Generic Model": "Metric Generic Model.rft",
  "Plumbing Fixture": "Metric Plumbing Fixture.rft",
  "Electrical Equipment": "Metric Electrical Equipment.rft",
  "Lighting Fixture": "Metric Lighting Fixture.rft",
  "Specialty Equipment": "Metric Specialty Equipment.rft",
  Furniture: "Metric Furniture.rft",
  Casework: "Metric Casework.rft",
  Door: "Metric Door.rft",
  Window: "Metric Window.rft",
  "Structural Framing": "Metric Structural Framing - Beams and Braces.rft",
  "Structural Column": "Metric Structural Column.rft",
  "Structural Foundation": "Metric Structural Foundation.rft",
  Site: "Metric Site.rft",
  Planting: "Metric Planting.rft",
  Entourage: "Metric Entourage.rft",
  "Data Device": "Metric Data Device.rft",
};

export const CATEGORIES = Object.keys(CATEGORY_TEMPLATES);

/**
 * Revit category name -> BuiltInCategory enum name. Revit 2024 has no cable-tray
 * template, so the family is built from a generic template and moved to this
 * category afterwards; the same table is mirrored in FamilyAgent.Core/CategoryCatalog.cs.
 */
export const CATEGORY_BUILTIN: Record<string, string> = {
  "Mechanical Equipment": "OST_MechanicalEquipment",
  "Duct Fitting": "OST_DuctFitting",
  "Duct Elbow": "OST_DuctFitting",
  "Duct Transition": "OST_DuctFitting",
  "Duct Tee": "OST_DuctFitting",
  "Duct Cross": "OST_DuctFitting",
  "Pipe Fitting": "OST_PipeFitting",
  "Cable Tray Fitting": "OST_CableTrayFitting",
  "Generic Model": "OST_GenericModel",
  "Plumbing Fixture": "OST_PlumbingFixtures",
  "Electrical Equipment": "OST_ElectricalEquipment",
  "Lighting Fixture": "OST_LightingFixtures",
  "Specialty Equipment": "OST_SpecialtyEquipment",
  Furniture: "OST_Furniture",
  Casework: "OST_Casework",
  Door: "OST_Doors",
  Window: "OST_Windows",
  "Structural Framing": "OST_StructuralFraming",
  "Structural Column": "OST_StructuralColumns",
  "Structural Foundation": "OST_StructuralFoundation",
  Site: "OST_Site",
  Planting: "OST_Planting",
  Entourage: "OST_Entourage",
  "Data Device": "OST_DataDevice",
};

export const LIMITS = {
  maxParameters: 200,
  maxParts: 250,
  maxArrayCount: 500,
  maxNameLength: 80,
};

/**
 * Practical part budgets by LOD. LOD describes the required information, not a
 * hard part count; these are performance guardrails, not BIM definitions.
 */
export const LOD_PART_BUDGETS: Record<number, { min: number; max: number }> = {
  200: { min: 3, max: 10 },
  300: { min: 5, max: 20 },
  350: { min: 10, max: 40 },
  400: { min: 20, max: 150 },
};

export const UNITS_PER_METER = 1000;
export const MM_PER_FOOT = 304.8;
