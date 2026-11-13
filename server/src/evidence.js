import fs from "node:fs";
import path from "node:path";

import { extractDocumentText } from "./documents.js";
import {
  boltFor,
  ductSize,
  flangeFor,
  motorForPower,
  pipeOD,
} from "./standards/index.js";

/**
 * Evidence collection: whatever real numbers the user gave us (prompt, catalogue
 * text, photos, rendered catalogue pages), plus a deterministic parser that turns
 * them into level-1 values. Nothing here is product-specific.
 */

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const MAX_CATALOG_CHARS = 60000;
const MAX_PAGES = 6;

export function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(String(filePath)).toLowerCase());
}

export function mimeForFile(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

const number = (value) => Number(String(value).replace(",", "."));

/**
 * Deterministic extraction of real product numbers. No product type is assumed.
 */
export function parseEvidence(text) {
  const source = String(text ?? "");
  const dimensions = [];
  const codes = [];
  let dn = null;
  let nps = null;
  let pn = null;
  let ip = null;
  let powerKW = null;
  let flow = null;
  let size = null;

  const push = (name, value, extra = {}) => {
    if (!Number.isFinite(value) || value <= 0) return;
    if (dimensions.some((entry) => entry.name === name && entry.value === value)) return;
    dimensions.push({
      name,
      value,
      unit: extra.unit ?? "mm",
      level: 1,
      source: extra.source ?? "Người dùng/catalog",
      reasoning: extra.reasoning ?? "Số đọc trực tiếp từ brief hoặc catalog",
    });
  };

  // Product code such as TP-LC-400x100-1.5 (level 1). The code is parsed last so a
  // size written in the brief itself wins when the two disagree.
  for (const match of source.matchAll(/\b([A-Z]{2,}[A-Z0-9]*(?:-[A-Za-z0-9.]+){2,})\b/g)) {
    codes.push({ code: match[1], level: 1, source: "Mã sản phẩm" });
  }

  // "400x300x100", "400 × 100" — the brief's own numbers are level 1 and outrank a
  // catalogue code when the two disagree.
  for (const match of source.matchAll(/(?<![\w.])(\d{2,4})\s*[xX×]\s*(\d{2,4})(?:\s*[xX×]\s*(\d{2,4}))?/g)) {
    const a = number(match[1]);
    const b = number(match[2]);
    const c = match[3] ? number(match[3]) : null;
    if (size) continue;

    // Skip the size inside a product code; it is parsed below with its own source.
    const start = match.index ?? 0;
    const prefix = source.slice(Math.max(0, start - 12), start);
    if (/[A-Z]{2,}[A-Z0-9-]*[-_]$/.test(prefix)) continue;

    size = { a, b, c };
    push("Width", a, { reasoning: "Kích thước trong brief" });
    push("Height", b, { reasoning: "Kích thước trong brief" });
    if (c) push("Depth", c, { reasoning: "Kích thước trong brief" });
  }

  // Diameters / nominal sizes
  const diameter = source.match(/[Øø]\s*(\d{1,4}(?:[.,]\d+)?)/);
  if (diameter) push("Diameter", number(diameter[1]), { reasoning: "Ø ghi trong brief" });

  const dnMatch = source.match(/\bDN\s*(\d{1,4})\b/i);
  if (dnMatch) {
    dn = Number(dnMatch[1]);
    push("Nominal Size", dn, { reasoning: `DN${dn} trong brief` });
  }

  const npsMatch = source.match(/\bNPS\s*(\d{1,2})\b/i);
  if (npsMatch) nps = Number(npsMatch[1]);

  const pnMatch = source.match(/\bPN\s*(\d{1,3})\b/i) ?? source.match(/\bClass\s*(\d{2,4})\b/i);
  if (pnMatch) pn = Number(pnMatch[1]);

  const ipMatch = source.match(/\bIP\s*(\d{2})\b/i);
  if (ipMatch) ip = Number(ipMatch[1]);

  const powerMatch = source.match(/(\d+(?:[.,]\d+)?)\s*kW\b/i);
  if (powerMatch) {
    powerKW = number(powerMatch[1]);
    push("Motor Power", powerKW, { reasoning: `${powerKW} kW trong brief`, unit: "kW" });
  }

  const flowMatch =
    source.match(/(\d+(?:[.,]\d+)?)\s*m3\s*\/\s*h/i) ??
    source.match(/(\d+(?:[.,]\d+)?)\s*l\s*\/\s*s/i) ??
    source.match(/(\d+(?:[.,]\d+)?)\s*CFM/i);
  if (flowMatch) flow = { value: number(flowMatch[1]), unit: flowMatch[0] };

  const thicknessMatch = source.match(/\b(?:dày|thickness|t)\b\s*[=:]\s*(\d+(?:[.,]\d+)?)\s*mm/i);
  if (thicknessMatch) push("Thickness", number(thicknessMatch[1]), { reasoning: "Chiều dày ghi trong brief" });

  const boltMatch = source.match(/\bM\s?(\d{1,2})\b/);
  const bolt = boltMatch ? `M${boltMatch[1]}` : null;

  // A code only fills what the brief did not already state.
  for (const code of codes) {
    const sizeMatch = code.code.match(/(\d{2,4})\s*[xX×]\s*(\d{2,4})(?:\s*[xX×]\s*(\d{1,3}))?/);
    if (sizeMatch && !size) {
      const a = number(sizeMatch[1]);
      const b = number(sizeMatch[2]);
      size = { a, b, c: sizeMatch[3] ? number(sizeMatch[3]) : null };
      pushUnique("Width", a, `Mã ${code.code}`);
      pushUnique("Height", b, `Mã ${code.code}`);
      if (sizeMatch[3]) pushUnique("Depth", number(sizeMatch[3]), `Mã ${code.code}`);
    }

    const thicknessMatch = code.code.match(/[xX×]\s*\d{1,3}\s*[-xX×]\s*(\d+(?:[.,]\d+)?)\s*$/);
    if (thicknessMatch) {
      pushUnique("Thickness", number(thicknessMatch[1]), `Mã ${code.code}`);
    }
  }

  function pushUnique(name, value, reasoning) {
    if (dimensions.some((entry) => entry.name === name)) return;
    push(name, value, { reasoning, source: "Mã sản phẩm" });
  }

  return { text: source, dimensions, codes, dn, nps, pn, ip, powerKW, flow, size, bolt };
}

/**
 * Values that follow from a standard table once a nominal size is known.
 * These are level 4 (engineering standard), never overriding level 1-2.
 */
export function deriveStandardValues(parsed, productType = null) {
  const values = [];
  const type = String(productType ?? "");

  // Standard tables only make sense for the product families that use them.
  const wantsFlanges = ["valve", "pump", "pipe-support", "duct-fitting"].includes(type);
  const wantsMotor = ["fan", "pump", "ahu-fcu"].includes(type);
  const wantsDuct = type === "duct-fitting";

  if (parsed?.dn && wantsFlanges) {
    const flange = flangeFor(parsed.dn, { pn: parsed.pn ?? 16 });
    if (flange) {
      values.push(
        { name: "Flange OD", value: flange.od, level: 4, source: `EN 1092-1 PN${flange.pn} DN${flange.dn}` },
        { name: "Flange PCD", value: flange.pcd, level: 4, source: `EN 1092-1 PN${flange.pn}` },
        { name: "Flange Thickness", value: flange.thickness, level: 4, source: `EN 1092-1 PN${flange.pn}` },
        { name: "Flange Bolts", value: flange.bolts, unit: "", level: 4, source: `EN 1092-1 PN${flange.pn} (${flange.bolt})` },
      );

      const boltRow = boltFor(flange.bolt);
      if (boltRow) {
        values.push({
          name: "Bolt Hole",
          value: boltRow.hole,
          level: 4,
          source: `Lỗ ${flange.bolt} theo ISO 273`,
        });
      }
    }

    const od = pipeOD(parsed.dn, "steel");
    if (od) values.push({ name: "Pipe OD", value: od, level: 4, source: `EN 10255 DN${parsed.dn}` });
  }

  if (parsed?.powerKW && wantsMotor) {
    const motor = motorForPower(parsed.powerKW);
    if (motor) {
      values.push(
        { name: "Motor Frame", value: motor.frame, unit: "", level: 4, source: `IEC 60034 ${motor.power} kW` },
        { name: "Motor Shaft Height", value: motor.H, level: 4, source: `IEC ${motor.frame}` },
        { name: "Motor Foot A", value: motor.A, level: 4, source: `IEC ${motor.frame}` },
        { name: "Motor Foot B", value: motor.B, level: 4, source: `IEC ${motor.frame}` },
      );
    }
  }

  if (parsed?.size && wantsDuct) {
    const duct = ductSize(parsed.size.a, parsed.size.b);
    if (duct) {
      values.push(
        { name: "Duct Width", value: duct.width, level: 4, source: "Cỡ ống gió chuẩn" },
        { name: "Duct Height", value: duct.height, level: 4, source: "Cỡ ống gió chuẩn" },
      );
    }
  }

  return values;
}

/** CCTV/product photos attached by the user, ready to send to a vision model. */
export function imageAttachments(attachments = []) {
  return attachments
    .filter((file) => file?.path && isImageFile(file.path))
    .map((file) => ({
      path: file.path,
      name: file.name || path.basename(file.path),
      mime: mimeForFile(file.path),
    }));
}

/**
 * Render up to MAX_PAGES catalogue pages to PNG. pdfjs-dist + a canvas backend are
 * optional dependencies: when they are missing we report it instead of failing.
 */
export async function renderPdfPages(file, { maxPages = MAX_PAGES } = {}) {
  try {
    const [{ getDocument }, canvas] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("@napi-rs/canvas"),
    ]);

    const data = new Uint8Array(fs.readFileSync(file.path));
    const document = await getDocument({ data, disableWorker: true }).promise;
    const pages = [];

    for (let index = 1; index <= Math.min(maxPages, document.numPages); index += 1) {
      const page = await document.getPage(index);
      const viewport = page.getViewport({ scale: 1.4 });
      const target = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = target.getContext("2d");
      await page.render({ canvasContext: context, viewport }).promise;
      pages.push({ page: index, png: target.toBuffer("image/png"), mime: "image/png" });
    }

    return pages;
  } catch (error) {
    return [{ error: `Không render được trang PDF (${error?.message ?? error})` }];
  }
}

/**
 * Gather every source for one request. Attachments are split into text (PDF text,
 * CSV/TXT) and images (photos + rendered catalogue pages).
 */
export async function collectSources(
  { prompt, attachments = [] },
  { extractText = extractDocumentText, renderPdf = renderPdfPages } = {},
) {
  const warnings = [];
  const images = imageAttachments(attachments);
  let catalog = "";
  let pages = 0;

  for (const file of attachments) {
    const extension = path.extname(String(file.path)).toLowerCase();

    if (extension === ".pdf") {
      try {
        const text = await extractText(file);
        if (text) catalog += `\n\n[${file.name}]\n${text}`;
      } catch (error) {
        warnings.push(`Không đọc được PDF ${file.name}: ${error?.message ?? error}`);
      }

      try {
        const rendered = await renderPdf(file);
        for (const page of rendered) {
          if (page.error) {
            warnings.push(`${file.name}: ${page.error}`);
            break;
          }
          if (page.png) {
            images.push({ buffer: page.png, mime: page.mime, name: `${file.name} p${page.page}` });
            pages += 1;
          }
        }
      } catch (error) {
        warnings.push(`Không render được ${file.name}: ${error?.message ?? error}`);
      }
    } else if (!isImageFile(file.path)) {
      try {
        const text = await extractText(file);
        if (text) catalog += `\n\n[${file.name}]\n${text}`;
      } catch (error) {
        warnings.push(`Không đọc được ${file.name}: ${error?.message ?? error}`);
      }
    }
  }

  const text = `${prompt ?? ""}${catalog}`.slice(0, MAX_CATALOG_CHARS);

  return { text, prompt: String(prompt ?? ""), images, warnings, pages };
}

/** Evidence object when no vision model is available: parser + standards only. */
export function heuristicEvidence(sources, { productType = null } = {}) {
  const parsed = parseEvidence(sources.text);
  const standard = deriveStandardValues(parsed, productType);

  return {
    productType,
    category: null,
    productCode: parsed.codes[0]?.code ?? null,
    overall: parsed.size
      ? { x: parsed.size.a, y: parsed.size.c ?? parsed.size.b, z: parsed.size.b }
      : null,
    dimensions: [
      ...parsed.dimensions,
      ...standard.map((entry) => ({
        ...entry,
        unit: entry.unit ?? (typeof entry.value === "number" ? "mm" : ""),
        reasoning: entry.source,
      })),
    ],
    components: [],
    scaleRefs: [],
    materials: [],
    connectors: [],
    source: "heuristic",
    parsed,
  };
}
