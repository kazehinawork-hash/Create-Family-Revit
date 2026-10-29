export type Numeric = number | string;

export interface Vec3 {
  x: Numeric;
  y: Numeric;
  z: Numeric;
}

export type Axis = "x" | "y" | "z";

export type ParameterType =
  | "Length"
  | "Angle"
  | "Number"
  | "Integer"
  | "Text"
  | "YesNo";

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

export interface PrismSolid {
  kind: "prism";
  plane: "xy" | "xz" | "yz";
  /** 2D points in the plane axes order: xy => [x, y], xz => [x, z], yz => [y, z]. */
  points: [Numeric, Numeric][];
  /** Extrusion start and end along the plane normal. */
  from: Numeric;
  to: Numeric;
}

export type SolidPrimitive = BoxSolid | CylinderSolid | PrismSolid;

export interface PartArray {
  /** Number, or an expression resolving to a whole number (e.g. "[Fin Count]"). */
  count: Numeric;
  axis: Axis;
  spacing: Numeric;
}

export interface FamilyPart {
  id: string;
  name: string;
  solid: SolidPrimitive;
  cuts?: SolidPrimitive[];
  material?: string;
  color?: string;
  array?: PartArray;
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
    | "Electrical";
  shape: "round" | "rectangular";
  direction: "in" | "out" | "bidirectional";
  origin: Vec3;
  directionVector?: Vec3;
  width?: Numeric;
  height?: Numeric;
  diameter?: Numeric;
  flow?: Numeric;
  flowUnit?: "L/s" | "m3/h" | "CFM";
  pressureDrop?: Numeric;
}

export interface FamilySpec {
  schemaVersion: "1.0";
  name: string;
  typeName?: string;
  category: string;
  template?: string;
  units: "mm";
  revitVersion?: string;
  /** Level of detail the family was designed for. */
  lod?: 200 | 300 | 350 | 400;
  description?: string;
  parameters: FamilyParameter[];
  parts: FamilyPart[];
  connectors?: MepConnector[];
  materials?: MaterialDef[];
  notes?: string[];
}

export interface Issue {
  severity: "error" | "warning";
  path: string;
  message: string;
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

/** Revit category name -> metric family template used by the add-in. */
export const CATEGORY_TEMPLATES: Record<string, string> = {
  "Mechanical Equipment": "Metric Mechanical Equipment.rft",
  "Duct Fitting": "Metric Duct Elbow.rft",
  "Duct Elbow": "Metric Duct Elbow.rft",
  "Duct Transition": "Metric Duct Transition.rft",
  "Duct Tee": "Metric Duct Tee.rft",
  "Duct Cross": "Metric Duct Cross.rft",
  "Pipe Fitting": "Metric Generic Model.rft",
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

export const LIMITS = {
  maxParameters: 200,
  maxParts: 250,
  maxArrayCount: 500,
  maxNameLength: 80,
};

export const UNITS_PER_METER = 1000;
export const MM_PER_FOOT = 304.8;
