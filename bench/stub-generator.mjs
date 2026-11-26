import { crossSpec, elbowSpec, teeSpec } from "../server/src/templates/cable-ladder.js";

const GALV = { name: "Galvanized", color: "#b8c0c8", metalness: 0.7, roughness: 0.35 };
const BODY = { name: "Casing Steel", color: "#b9bec2", metalness: 0.4, roughness: 0.5 };
const DARK = { name: "Dark Steel", color: "#4b5257", metalness: 0.6, roughness: 0.4 };

function p(name, value, type = "Length") {
  return { name, type, group: "Dimensions", instance: false, value };
}

function f(name, formula, type = "Length") {
  return { name, type, group: "Dimensions", instance: false, formula };
}

function rectConn(id, name, origin, dir, width, height) {
  return {
    id,
    name,
    systemType: "CableTray",
    shape: "rectangular",
    direction: id.includes("in") ? "in" : "out",
    host: "reference-plane",
    origin,
    directionVector: dir,
    width,
    height,
  };
}

function parseSizeHint(prompt) {
  const m = String(prompt).match(/(\d{2,4})\s*x\s*(\d{2,4})(?:\s*x\s*(\d{2,4}))?/i);
  return m
    ? { w: Number(m[1]), h: Number(m[2]), third: m[3] ? Number(m[3]) : null }
    : { w: 400, h: 100, third: null };
}

/**
 * Hand-assembled box tray baseline ("before macro"):
 * Simulates pre-macro LLM behaviour: rectangular boxes without 45° mitred corner prisms,
 * missing top flanges on angled segments, and literal offsets on some turns.
 */
function preMacroTrayBox(testCase) {
  const { w, h } = parseSizeHint(testCase.prompt);
  const hasElbow = /elbow|cút|khuỷu|z-offset|chữ z|s-offset|u-turn|chữ u/i.test(testCase.id);
  const length = testCase.id.includes("straight") ? 1000 : 500;
  const parts = [
    {
      id: "bottom-1",
      name: "Bottom Plate 1",
      material: GALV.name,
      solid: {
        kind: "box",
        origin: { x: 0, y: 0, z: 0 },
        size: { x: "[Tray Width]", y: "[Tray Width]", z: "[Sheet Thickness]" },
      },
    },
    {
      id: "wall-left-1",
      name: "Side Wall Left 1",
      material: GALV.name,
      solid: {
        kind: "box",
        origin: { x: 0, y: "[Tray Width] / 2", z: 0 },
        size: { x: length, y: "[Sheet Thickness]", z: "[Tray Height]" },
      },
    },
    {
      id: "wall-right-1",
      name: "Side Wall Right 1",
      material: GALV.name,
      solid: {
        kind: "box",
        origin: { x: 0, y: "-[Tray Width] / 2", z: 0 },
        size: { x: length, y: "[Sheet Thickness]", z: "[Tray Height]" },
      },
    },
  ];

  if (hasElbow) {
    parts.push({
      id: "leg-2-box",
      name: "Leg 2 Unmitred Box",
      material: GALV.name,
      solid: {
        kind: "box",
        origin: { x: length / 2, y: length / 2, z: 0 },
        size: { x: "[Tray Width]", y: length, z: "[Tray Height]" },
      },
    });
  }

  return {
    schemaVersion: "1.0",
    name: testCase.id,
    category: "Cable Tray Fitting",
    partType: hasElbow ? "Elbow" : undefined,
    units: "mm",
    lod: testCase.lod,
    parameters: [
      p("Tray Width", w),
      p("Tray Height", h),
      p("Sheet Thickness", 1.8),
      p("Run Length", length),
    ],
    materials: [GALV],
    parts,
    connectors: [
      rectConn("conn-in", "In", { x: -length / 2, y: 0, z: h / 2 }, { x: -1, y: 0, z: 0 }, "[Tray Width]", "[Tray Height]"),
      rectConn("conn-out", "Out", { x: length / 2, y: 0, z: h / 2 }, { x: 1, y: 0, z: 0 }, "[Tray Width]", "[Tray Height]"),
    ],
  };
}

/** Macro-based spec ("after macro") for trayRun-capable cases. */
function afterMacroTray(testCase) {
  const id = testCase.id;
  if (id === "tray-straight-400x100" || id === "tray-straight-slotted-600x100") {
    const w = id.includes("600") ? 600 : 400;
    const t = id.includes("600") ? 2 : 1.8;
    const spec = {
      schemaVersion: "1.0",
      name: id,
      category: "Cable Tray Fitting",
      units: "mm",
      lod: testCase.lod,
      parameters: [
        p("Tray Width", w),
        p("Tray Height", 100),
        p("Sheet Thickness", t),
        p("Flange Width", 15),
        p("Run Length", 1000),
      ],
      materials: [GALV],
      parts: [],
      macros: [
        {
          kind: "trayRun",
          id: "run-main",
          material: GALV.name,
          width: "[Tray Width]",
          height: "[Tray Height]",
          thickness: "[Sheet Thickness]",
          flange: "[Flange Width]",
          segments: [{ kind: "straight", length: "[Run Length]" }],
        },
      ],
    };
    if (id.includes("slotted")) {
      spec.parameters.push(p("Slot Length", 40), p("Slot Width", 12));
      spec.parts.push({
        id: "slot-array-marker",
        name: "Bottom Ventilation Slots",
        material: GALV.name,
        solid: {
          kind: "box",
          origin: { x: 200, y: 0, z: 0 },
          size: { x: "[Slot Length]", y: "[Slot Width]", z: "[Sheet Thickness]" },
          },
        cuts: [
          {
            kind: "box",
            origin: { x: 200, y: 0, z: 0 },
            size: { x: "[Slot Length]", y: "[Slot Width]", z: 6 },
          },
        ],
        array: { count: 4, axis: "x", spacing: 180 },
      });
    }
    return spec;
  }

  if (id === "tray-elbow-90-400x100" || id === "tray-elbow-90-lid-400x100") {
    return {
      schemaVersion: "1.0",
      name: id,
      category: "Cable Tray Fitting",
      partType: "Elbow",
      units: "mm",
      lod: testCase.lod,
      parameters: [
        p("Tray Width", 400),
        p("Tray Height", 100),
        p("Sheet Thickness", 1.8),
        p("Flange Width", 15),
        p("Leg Length", 500),
      ],
      materials: [GALV],
      parts: [],
      macros: [
        {
          kind: "trayRun",
          id: "run-main",
          material: GALV.name,
          width: "[Tray Width]",
          height: "[Tray Height]",
          thickness: "[Sheet Thickness]",
          flange: "[Flange Width]",
          lid: id.includes("lid"),
          segments: [
            { kind: "straight", length: "[Leg Length]" },
            { kind: "bend", angle: 90, direction: "left" },
            { kind: "straight", length: "[Leg Length]" },
          ],
        },
      ],
    };
  }

  if (id === "ladder-elbow-90-500x100") {
    return elbowSpec({ ladderWidth1: 500, ladderWidth2: 500, ladderHeight: 100, tangentLength: 200, miterOffset: 150 });
  }

  if (id === "tray-elbow-45-300x100") {
    return {
      schemaVersion: "1.0",
      name: id,
      category: "Cable Tray Fitting",
      partType: "Elbow",
      units: "mm",
      lod: testCase.lod,
      parameters: [
        p("Tray Width", 300),
        p("Tray Height", 100),
        p("Sheet Thickness", 1.5),
        p("Flange Width", 15),
        p("Leg Length", 450),
      ],
      materials: [GALV],
      parts: [],
      macros: [
        {
          kind: "trayRun",
          id: "run-main",
          material: GALV.name,
          width: "[Tray Width]",
          height: "[Tray Height]",
          thickness: "[Sheet Thickness]",
          flange: "[Flange Width]",
          segments: [
            { kind: "straight", length: "[Leg Length]" },
            { kind: "bend", angle: 45, direction: "left" },
            { kind: "straight", length: "[Leg Length]" },
          ],
        },
      ],
    };
  }

  if (id === "tray-z-offset-400x100") {
    return {
      schemaVersion: "1.0",
      name: id,
      category: "Cable Tray Fitting",
      units: "mm",
      lod: testCase.lod,
      parameters: [
        p("Tray Width", 400),
        p("Tray Height", 100),
        p("Sheet Thickness", 1.8),
        p("Flange Width", 15),
        p("Leg A", 400),
        p("Offset B", 500),
      ],
      materials: [GALV],
      parts: [],
      macros: [
        {
          kind: "trayRun",
          id: "run-main",
          material: GALV.name,
          width: "[Tray Width]",
          height: "[Tray Height]",
          thickness: "[Sheet Thickness]",
          flange: "[Flange Width]",
          segments: [
            { kind: "straight", length: "[Leg A]" },
            { kind: "bend", angle: 90, direction: "left" },
            { kind: "straight", length: "[Offset B]" },
            { kind: "bend", angle: 90, direction: "right" },
            { kind: "straight", length: "[Leg A]" },
          ],
        },
      ],
    };
  }

  if (id === "tray-elbow-no-flange-200x50") {
    return {
      schemaVersion: "1.0",
      name: id,
      category: "Cable Tray Fitting",
      partType: "Elbow",
      units: "mm",
      lod: testCase.lod,
      parameters: [
        p("Tray Width", 200),
        p("Tray Height", 50),
        p("Sheet Thickness", 1.5),
        p("Leg Length", 350),
      ],
      materials: [GALV],
      parts: [],
      macros: [
        {
          kind: "trayRun",
          id: "run-main",
          material: GALV.name,
          width: "[Tray Width]",
          height: "[Tray Height]",
          thickness: "[Sheet Thickness]",
          flange: 0,
          segments: [
            { kind: "straight", length: "[Leg Length]" },
            { kind: "bend", angle: 90, direction: "left" },
            { kind: "straight", length: "[Leg Length]" },
          ],
        },
      ],
    };
  }

  if (id === "tray-s-offset-45-300x75") {
    return {
      schemaVersion: "1.0",
      name: id,
      category: "Cable Tray Fitting",
      units: "mm",
      lod: testCase.lod,
      parameters: [
        p("Tray Width", 300),
        p("Tray Height", 75),
        p("Sheet Thickness", 1.5),
        p("Flange Width", 12),
        p("Leg A", 400),
        p("Mid B", 350),
      ],
      materials: [GALV],
      parts: [],
      macros: [
        {
          kind: "trayRun",
          id: "run-main",
          material: GALV.name,
          width: "[Tray Width]",
          height: "[Tray Height]",
          thickness: "[Sheet Thickness]",
          flange: "[Flange Width]",
          segments: [
            { kind: "straight", length: "[Leg A]" },
            { kind: "bend", angle: 45, direction: "left" },
            { kind: "straight", length: "[Mid B]" },
            { kind: "bend", angle: 45, direction: "right" },
            { kind: "straight", length: "[Leg A]" },
          ],
        },
      ],
    };
  }

  if (id === "tray-u-turn-180-400x100") {
    return {
      schemaVersion: "1.0",
      name: id,
      category: "Cable Tray Fitting",
      units: "mm",
      lod: testCase.lod,
      parameters: [
        p("Tray Width", 400),
        p("Tray Height", 100),
        p("Sheet Thickness", 1.8),
        p("Flange Width", 15),
        p("Leg A", 400),
        p("Bridge B", 500),
      ],
      materials: [GALV],
      parts: [],
      macros: [
        {
          kind: "trayRun",
          id: "run-main",
          material: GALV.name,
          width: "[Tray Width]",
          height: "[Tray Height]",
          thickness: "[Sheet Thickness]",
          flange: "[Flange Width]",
          segments: [
            { kind: "straight", length: "[Leg A]" },
            { kind: "bend", angle: 90, direction: "left" },
            { kind: "straight", length: "[Bridge B]" },
            { kind: "bend", angle: 90, direction: "left" },
            { kind: "straight", length: "[Leg A]" },
          ],
        },
      ],
    };
  }

  return {
    schemaVersion: "1.0",
    name: id,
    category: "Cable Tray Fitting",
    partType: "Elbow",
    units: "mm",
    lod: testCase.lod,
    parameters: [
      p("Tray Width", 500),
      p("Tray Height", 100),
      p("Sheet Thickness", 2),
      p("Flange Width", 15),
      p("Leg A", 600),
      p("Leg B", 500),
    ],
    materials: [GALV],
    parts: [],
    macros: [
      {
        kind: "trayRun",
        id: "run-main",
        material: GALV.name,
        width: "[Tray Width]",
        height: "[Tray Height]",
        thickness: "[Sheet Thickness]",
        flange: "[Flange Width]",
        segments: [
          { kind: "straight", length: "[Leg A]" },
          { kind: "bend", angle: 45, direction: "right" },
          { kind: "straight", length: "[Leg B]" },
        ],
      },
    ],
  };
}

function nonMacroSpec(testCase) {
  const id = testCase.id;
  if (id === "ladder-mitered-tee-400x300") return teeSpec();
  if (id === "ladder-mitered-cross-400x400") return crossSpec();

  if (id === "tray-tee-equal-400x100") {
    const s = teeSpec({ ladderWidth2: 400 });
    s.parts[0].cuts = [{ kind: "cylinder", axis: "z", base: { x: 320, y: 0, z: 0 }, radius: 4.5, height: 120 }];
    return s;
  }
  if (id === "tray-cross-unequal-400x200") {
    return crossSpec({ ladderWidth1: 400, ladderWidth2: 200 });
  }
  if (id === "tray-reducer-concentric-400x200" || id === "tray-reducer-eccentric-500x300") {
    const w1 = id.includes("500") ? 500 : 400;
    const w2 = id.includes("500") ? 300 : 200;
    const hw1 = "[Width In] / 2";
    const hw2 = "[Width Out] / 2";
    const pts = id.includes("eccentric")
      ? [["-[Length] / 2", `-${hw1}`], ["[Length] / 2", `-${hw1}`], ["[Length] / 2", `-${hw1} + [Width Out]`], ["-[Length] / 2", hw1]]
      : [["-[Length] / 2", `-${hw1}`], ["[Length] / 2", `-${hw2}`], ["[Length] / 2", hw2], ["-[Length] / 2", hw1]];
    return {
      schemaVersion: "1.0",
      name: id,
      category: "Cable Tray Fitting",
      partType: "Transition",
      units: "mm",
      lod: testCase.lod,
      parameters: [p("Width In", w1), p("Width Out", w2), p("Tray Height", 100), p("Sheet Thickness", 1.8), p("Flange Width", 15), p("Length", 350)],
      materials: [GALV],
      parts: [
        { id: "bottom-plate", name: "Bottom Plate", material: GALV.name, solid: { kind: "prism", plane: "xy", points: pts, from: 0, to: "[Sheet Thickness]" } },
        { id: "side-wall-1", name: "Side Wall Left", material: GALV.name, solid: { kind: "box", origin: { x: 0, y: `-${hw1}`, z: 0 }, size: { x: "[Length]", y: "[Sheet Thickness]", z: "[Tray Height]" } } },
        { id: "side-wall-2", name: "Side Wall Right", material: GALV.name, solid: { kind: "box", origin: { x: 0, y: hw1, z: 0 }, size: { x: "[Length]", y: "[Sheet Thickness]", z: "[Tray Height]" } } },
        { id: "flange-1", name: "Top Flange", material: GALV.name, solid: { kind: "box", origin: { x: 0, y: 0, z: "[Tray Height] - [Sheet Thickness]" }, size: { x: "[Length]", y: "[Flange Width]", z: "[Sheet Thickness]" } } },
      ],
      connectors: [
        rectConn("in", "In", { x: "-[Length] / 2", y: 0, z: "[Tray Height] / 2" }, { x: -1, y: 0, z: 0 }, "[Width In]", "[Tray Height]"),
        rectConn("out", "Out", { x: "[Length] / 2", y: 0, z: "[Tray Height] / 2" }, { x: 1, y: 0, z: 0 }, "[Width Out]", "[Tray Height]"),
      ],
    };
  }
  if (id === "tray-vertical-inside-riser-400x100" || id === "tray-vertical-outside-elbow-400x100") {
    const pts = [[0, 0], [450, 0], [450, 120], [120, 450], [0, 450]];
    return {
      schemaVersion: "1.0",
      name: id,
      category: "Cable Tray Fitting",
      partType: "Elbow",
      units: "mm",
      lod: testCase.lod,
      parameters: [p("Tray Width", 400), p("Tray Height", 100), p("Sheet Thickness", 1.8)],
      materials: [GALV],
      parts: [
        { id: "side-left", name: "Side Wall Left", material: GALV.name, solid: { kind: "prism", plane: "xz", points: pts, from: "-[Tray Width] / 2", to: "-[Tray Width] / 2 + [Sheet Thickness]" }, cuts: id.includes("outside") ? [{ kind: "cylinder", axis: "y", base: { x: 40, y: -210, z: 40 }, radius: 4.5, height: 30 }] : [] },
        { id: "side-right", name: "Side Wall Right", material: GALV.name, solid: { kind: "prism", plane: "xz", points: pts, from: "[Tray Width] / 2 - [Sheet Thickness]", to: "[Tray Width] / 2" } },
        { id: "bottom-h", name: "Bottom Plate Horizontal", material: GALV.name, solid: { kind: "box", origin: { x: 225, y: 0, z: 0 }, size: { x: 450, y: "[Tray Width]", z: "[Sheet Thickness]" } } },
        { id: "bottom-v", name: "Bottom Plate Vertical", material: GALV.name, solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[Sheet Thickness]", y: "[Tray Width]", z: 450 } } },
      ],
      connectors: [
        rectConn("in", "In", { x: 450, y: 0, z: 50 }, { x: 1, y: 0, z: 0 }, "[Tray Width]", "[Tray Height]"),
        rectConn("out", "Out", { x: 50, y: 0, z: 450 }, { x: 0, y: 0, z: 1 }, "[Tray Width]", "[Tray Height]"),
      ],
    };
  }
  if (id === "tray-splice-plate-h100") {
    return {
      schemaVersion: "1.0",
      name: id,
      category: "Cable Tray Fitting",
      units: "mm",
      lod: testCase.lod,
      parameters: [p("Plate Length", 200), p("Plate Height", 100), p("Sheet Thickness", 2), p("Flange Width", 15)],
      materials: [GALV],
      parts: [
        {
          id: "splice-plate",
          name: "Splice Plate",
          material: GALV.name,
          solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[Plate Length]", y: "[Sheet Thickness]", z: "[Plate Height]" } },
          cuts: [
            { kind: "cylinder", axis: "y", base: { x: -60, y: -5, z: 30 }, radius: 4.5, height: 10 },
            { kind: "cylinder", axis: "y", base: { x: 60, y: -5, z: 30 }, radius: 4.5, height: 10 },
          ],
        },
        { id: "splice-flange", name: "Top Flange Hem", material: GALV.name, solid: { kind: "box", origin: { x: 0, y: 7, z: "[Plate Height] - [Sheet Thickness]" }, size: { x: "[Plate Length]", y: "[Flange Width]", z: "[Sheet Thickness]" } } },
      ],
    };
  }
  if (id === "duct-transition-400x200-to-300") {
    return {
      schemaVersion: "1.0",
      name: id,
      category: "Duct Transition",
      units: "mm",
      lod: testCase.lod,
      parameters: [p("Rect Width", 400), p("Rect Height", 200), p("Round Diameter", 300), p("Length", 400)],
      materials: [GALV],
      parts: [
        { id: "transition-body", name: "Transition Body", material: GALV.name, solid: { kind: "loft", axis: "z", segments: 24, sections: [{ at: 0, profile: { kind: "rect", width: "[Rect Width]", height: "[Rect Height]" } }, { at: "[Length]", profile: { kind: "circle", radius: "[Round Diameter] / 2" } }] } },
        { id: "top-collar", name: "Round Collar", material: GALV.name, solid: { kind: "cylinder", axis: "z", base: { x: 0, y: 0, z: "[Length]" }, radius: "[Round Diameter] / 2", innerRadius: "[Round Diameter] / 2 - 2", height: 30 } },
      ],
      connectors: [
        { id: "in", name: "Rect In", systemType: "SupplyAir", shape: "rectangular", direction: "in", origin: { x: 0, y: 0, z: 0 }, directionVector: { x: 0, y: 0, z: -1 }, width: "[Rect Width]", height: "[Rect Height]" },
        { id: "out", name: "Round Out", systemType: "SupplyAir", shape: "round", direction: "out", origin: { x: 0, y: 0, z: 430 }, directionVector: { x: 0, y: 0, z: 1 }, diameter: "[Round Diameter]" },
      ],
    };
  }
  if (id === "pipe-y-strainer-dn80") {
    return {
      schemaVersion: "1.0",
      name: id,
      category: "Pipe Fitting",
      units: "mm",
      lod: testCase.lod,
      parameters: [p("Nominal Diameter", 80), p("Face to Face Length", 310), p("Flange Diameter", 200), p("Flange Thickness", 20)],
      materials: [DARK],
      parts: [
        { id: "body", name: "Main Body", material: DARK.name, solid: { kind: "cylinder", axis: "x", base: { x: "-[Face to Face Length] / 2", y: 0, z: 150 }, radius: 55, height: "[Face to Face Length]" } },
        { id: "flange-in", name: "Flange In", material: DARK.name, solid: { kind: "cylinder", axis: "x", base: { x: "-[Face to Face Length] / 2", y: 0, z: 150 }, radius: "[Flange Diameter] / 2", height: "[Flange Thickness]" }, cuts: [{ kind: "cylinder", axis: "x", base: { x: "-[Face to Face Length] / 2 - 1", y: 0, z: 150 }, radius: 9, height: 30 }] },
        { id: "flange-out", name: "Flange Out", material: DARK.name, solid: { kind: "cylinder", axis: "x", base: { x: "[Face to Face Length] / 2 - [Flange Thickness]", y: 0, z: 150 }, radius: "[Flange Diameter] / 2", height: "[Flange Thickness]" } },
        { id: "strainer-branch", name: "Strainer Branch", material: DARK.name, solid: { kind: "tube", start: { x: 0, y: 0, z: 150 }, end: { x: 110, y: 0, z: 20 }, radius: 48 } },
      ],
      connectors: [
        { id: "in", name: "In", systemType: "Hydronic Supply", shape: "round", direction: "in", origin: { x: "-[Face to Face Length] / 2", y: 0, z: 150 }, directionVector: { x: -1, y: 0, z: 0 }, diameter: "[Nominal Diameter]" },
        { id: "out", name: "Out", systemType: "Hydronic Supply", shape: "round", direction: "out", origin: { x: "[Face to Face Length] / 2", y: 0, z: 150 }, directionVector: { x: 1, y: 0, z: 0 }, diameter: "[Nominal Diameter]" },
      ],
    };
  }
  if (id === "strut-channel-p1000-1000") {
    return {
      schemaVersion: "1.0",
      name: id,
      category: "Structural Framing",
      units: "mm",
      lod: testCase.lod,
      parameters: [p("Channel Length", 1000), p("Channel Width", 41), p("Sheet Thickness", 2.5)],
      materials: [GALV],
      parts: [
        {
          id: "strut-channel",
          name: "Strut Channel Flange Back",
          material: GALV.name,
          solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[Channel Length]", y: "[Channel Width]", z: "[Channel Width]" } },
          cuts: [{ kind: "box", origin: { x: -300, y: 0, z: 0 }, size: { x: 25, y: 14, z: 10 } }],
        },
      ],
    };
  }
  return {
    schemaVersion: "1.0",
    name: id,
    category: "Mechanical Equipment",
    units: "mm",
    lod: testCase.lod,
    parameters: [p("Casing Length", 1200), p("Casing Width", 700), p("Casing Height", 600), f("Inner Length", "[Casing Length] - 50mm")],
    materials: [BODY, DARK],
    parts: [
      { id: "casing", name: "Casing Shell", material: BODY.name, solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[Casing Length]", y: "[Casing Width]", z: "[Casing Height]" } } },
      { id: "filter", name: "Filter Bank", material: DARK.name, solid: { kind: "box", origin: { x: -420, y: 0, z: 60 }, size: { x: 80, y: "[Casing Width] - 80mm", z: "[Casing Height] - 120mm" } } },
      { id: "coil", name: "Cooling Coil", material: DARK.name, solid: { kind: "box", origin: { x: -120, y: 0, z: 120 }, size: { x: 180, y: "[Casing Width] - 100mm", z: 360 } } },
      { id: "drain-pan", name: "Condensate Drain Pan", material: BODY.name, solid: { kind: "box", origin: { x: -120, y: 0, z: 75 }, size: { x: 240, y: "[Casing Width] - 80mm", z: 30 } } },
      { id: "fan", name: "Supply Fan", material: DARK.name, solid: { kind: "cylinder", axis: "x", base: { x: 220, y: 0, z: 260 }, radius: 180, height: 220 } },
      { id: "collar-out", name: "Supply Collar", material: BODY.name, solid: { kind: "box", origin: { x: 630, y: 0, z: 160 }, size: { x: 60, y: 400, z: 300 } } },
    ],
    connectors: [
      rectConn("in", "Return Air", { x: -600, y: 0, z: 300 }, { x: -1, y: 0, z: 0 }, 500, 400),
      rectConn("out", "Supply Air", { x: 660, y: 0, z: 310 }, { x: 1, y: 0, z: 0 }, 400, 300),
    ],
  };
}

export function createStubGenerator(testCase, mode) {
  return async () => {
    const spec =
      mode === "before" && testCase.supportsMacro
        ? preMacroTrayBox(testCase)
        : testCase.supportsMacro
          ? afterMacroTray(testCase)
          : nonMacroSpec(testCase);
    return { json: spec, text: "", usage: null };
  };
}
