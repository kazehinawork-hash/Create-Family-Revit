import fs from "node:fs";

/**
 * Engineering standard tables. Everything here is pure data + lookups so the
 * designer can resolve real dimensions instead of guessing them.
 */

const load = (name) => JSON.parse(fs.readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8"));

export const TABLES = {
  flanges: load("flanges"),
  bolts: load("bolts"),
  motors: load("motors"),
  pipe: load("pipe"),
  misc: load("misc"),
};

function nearestRow(rows, value) {
  const target = Number(value);
  if (!Number.isFinite(target)) return null;

  let best = null;
  for (const [key, row] of Object.entries(rows)) {
    const candidate = Number(key);
    if (!Number.isFinite(candidate)) continue;
    if (!best || Math.abs(candidate - target) < Math.abs(Number(best.key) - target)) {
      best = { key, row, value: candidate };
    }
  }
  return best ? { ...best.row, nominal: best.value } : null;
}

function flangeFamily(standard, pn) {
  const text = String(standard ?? "").toLowerCase();
  if (text.includes("ansi") || text.includes("class 150") || text.includes("asme")) return "ANSI150";
  if (text.includes("jis") || text.includes("10k")) return "JIS10K";
  return Number(pn) <= 10 ? "EN1092-1_PN10" : "EN1092-1_PN16";
}

/** Flange dimensions for a DN (OD, PCD, bolt count/size, thickness). */
export function flangeFor(dn, { standard = "EN 1092-1", pn = 16 } = {}) {
  const family = flangeFamily(standard, pn);
  const table = TABLES.flanges[family];
  if (!table) return null;

  const row = nearestRow(table.rows, dn);
  if (!row) return null;

  return {
    dn: row.nominal,
    standard: table.standard,
    pn: table.pn,
    od: row.od,
    pcd: row.pcd,
    bolts: row.bolts,
    bolt: row.bolt,
    thickness: row.thickness,
  };
}

export function boltFor(size) {
  const key = String(size ?? "").toUpperCase().replace(/\s+/g, "");
  const row = TABLES.bolts.rows[key];
  return row ? { size: key, ...row } : null;
}

export function motorForPower(kW) {
  const row = nearestRow(TABLES.motors.rows, kW);
  return row ? { power: row.nominal, frame: row.frame, H: row.H, A: row.A, B: row.B, shaft: row.shaft } : null;
}

export function pipeOD(dn, material = "steel") {
  const table = TABLES.pipe[String(material).toLowerCase()] ?? TABLES.pipe.steel;
  const row = nearestRow(table, dn);
  return row ? row.nominal : null;
}

export function cableGland(size) {
  const key = String(size ?? "").toUpperCase();
  const row = TABLES.misc.cableGlands.rows[key];
  return row ? { size: key, ...row } : null;
}

/** Snap a requested duct size to the standard manufacturing grid. */
export function ductSize(width, height) {
  const grid = TABLES.misc.duct;
  const snap = (value, list) =>
    list.reduce((best, candidate) =>
      Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
    );

  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { width: snap(w, grid.widths), height: snap(h, grid.heights) };
}

export function sheetThickness(value) {
  const row = nearestRow(TABLES.misc.sheetGauge.rows, value);
  return row ? row.nominal : null;
}

export function dinRail(kind = "TS35") {
  return TABLES.misc.dinRail.rows[kind] ?? TABLES.misc.dinRail.rows.TS35;
}

export function enclosureDoor() {
  return TABLES.misc.doors.enclosure;
}

/** A short block the model prompt can use as fixed reference data. */
export function standardsBlock({ flange = null, motor = null, pipe = null, duct = null } = {}) {
  const lines = [];
  if (flange) lines.push(`- Flange ${flange.standard} DN${flange.dn}: OD ${flange.od}, PCD ${flange.pcd}, ${flange.bolts}×${flange.bolt}, dày ${flange.thickness} mm`);
  if (motor) lines.push(`- Motor IEC ${motor.frame} (${motor.power} kW): H=${motor.H}, chân A=${motor.A} B=${motor.B}, trục Ø${motor.shaft}`);
  if (pipe) lines.push(`- Ống DN${pipe.dn}: OD ${pipe.od} mm`);
  if (duct) lines.push(`- Ống gió chuẩn ${duct.width}×${duct.height} mm`);
  return lines.join("\n");
}
