import type { Strings } from "../lib/strings";

export type DemoPresetKey = "fcu" | "pump" | "elbow" | "ystrainer" | "ystrainer-tube";

export async function loadDemoPreset(
  key: DemoPresetKey,
  t: Strings,
): Promise<{ raw: unknown; userPromptText: string } | null> {
  if (key === "fcu") {
    return {
      raw: (await import("../../../spec/examples/fcu-080.json")).default,
      userPromptText: t.appDemoPromptFcu,
    };
  }
  if (key === "pump") {
    return {
      raw: (await import("../../../spec/examples/pump-dn80.json")).default,
      userPromptText: t.appDemoPromptPump,
    };
  }
  if (key === "ystrainer") {
    return {
      raw: (await import("../../../spec/examples/ystrainer-dn80.json")).default,
      userPromptText: t.appDemoPromptYStrainer,
    };
  }
  if (key === "ystrainer-tube") {
    return {
      raw: (await import("../../../spec/examples/ystrainer-tube.json")).default,
      userPromptText: t.appDemoPromptYStrainerTube,
    };
  }
  if (key === "elbow") {
    return {
      userPromptText: t.appDemoPromptElbow,
      raw: {
        schemaVersion: "1.0",
        name: "Threaded 90 Deg Duct Elbow DN50",
        typeName: "Elbow 90 DN50",
        category: "Duct Elbow",
        units: "mm",
        description: "90 degree threaded elbow DN50 with end bands and connectors",
        parameters: [
          { name: "Nominal Diameter", type: "Length", group: "Dimensions", value: 50 },
          { name: "Center Radius", type: "Length", group: "Dimensions", value: 57 },
          { name: "Body OD", type: "Length", group: "Dimensions", value: 68 },
          { name: "Band OD", type: "Length", group: "Dimensions", value: 76.5 },
          { name: "Band Length", type: "Length", group: "Dimensions", value: 12 },
          { name: "Takeoff Length", type: "Length", group: "Dimensions", value: 69 },
        ],
        materials: [
          { name: "Cast Iron", color: "#61676c", roughness: 0.65, metalness: 0.4 },
          { name: "Galvanized Trim", color: "#9aa1a6", roughness: 0.45, metalness: 0.5 },
        ],
        parts: [
          {
            id: "elbow-body",
            name: "Elbow Center Body",
            material: "Cast Iron",
            solid: {
              kind: "cylinder",
              axis: "z",
              base: { x: 0, y: 0, z: -34 },
              radius: "[Body OD] / 2",
              height: 68,
            },
          },
          {
            id: "flange-port-1",
            name: "End Band Port 1 (+X)",
            material: "Galvanized Trim",
            solid: {
              kind: "cylinder",
              axis: "x",
              base: { x: "[Center Radius]", y: 0, z: 0 },
              radius: "[Band OD] / 2",
              height: 12,
            },
          },
          {
            id: "flange-port-2",
            name: "End Band Port 2 (-Y)",
            material: "Galvanized Trim",
            solid: {
              kind: "cylinder",
              axis: "y",
              base: { x: 0, y: "-[Center Radius]", z: 0 },
              radius: "[Band OD] / 2",
              height: -12,
            },
          },
        ],
        connectors: [
          {
            id: "conn-1",
            name: "Connector 1",
            systemType: "SupplyAir",
            shape: "round",
            direction: "out",
            origin: { x: 69, y: 0, z: 0 },
            directionVector: { x: 1, y: 0, z: 0 },
            diameter: 50,
          },
          {
            id: "conn-2",
            name: "Connector 2",
            systemType: "SupplyAir",
            shape: "round",
            direction: "in",
            origin: { x: 0, y: -69, z: 0 },
            directionVector: { x: 0, y: -1, z: 0 },
            diameter: 50,
          },
        ],
      },
    };
  }
  return null;
}
