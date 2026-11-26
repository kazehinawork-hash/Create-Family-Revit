import { analyzeSpec, expandMacros } from "@family/spec-core";
import { config } from "../config.js";
import { normalizeText as normalizeRequest } from "../router.js";

/** Default materials used to auto-heal missing material references */
const DEFAULT_MATERIAL_PALETTE = {
  steel: { color: "#8a9ba8", metalness: 0.8, roughness: 0.3 },
  "stainless steel": { color: "#c0c0c0", metalness: 0.9, roughness: 0.2 },
  copper: { color: "#b87333", metalness: 0.85, roughness: 0.3 },
  brass: { color: "#d4af37", metalness: 0.8, roughness: 0.35 },
  aluminum: { color: "#dcdcdc", metalness: 0.7, roughness: 0.4 },
  "cast iron": { color: "#4a4a4a", metalness: 0.7, roughness: 0.6 },
  rubber: { color: "#222222", metalness: 0.05, roughness: 0.9 },
  plastic: { color: "#f0f0f0", metalness: 0.1, roughness: 0.5 },
  pvc: { color: "#e8e8e8", metalness: 0.1, roughness: 0.4 },
  glass: { color: "#a8c0d0", metalness: 0.1, roughness: 0.1 },
  clearance: { color: "#ff8c00", metalness: 0.0, roughness: 1.0 },
};

function note(spec, message) {
  if (!Array.isArray(spec.notes)) spec.notes = [];
  if (!spec.notes.includes(message)) spec.notes.push(message);
}

/**
 * Revit's family SweptBlend takes exactly two profiles. The studio preview keeps
 * every loft section, so a longer loft would build differently in the .rfa.
 * Split it into chained two-section lofts instead of silently losing the middle.
 */
function splitLongLofts(spec) {
  if (!Array.isArray(spec.parts)) return;

  const usedIds = new Set(
    spec.parts.map((part) => (part && typeof part.id === "string" ? part.id : "")).filter(Boolean),
  );
  const next = [];
  const notes = [];

  for (const part of spec.parts) {
    const sections = part?.solid?.kind === "loft" ? part.solid.sections : null;
    if (!Array.isArray(sections) || sections.length <= 2) {
      next.push(part);
      continue;
    }

    if ((Array.isArray(part.cuts) && part.cuts.length > 0) || part.array) {
      next.push(part);
      continue;
    }

    const count = sections.length - 1;
    const baseId = part.id || "loft";
    const baseName = part.name || "Loft";

    for (let index = 0; index < count; index += 1) {
      let id = `${baseId}-seg${index + 1}`;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-seg${index + 1}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);

      next.push({
        ...part,
        id,
        name: `${baseName} ${index + 1}/${count}`,
        solid: {
          ...part.solid,
          sections: [sections[index], sections[index + 1]],
        },
      });
    }

    notes.push(
      `Đã tách loft "${baseName}" thành ${count} đoạn 2-section để studio và .rfa khớp nhau.`,
    );
  }

  spec.parts = next;
  if (notes.length > 0) {
    if (!Array.isArray(spec.notes)) spec.notes = [];
    spec.notes.push(...notes);
  }
}

/** `[ladder height]` in a formula must match the declared `Ladder Height`. */
function fixFormulaCasing(spec) {
  const byName = new Map(
    (spec.parameters ?? [])
      .filter((param) => param?.name)
      .map((param) => [param.name.toLowerCase(), param.name]),
  );

  for (const param of spec.parameters ?? []) {
    if (typeof param?.formula !== "string") continue;
    let changed = false;

    param.formula = param.formula.replace(/\[([^\]]+)\]/g, (match, name) => {
      const canonical = byName.get(String(name).trim().toLowerCase());
      if (!canonical || canonical === name) return match;
      changed = true;
      return `[${canonical}]`;
    });

    if (changed) note(spec, `Đã sửa tên tham số trong công thức của ${param.name}.`);
  }
}

/** A formula that references a parameter that does not exist cannot be evaluated. */
function fixMissingFormulaParameters(spec) {
  const existing = new Set(
    (spec.parameters ?? []).filter((param) => param?.name).map((param) => param.name.toLowerCase()),
  );

  for (const param of [...(spec.parameters ?? [])]) {
    if (typeof param?.formula !== "string") continue;

    for (const match of param.formula.matchAll(/\[([^\]]+)\]/g)) {
      const name = match[1].trim();
      if (!name || existing.has(name.toLowerCase())) continue;

      spec.parameters.push({
        name,
        type: "Length",
        group: "Dimensions",
        instance: false,
        value: 0,
      });
      existing.add(name.toLowerCase());
      note(
        spec,
        `Đã thêm tham số còn thiếu ${name} (giá trị 0) để công thức ${param.name} chạy được.`,
      );
    }
  }
}

/** Every part needs a material that exists in the palette. */
function fixPartMaterials(spec) {
  const names = new Set(
    (spec.materials ?? []).filter((material) => material?.name).map((material) => material.name),
  );

  for (const part of spec.parts ?? []) {
    if (!part || part.element || part.instanceOf) continue;
    const material = typeof part.material === "string" ? part.material.trim() : "";

    if (material && !names.has(material)) {
      const fallback = spec.materials?.[0]?.name ?? null;
      if (fallback) {
        part.material = fallback;
        note(
          spec,
          `Đã gán vật liệu ${fallback} cho part ${part.name ?? part.id} (vật liệu cũ không tồn tại).`,
        );
      }
      continue;
    }

    if (!material) {
      const fallback = spec.materials?.[0]?.name;
      if (fallback) {
        part.material = fallback;
        note(spec, `Đã gán vật liệu mặc định ${fallback} cho part ${part.name ?? part.id}.`);
      }
    }
  }
}

function numericPartBounds(part) {
  const solid = part?.solid;
  if (!solid) return null;

  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

  if (solid.kind === "box" && solid.origin && solid.size) {
    const ox = num(solid.origin.x);
    const oy = num(solid.origin.y);
    const oz = num(solid.origin.z);
    const sx = num(solid.size.x);
    const sy = num(solid.size.y);
    const sz = num(solid.size.z);
    if ([ox, oy, oz, sx, sy, sz].some((value) => value === null)) return null;
    return {
      min: { x: ox - sx / 2, y: oy - sy / 2, z: oz - sz / 2 },
      max: { x: ox + sx / 2, y: oy + sy / 2, z: oz + sz / 2 },
    };
  }

  if ((solid.kind === "prism" || solid.kind === "loft") && Array.isArray(solid.points)) {
    const xs = solid.points.map((point) => num(point?.[0])).filter((value) => value !== null);
    const ys = solid.points.map((point) => num(point?.[1])).filter((value) => value !== null);
    if (xs.length === 0 || ys.length === 0) return null;
    return {
      min: { x: Math.min(...xs), y: Math.min(...ys), z: num(solid.from) ?? 0 },
      max: { x: Math.max(...xs), y: Math.max(...ys), z: num(solid.to) ?? 0 },
    };
  }

  return null;
}

/**
 * A part parked far outside the family (a typo like 40000 for 400) is pulled back to
 * the nearest face of the model. Only numeric geometry is touched.
 */
function fixPartsOutsideBounds(spec) {
  const entries = (spec.parts ?? [])
    .map((part) => ({ part, box: numericPartBounds(part) }))
    .filter((entry) => entry.box)
    .map((entry) => ({
      ...entry,
      center: {
        x: (entry.box.min.x + entry.box.max.x) / 2,
        y: (entry.box.min.y + entry.box.max.y) / 2,
        z: (entry.box.min.z + entry.box.max.z) / 2,
      },
      diagonal: Math.hypot(
        entry.box.max.x - entry.box.min.x,
        entry.box.max.y - entry.box.min.y,
        entry.box.max.z - entry.box.min.z,
      ),
    }));

  if (entries.length < 2) return;

  const maxDiagonal = Math.max(...entries.map((entry) => entry.diagonal));
  if (!Number.isFinite(maxDiagonal) || maxDiagonal <= 0) return;

  const limit = maxDiagonal * 20;
  const cluster = entries.filter(
    (entry) => Math.hypot(entry.center.x, entry.center.y, entry.center.z) <= limit,
  );
  if (cluster.length === 0) return;

  const min = {
    x: Math.min(...cluster.map((entry) => entry.box.min.x)),
    y: Math.min(...cluster.map((entry) => entry.box.min.y)),
    z: Math.min(...cluster.map((entry) => entry.box.min.z)),
  };
  const max = {
    x: Math.max(...cluster.map((entry) => entry.box.max.x)),
    y: Math.max(...cluster.map((entry) => entry.box.max.y)),
    z: Math.max(...cluster.map((entry) => entry.box.max.z)),
  };

  for (const { part, box } of entries) {
    const distance = Math.hypot(
      (box.min.x + box.max.x) / 2,
      (box.min.y + box.max.y) / 2,
      (box.min.z + box.max.z) / 2,
    );
    if (distance <= limit) continue;

    const solid = part.solid;
    if (solid.kind === "box" && typeof solid.origin.x === "number") {
      solid.origin = {
        x: Math.min(Math.max(solid.origin.x, min.x), max.x),
        y: Math.min(Math.max(solid.origin.y, min.y), max.y),
        z: Math.min(Math.max(solid.origin.z, min.z), max.z),
      };
      note(spec, `Đã kéo part ${part.name ?? part.id} về trong phạm vi family (nằm ngoài bounds).`);
    } else if (Array.isArray(solid.points)) {
      const dx = Math.min(Math.max(box.min.x, min.x), max.x) - box.min.x;
      const dy = Math.min(Math.max(box.min.y, min.y), max.y) - box.min.y;
      solid.points = solid.points.map((point) =>
        Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number"
          ? [point[0] + dx, point[1] + dy, ...point.slice(2)]
          : point,
      );
      note(spec, `Đã kéo part ${part.name ?? part.id} về trong phạm vi family (nằm ngoài bounds).`);
    }
  }
}

/** A connector must sit on an axis: a diagonal direction vector is never valid. */
function fixConnectorAxes(spec) {
  for (const connector of spec.connectors ?? []) {
    const direction = connector?.directionVector;
    if (!direction || typeof direction !== "object") continue;

    const axes = ["x", "y", "z"].map((axis) => ({
      axis,
      value: Number(direction[axis]) || 0,
    }));
    axes.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    const dominant = axes[0];
    const offAxis = axes.slice(1).some((entry) => Math.abs(entry.value) > 1e-6);
    if (!offAxis || Math.abs(dominant.value) < 1e-6) continue;

    connector.directionVector = {
      x: dominant.axis === "x" ? Math.sign(dominant.value) : 0,
      y: dominant.axis === "y" ? Math.sign(dominant.value) : 0,
      z: dominant.axis === "z" ? Math.sign(dominant.value) : 0,
    };
    note(spec, `Đã chỉnh hướng connector ${connector.id} về đúng trục ${dominant.axis}.`);
  }
}

/**
 * Deterministic Auto-Healer / Sanitizer.
 * Corrects trivial or deterministic spec errors before running analyzeSpec or calling LLM retry.
 */
export function autoHealSpec(spec, { allowMacros = config.agent.useMacros } = {}) {
  if (!spec || typeof spec !== "object") return spec;

  if (!spec.schemaVersion) spec.schemaVersion = "1.0";
  if (!spec.units) spec.units = "mm";
  if (typeof spec.name !== "string" || !spec.name.trim()) spec.name = "Parametric Component";
  if (typeof spec.category !== "string" || !spec.category.trim()) spec.category = "Generic Model";

  const catText = String(spec.category).toLowerCase();
  if (
    /cable\s*tray\s*fitting|cable\s*ladder\s*fitting|phụ\s*kiện\s*(thang|máng)\s*cáp/.test(catText)
  ) {
    spec.category = "Cable Tray Fitting";
  }
  const catLower = spec.category.toLowerCase().replace(/[^a-z0-9]/g, "");
  const catMap = {
    genericmodel: "Generic Model",
    genericmodels: "Generic Model",
    cabletrayfitting: "Cable Tray Fitting",
    cabletrayfittings: "Cable Tray Fitting",
    cableladderfitting: "Cable Tray Fitting",
    cableladderfittings: "Cable Tray Fitting",
    pipefitting: "Pipe Fitting",
    pipefittings: "Pipe Fitting",
    pipeaccessory: "Pipe Fitting",
    pipeaccessories: "Pipe Fitting",
    pipevalve: "Pipe Fitting",
    pipevalves: "Pipe Fitting",
    ductfitting: "Duct Fitting",
    ductfittings: "Duct Fitting",
    ductaccessory: "Duct Fitting",
    ductaccessories: "Duct Fitting",
    ductelbow: "Duct Elbow",
    ducttransition: "Duct Transition",
    ducttee: "Duct Tee",
    ductcross: "Duct Cross",
    mechanicalequipment: "Mechanical Equipment",
    plumbingfixture: "Plumbing Fixture",
    plumbingfixtures: "Plumbing Fixture",
    electricalequipment: "Electrical Equipment",
    electricalfixture: "Lighting Fixture",
    electricalfixtures: "Lighting Fixture",
    lightingfixture: "Lighting Fixture",
    lightingfixtures: "Lighting Fixture",
    specialtyequipment: "Specialty Equipment",
    furniture: "Furniture",
    casework: "Casework",
    door: "Door",
    window: "Window",
  };
  if (catMap[catLower]) {
    spec.category = catMap[catLower];
  }

  if (allowMacros && Array.isArray(spec.macros) && spec.macros.length > 0) {
    const expanded = expandMacros(spec);
    if (Array.isArray(expanded.spec?.parts)) spec.parts = expanded.spec.parts;
    if (Array.isArray(expanded.spec?.connectors)) spec.connectors = expanded.spec.connectors;
  }

  if (!Array.isArray(spec.parameters)) {
    spec.parameters = [];
  } else {
    for (const param of spec.parameters) {
      if (!param || typeof param !== "object") continue;
      if (typeof param.formula === "string" && param.formula.trim()) {
        param.formula = param.formula.trim();
        if (!param.type || param.type === "Length") {
          param.formula = param.formula.replace(
            /(\[[^\]]+\]\s*[-+]\s*)(\d+(?:\.\d+)?)(?![0-9.])(?!\s*(?:mm|cm|m|ft|in|deg|°|\*|\/|[a-zA-Z]))/g,
            "$1$2mm",
          );
        }
        delete param.value;
      }
      if (param.type === "Integer" && typeof param.value === "number") {
        param.value = Math.round(param.value);
      }
    }
  }

  if (!Array.isArray(spec.materials)) {
    spec.materials = [];
  }
  const existingMats = new Map(
    spec.materials
      .filter((m) => m && typeof m.name === "string")
      .map((m) => [m.name.trim().toLowerCase(), m]),
  );

  if (Array.isArray(spec.parts)) {
    for (let i = 0; i < spec.parts.length; i++) {
      const part = spec.parts[i];
      if (!part || typeof part !== "object") continue;

      if (!part.id || typeof part.id !== "string") {
        part.id = `part_${i + 1}`;
      }
      if (!part.name || typeof part.name !== "string") {
        part.name = `Part ${i + 1}`;
      }

      const matName = typeof part.material === "string" ? part.material.trim() : "";
      if (matName) {
        const lowerMat = matName.toLowerCase();
        if (!existingMats.has(lowerMat)) {
          let foundStyle = { color: "#8a9ba8", metalness: 0.5, roughness: 0.5 };
          for (const [key, val] of Object.entries(DEFAULT_MATERIAL_PALETTE)) {
            if (lowerMat.includes(key)) {
              foundStyle = val;
              break;
            }
          }
          const newMat = {
            name: matName,
            color: foundStyle.color,
            metalness: foundStyle.metalness,
            roughness: foundStyle.roughness,
          };
          spec.materials.push(newMat);
          existingMats.set(lowerMat, newMat);
        }
      }

      const checkAndClampCylinder = (solid) => {
        if (!solid || typeof solid !== "object") return;
        if (solid.kind === "cylinder") {
          const r = Number(solid.radius);
          const ir = Number(solid.innerRadius);
          if (Number.isFinite(r) && Number.isFinite(ir) && ir >= r && r > 0) {
            solid.innerRadius = Math.round(r * 0.8 * 100) / 100;
          }
        }
      };

      checkAndClampCylinder(part.solid);
      if (Array.isArray(part.cuts)) {
        for (const cut of part.cuts) {
          checkAndClampCylinder(cut);
        }
      }
    }

    splitLongLofts(spec);
  }

  if (Array.isArray(spec.connectors)) {
    for (let i = 0; i < spec.connectors.length; i++) {
      const conn = spec.connectors[i];
      if (!conn || typeof conn !== "object") continue;
      if (!conn.id) conn.id = `conn_${i + 1}`;
      if (!conn.systemType) conn.systemType = "SupplyAir";
    }
  }

  fixFormulaCasing(spec);
  fixMissingFormulaParameters(spec);
  fixPartMaterials(spec);
  fixConnectorAxes(spec);
  fixPartsOutsideBounds(spec);

  return spec;
}

/**
 * A brief may name parameters the model did not declare, and the user should not
 * get a "not complete" warning because of it. Insert them with the brief's value.
 */
export function fillMissingParameters(spec, checklist) {
  if (!spec || !Array.isArray(spec.parameters)) return spec;

  const wanted = checklist?.parameters ?? [];
  if (wanted.length === 0) return spec;

  const existing = new Set(spec.parameters.map((param) => normalizeRequest(param?.name)));

  for (const parameter of wanted) {
    const name = String(parameter?.name ?? "").trim();
    const value = Number(parameter?.value);
    if (!name || !Number.isFinite(value) || value <= 0) continue;
    if (existing.has(normalizeRequest(name))) continue;

    spec.parameters.push({
      name,
      type: "Length",
      group: "Dimensions",
      instance: false,
      value,
    });
    existing.add(normalizeRequest(name));

    if (!Array.isArray(spec.notes)) spec.notes = [];
    spec.notes.push(`Đã thêm tham số ${name} = ${value} theo yêu cầu.`);
  }

  return spec;
}

/** Bounding box + part count of a spec, used to spot a model that redesigned everything. */
export function boundsOf(spec) {
  if (!spec) return null;
  try {
    const analysis = analyzeSpec(spec);
    const bounds = analysis?.model?.bounds;
    if (!bounds) return null;
    return { x: bounds.size.x, y: bounds.size.y, z: bounds.size.z, parts: spec.parts?.length ?? 0 };
  } catch {
    return null;
  }
}

export function geometryDrift(before, afterBounds, beforeSpec, afterSpec) {
  if (!before || !afterBounds) return null;

  const after = { x: afterBounds.size.x, y: afterBounds.size.y, z: afterBounds.size.z };
  const ratio = (a, b) => (a > 1 && b > 1 ? Math.max(a / b, b / a) : 1);
  const worst = Math.max(
    ratio(before.x, after.x),
    ratio(before.y, after.y),
    ratio(before.z, after.z),
  );
  const partsBefore = before.parts;
  const partsAfter = afterSpec?.parts?.length ?? partsBefore;

  if (worst <= 3 && Math.abs(partsAfter - partsBefore) <= 5) return null;

  return (
    `Kích thước thay đổi lớn so với trước (${Math.round(before.x)}×${Math.round(before.y)}×${Math.round(before.z)}` +
    ` → ${Math.round(after.x)}×${Math.round(after.y)}×${Math.round(after.z)} mm, ${partsBefore} → ${partsAfter} part)` +
    " — kiểm tra lại nếu bạn chỉ muốn thay đổi cục bộ."
  );
}
