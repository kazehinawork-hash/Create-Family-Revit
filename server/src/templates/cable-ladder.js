/**
 * Parametric cable-ladder templates.
 *
 * These are deterministic spec builders: for a known family (tee / elbow / cross)
 * the geometry is generated locally instead of asking a model to draw it. The
 * model is only needed for the differences the user asks on top.
 */

const DEFAULTS = {
  ladderWidth1: 400,
  ladderWidth2: 300,
  ladderHeight: 100,
  sheetThickness: 1.8,
  flangeWidth: 15,
  safetyLip: 5,
  tangentLength: 120,
  miterOffset: 150,
  rungWidth: 35,
  rungHeight: 15,
  rungThickness: 1.5,
  rungHoleLength: 25,
  rungHoleWidth: 9,
  rungCount: 6,
};

const MATERIALS = [
  { name: "ThinhPhat_PowderCoated_RAL7035", color: "#d7d7d7", metalness: 0.2, roughness: 0.6 },
  { name: "ThinhPhat_Galvanized_HotDip", color: "#b8c0c8", metalness: 0.75, roughness: 0.35 },
];

const BODY_MATERIAL = MATERIALS[0].name;
const RUNG_MATERIAL = MATERIALS[1].name;

/** Which template family a request belongs to, or null. */
export function matchTemplateFamily(prompt) {
  const text = String(prompt ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();

  if (/nga\s*tu|cross|chu\s*thap|four\s*way/.test(text)) return "cross";
  if (/nga\s*ba|\btee\b|three\s*way/.test(text)) return "tee";
  if (/\belbow\b|\bbend\b|khuyu|co\s*90|90\s*do/.test(text)) return "elbow";
  if (/thang\s*cap|cable\s*ladder|cable\s*tray|mitered/.test(text)) return "cross";
  return null;
}

/** Numbers mentioned in the prompt override the template defaults. */
export function extractTemplateOptions(prompt) {
  const text = String(prompt ?? "");
  // Only the values actually found; the spec builders merge their own defaults so a
  // caller can layer resolved evidence on top without defaults winning.
  const options = {};

  const read = (patterns) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const value = Number(String(match[1]).replace(",", "."));
        if (Number.isFinite(value) && value > 0) return value;
      }
    }
    return null;
  };

  const w1 = read([
    /\bw1\s*=\s*(\d+(?:[.,]\d+)?)/i,
    /ladder\s*width\s*1[`"]?\s*[=:]?\s*(\d+(?:[.,]\d+)?)/i,
  ]);
  const w2 = read([
    /\bw2\s*=\s*(\d+(?:[.,]\d+)?)/i,
    /ladder\s*width\s*2[`"]?\s*[=:]?\s*(\d+(?:[.,]\d+)?)/i,
  ]);
  const height = read([
    /\bh\s*=\s*(\d+(?:[.,]\d+)?)/i,
    /ladder\s*height[`"]?\s*[=:]?\s*(\d+(?:[.,]\d+)?)/i,
  ]);
  const tangent = read([/tangent(?:\s*length)?[`"]?\s*[=:]?\s*(\d+(?:[.,]\d+)?)/i]);
  const miter = read([/miter[_ ]?offset[`"]?\s*[=:]?\s*(\d+(?:[.,]\d+)?)/i]);
  const rungs = read([/(\d+)\s*(?:bậc|bac|rung)/i]);

  if (w1) options.ladderWidth1 = w1;
  if (w2) options.ladderWidth2 = w2;
  if (height) options.ladderHeight = height;
  if (tangent) options.tangentLength = tangent;
  if (miter) options.miterOffset = miter;
  if (rungs) options.rungCount = rungs;

  // "400x400x100" also sets the two widths and the height — but never the size of a
  // sentence like "bounding box 940 x 940 x 100", which describes the result.
  const triples = [...text.matchAll(/(\d{2,4})\s*x\s*(\d{2,4})\s*x\s*(\d{2,4})/gi)];
  const triple = triples.find((match) => {
    const prefix = text.slice(Math.max(0, match.index - 48), match.index);
    return !/(bounding|bbox|kiem tra|check|kích thước tổng|kich thuoc tong)/i.test(prefix);
  });

  if (triple && !(w1 && w2 && height)) {
    options.ladderWidth1 = Number(triple[1]);
    options.ladderWidth2 = Number(triple[2]);
    options.ladderHeight = Number(triple[3]);
  }

  return options;
}

function param(name, type, extra = {}) {
  return { name, type, group: "Dimensions", instance: false, ...extra };
}

function boxPart(id, name, material, origin, size, cuts = []) {
  return { id, name, material, solid: { kind: "box", origin, size }, cuts };
}

function prismPart(id, name, material, points, from, to) {
  return { id, name, material, solid: { kind: "prism", plane: "xy", points, from, to }, cuts: [] };
}

function rungPart(index, length, at) {
  const z = "[Rung Z Base]";
  const origin = { x: at.x, y: at.y, z: `${z} + [Rung Height] / 2` };

  // thinX = the rung is thin along X and spans the tray across Y.
  const size = at.thinX
    ? { x: "[Rung Width]", y: length, z: "[Rung Height]" }
    : { x: length, y: "[Rung Width]", z: "[Rung Height]" };
  const cutSize = at.thinX
    ? { x: "[Rung Thickness] + 2", y: "[Rung Hole Length]", z: "[Rung Hole Width]" }
    : { x: "[Rung Hole Length]", y: "[Rung Thickness] + 2", z: "[Rung Hole Width]" };

  return boxPart(`rung-${index}`, `Rung ${index}`, RUNG_MATERIAL, origin, size, [
    { kind: "box", origin, size: cutSize },
  ]);
}

function connector(id, name, x, y, direction, widthParameter) {
  return {
    id,
    name,
    systemType: "CableTray",
    shape: "rectangular",
    direction: direction[`${Object.keys(direction)[0]}`] > 0 ? "out" : "in",
    host: "reference-plane",
    origin: { x, y, z: "[Ladder Height] / 2" },
    directionVector: direction,
    width: widthParameter,
    height: "[Ladder Height]",
  };
}

function baseParameters(options) {
  return [
    param("Ladder Width 1", "Length", { value: options.ladderWidth1 }),
    param("Ladder Width 2", "Length", { value: options.ladderWidth2 }),
    param("Ladder Height", "Length", { value: options.ladderHeight }),
    param("Sheet Thickness", "Length", { value: options.sheetThickness }),
    param("Flange Width", "Length", { value: options.flangeWidth }),
    param("Safety Lip", "Length", { value: options.safetyLip }),
    param("Tangent Length", "Length", { value: options.tangentLength }),
    param("Miter Offset", "Length", { value: options.miterOffset }),
    param("Rung Width", "Length", { value: options.rungWidth }),
    param("Rung Height", "Length", { value: options.rungHeight }),
    param("Rung Thickness", "Length", { value: options.rungThickness }),
    param("Rung Hole Length", "Length", { value: options.rungHoleLength }),
    param("Rung Hole Width", "Length", { value: options.rungHoleWidth }),
    param("Rung Z Base", "Length", { formula: "[Sheet Thickness]" }),
  ];
}

/** One L-shaped C-channel wall per quadrant, so the four arms meet at 45°. */
function cornerParts(quadrant) {
  const { sx, sy } = quadrant;
  const halfWidth1 = "[Ladder Width 1] / 2";
  const halfWidth2 = "[Ladder Width 2] / 2";

  // L band: outer edges of the quadrant (x in [0..X], y in [0..Y]) with the mirror
  // applied through sx/sy, so each quadrant covers one corner of the cross.
  const points = [
    [`${sx} * [Total Length X] / 2`, "0"],
    [`${sx} * [Total Length X] / 2`, `${sy} * ${halfWidth1}`],
    [`${sx} * ${halfWidth2}`, `${sy} * ${halfWidth1}`],
    [`${sx} * ${halfWidth2}`, `${sy} * [Total Length Y] / 2`],
    ["0", `${sy} * [Total Length Y] / 2`],
    ["0", "0"],
  ];

  const label = `${sx > 0 ? "East" : "West"} ${sy > 0 ? "North" : "South"}`;
  const slug = `${sx > 0 ? "e" : "w"}${sy > 0 ? "n" : "s"}`;

  return [
    prismPart(`corner-${slug}-web`, `Corner Rail ${label} Web`, BODY_MATERIAL, points, 0, "[Ladder Height]"),
    prismPart(
      `corner-${slug}-top`,
      `Corner Rail ${label} Top Flange`,
      BODY_MATERIAL,
      points,
      "[Ladder Height] - [Sheet Thickness]",
      "[Ladder Height]",
    ),
    prismPart(
      `corner-${slug}-bottom`,
      `Corner Rail ${label} Bottom Flange`,
      BODY_MATERIAL,
      points,
      0,
      "[Sheet Thickness]",
    ),
  ];
}

function rungs(count) {
  const total = Math.max(1, Math.round(count));
  const parts = [];
  const span = "[Ladder Width 1]";
  for (let index = 0; index < total; index += 1) {
    // Spread the rungs along X, inside the two side walls.
    const ratio = (index + 1) / (total + 1);
    const x = `(${ratio.toFixed(4)} - 0.5) * ([Total Length X] - [Tangent Length])`;
    parts.push(rungPart(index + 1, span, { x, y: 0, thinX: true }));
  }
  return parts;
}

export function crossSpec(input = {}) {
  const options = { ...DEFAULTS, ladderWidth2: input.ladderWidth2 ?? 400, ...input };

  const parameters = [
    ...baseParameters(options),
    param("Miter Leg", "Length", { formula: "[Miter Offset]" }),
    param("Clear Width 1", "Length", { formula: "[Ladder Width 1] - 2 * [Sheet Thickness]" }),
    param("Clear Width 2", "Length", { formula: "[Ladder Width 2] - 2 * [Sheet Thickness]" }),
    param("Total Length X", "Length", {
      formula: "[Ladder Width 1] + 2 * [Tangent Length] + 2 * [Miter Leg]",
    }),
    param("Total Length Y", "Length", {
      formula: "[Ladder Width 2] + 2 * [Tangent Length] + 2 * [Miter Leg]",
    }),
    param("Corner Count", "Integer", { group: "Other", value: 4 }),
    param("Connector Count", "Integer", { group: "Other", value: 4 }),
  ];

  const parts = [
    ...cornerParts({ sx: 1, sy: 1 }),
    ...cornerParts({ sx: -1, sy: 1 }),
    ...cornerParts({ sx: -1, sy: -1 }),
    ...cornerParts({ sx: 1, sy: -1 }),
    ...rungs(options.rungCount),
  ];

  const connectors = [
    connector("main-in", "Main In (West)", "-[Total Length X] / 2", 0, { x: -1, y: 0, z: 0 }, "[Ladder Width 1]"),
    connector("main-out", "Main Out (East)", "[Total Length X] / 2", 0, { x: 1, y: 0, z: 0 }, "[Ladder Width 1]"),
    connector("branch-in", "Branch In (South)", 0, "-[Total Length Y] / 2", { x: 0, y: -1, z: 0 }, "[Ladder Width 2]"),
    connector("branch-out", "Branch Out (North)", 0, "[Total Length Y] / 2", { x: 0, y: 1, z: 0 }, "[Ladder Width 2]"),
  ];

  return {
    schemaVersion: "1.0",
    name: "Cable Ladder Mitered Cross",
    typeName: `TP-CLT-MX ${options.ladderWidth1}x${options.ladderWidth2}x${options.ladderHeight}`,
    category: "Electrical Equipment",
    units: "mm",
    description:
      "Ngã tư thang cáp vát góc (Mitered Cross): 4 cụm thành góc vát 45° chữ C, " +
      "6 bậc thang có lỗ rãnh và 4 connector trên reference plane.",
    parameters,
    materials: MATERIALS.map((material) => ({ ...material })),
    parts,
    connectors,
    notes: [
      "Khuôn mẫu Mitered Cross dựng sẵn: 4 thành góc vát 45°, 6 bậc thang có lỗ rãnh, 4 connector.",
      "Total Length X = Total Length Y = W + 2×Tangent + 2×Miter Offset.",
      ...assumptionNotes(options),
    ],
  };
}

function straightArm(sign) {
  const { sx, sy } = sign;
  const points = [
    ["0", "0"],
    [`${sx} * [Total Length X] / 2`, "0"],
    [`${sx} * [Total Length X] / 2`, `${sy} * [Ladder Width 1] / 2`],
    ["0", `${sy} * [Ladder Width 1] / 2`],
  ];
  const label = sx > 0 ? "East" : "West";
  const slug = sx > 0 ? "e" : "w";

  return [
    prismPart(`corner-${slug}-web`, `Corner Rail ${label} Web`, BODY_MATERIAL, points, 0, "[Ladder Height]"),
    prismPart(
      `corner-${slug}-top`,
      `Corner Rail ${label} Top Flange`,
      BODY_MATERIAL,
      points,
      "[Ladder Height] - [Sheet Thickness]",
      "[Ladder Height]",
    ),
  ];
}

export function elbowSpec(input = {}) {
  const options = { ...DEFAULTS, ...input };

  const parameters = [
    ...baseParameters(options),
    param("Miter Leg", "Length", { formula: "[Miter Offset]" }),
    param("Clear Width 1", "Length", { formula: "[Ladder Width 1] - 2 * [Sheet Thickness]" }),
    param("Total Length X", "Length", {
      formula: "[Ladder Width 1] + [Tangent Length] + [Miter Leg]",
    }),
    param("Total Length Y", "Length", {
      formula: "[Ladder Width 2] + [Tangent Length] + [Miter Leg]",
    }),
    param("Connector Count", "Integer", { group: "Other", value: 2 }),
  ];

  const parts = [...straightArm({ sx: 1, sy: 1 }), ...straightArm({ sx: 1, sy: -1 })];

  const connectors = [
    connector("main-in", "Main In", "-[Total Length X]", 0, { x: -1, y: 0, z: 0 }, "[Ladder Width 1]"),
    connector("branch-out", "Branch Out", 0, "[Total Length Y]", { x: 0, y: 1, z: 0 }, "[Ladder Width 2]"),
  ];

  return {
    schemaVersion: "1.0",
    name: "Cable Ladder Mitered Elbow",
    typeName: `TP-CLT-EL ${options.ladderWidth1}x${options.ladderWidth2}x${options.ladderHeight}`,
    category: "Electrical Equipment",
    units: "mm",
    description: "Khuỷu thang cáp vát góc 90° (Mitered Elbow).",
    parameters,
    materials: MATERIALS.map((material) => ({ ...material })),
    parts: [...parts, ...rungs(Math.min(4, options.rungCount))],
    connectors,
    notes: [
      "Khuôn mẫu Mitered Elbow dựng sẵn: 2 thành góc vát, 2 connector.",
      ...assumptionNotes(options),
    ],
  };
}

export function teeSpec(input = {}) {
  const options = { ...DEFAULTS, ladderWidth2: 300, ...input };

  const parameters = [
    ...baseParameters(options),
    param("Miter Leg", "Length", { formula: "[Miter Offset]" }),
    param("Clear Width 1", "Length", { formula: "[Ladder Width 1] - 2 * [Sheet Thickness]" }),
    param("Clear Width 2", "Length", { formula: "[Ladder Width 2] - 2 * [Sheet Thickness]" }),
    param("Total Length X", "Length", {
      formula: "[Ladder Width 1] + 2 * [Tangent Length] + 2 * [Miter Leg]",
    }),
    param("Total Length Y", "Length", {
      formula: "[Ladder Width 2] + [Tangent Length] + [Miter Leg]",
    }),
    param("Total Branch Y", "Length", {
      formula: "[Total Length Y]",
    }),
    param("Connector Count", "Integer", { group: "Other", value: 3 }),
  ];

  const parts = [
    ...cornerParts({ sx: 1, sy: 1 }),
    ...cornerParts({ sx: -1, sy: 1 }),
    ...rungs(options.rungCount),
  ];

  const connectors = [
    connector("main-in", "Main In", "-[Total Length X] / 2", 0, { x: -1, y: 0, z: 0 }, "[Ladder Width 1]"),
    connector("main-out", "Main Out", "[Total Length X] / 2", 0, { x: 1, y: 0, z: 0 }, "[Ladder Width 1]"),
    connector("branch", "Branch", 0, "[Total Branch Y] / 2", { x: 0, y: 1, z: 0 }, "[Ladder Width 2]"),
  ];

  return {
    schemaVersion: "1.0",
    name: "Cable Ladder Mitered Tee",
    typeName: `TP-CLT-MT ${options.ladderWidth1}x${options.ladderWidth2}x${options.ladderHeight}`,
    category: "Electrical Equipment",
    units: "mm",
    description: "Ngã ba thang cáp vát góc (Mitered Tee).",
    parameters,
    materials: MATERIALS.map((material) => ({ ...material })),
    parts,
    connectors,
    notes: [
      "Khuôn mẫu Mitered Tee dựng sẵn: 2 thành góc vát, 3 connector.",
      ...assumptionNotes(options),
    ],
  };
}

export const FAMILY_DEFAULTS_TABLE = [
  ["Ladder Width", "400 mm (hoặc đúng số người dùng nêu)"],
  ["Ladder Height", "100 mm"],
  ["Sheet Thickness", "1.5–2.0 mm (1.8 mm cho khẩu độ 400 mm)"],
  ["Flange Width", "15 mm"],
  ["Safety Lip", "5 mm"],
  ["Rung Pitch", "300 mm"],
  ["Rung", "35 × 15 × 1.5 mm"],
  ["Tangent Length", "120 mm"],
  ["Miter Offset", "150 mm"],
];

/**
 * Standard values injected into the system prompt when the brief is a cable-ladder
 * family, so the model fills gaps instead of asking questions.
 */
export function familyDefaultsBlock(family) {
  if (!family) return "";

  const rows = FAMILY_DEFAULTS_TABLE.map(([name, value]) => `- ${name}: ${value}`).join("\n");
  return (
    `## Giá trị mặc định khi brief không nói (thang cáp – ${family})\n\n` +
    `${rows}\n\n` +
    "Dùng đúng các giá trị này cho phần brief không nêu, ghi từng giá trị đã dùng vào notes " +
    'theo dạng "Giả định: <tham số> = <giá trị> (<lý do>)". Không hỏi lại người dùng.'
  );
}

/** Notes describing the standard values a template used. */
function assumptionNotes(options) {
  return [
    `Giả định: Sheet Thickness = ${options.sheetThickness} mm (thép tấm tiêu chuẩn cho thang cáp).`,
    `Giả định: Flange Width = ${options.flangeWidth} mm, Safety Lip = ${options.safetyLip} mm (cạnh chấn tiêu chuẩn).`,
    `Giả định: Rung ${options.rungWidth} × ${options.rungHeight} × ${options.rungThickness} mm, bước rung 300 mm (catalog thang cáp).`,
    `Giả định: Tangent Length = ${options.tangentLength} mm, Miter Offset = ${options.miterOffset} mm (góc vát 45° tiêu chuẩn).`,
  ];
}

export function buildTemplateSpec(family, options = {}) {
  if (family === "cross") return crossSpec(options);
  if (family === "tee") return teeSpec(options);
  if (family === "elbow") return elbowSpec(options);
  return null;
}

export const TEMPLATE_DEFAULTS = DEFAULTS;
