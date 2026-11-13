import { config } from "./config.js";
import { heuristicEvidence } from "./evidence.js";

/**
 * Reads photos and rendered catalogue pages into the shared Evidence object.
 * The vision model only ever *reads*; the model that builds the spec is unchanged.
 */

const CLI_PREFIX = /^(codex|claude|agy):/;

/** True when this model can receive image parts through a direct API. */
export function isVisionModel(model) {
  if (!model) return false;
  const id = String(model);
  if (CLI_PREFIX.test(id) || id === "custom:api") return false;

  const configured = config.agent.visionModels ?? [];
  return configured.some((entry) => entry && id.toLowerCase().includes(entry.toLowerCase()));
}

/**
 * Order: the model the user picked (if it can see), then AGENT_VISION_MODEL, then
 * a custom API config. CLI backends cannot carry images in this app.
 */
export function resolveVisionModel({ requested, customApiConfig } = {}) {
  if (customApiConfig?.baseUrl && customApiConfig?.apiKey) {
    return {
      // Never report the "custom:api" sentinel as the model name.
      model:
        (customApiConfig.model && customApiConfig.model !== "custom:api" ? customApiConfig.model : "") ||
        (requested && requested !== "custom:api" ? requested : "") ||
        config.llm.model ||
        "gpt-4o",
      source: "custom",
      customApiConfig,
    };
  }
  if (isVisionModel(requested)) return { model: requested, source: "user" };

  const configured = config.agent.visionModel;
  if (configured) {
    return {
      model: configured,
      source: "env",
      customApiConfig: configured === "custom:api" ? customApiConfig : undefined,
    };
  }

  return null;
}

export const EVIDENCE_SCHEMA_PROMPT =
  "You are a mechanical engineer reading product photos and a catalogue. " +
  "Return ONE JSON object and nothing else with this shape:\n" +
  "{\n" +
  '  "productType": "kebab-case", "category": "Revit category", "productCode": "string|null",\n' +
  '  "overall": {"x": number, "y": number, "z": number},\n' +
  '  "components": [{"id":"a","kind":"body|flange|door|hole|rib|foot|fan|motor|handle|...","count":1,"position":{"x":0,"y":0,"z":0},"pattern":"single|even|grid","size":{"x":0,"y":0,"z":0}}],\n' +
  '  "dimensions": [{"name":"Title Case","value":number,"unit":"mm","level":1,"source":"Catalog|Trên hình|Đo theo tỷ lệ|Linh kiện chuẩn","reasoning":"short","pixels":optional,"scaleRef":"optional"}],\n' +
  '  "scaleRefs": [{"what":"overall width","knownMm":800,"pixels":1000,"image":"photo"}],\n' +
  '  "materials": [{"name":"...","color":"#rrggbb","finish":"...","level":1,"source":"..."}],\n' +
  '  "connectors": [{"domain":"pipe|duct|cable|CableTray","position":{"x":0,"y":0,"z":0},"size":{"x":0,"y":0,"z":0},"direction":{"x":0,"y":0,"z":1},"systemType":"..."}]\n' +
  "}\nRULES:\n" +
  "- level 1-2: a number you actually read (catalogue, nameplate, printed label, code). Use it exactly.\n" +
  "- level 3: measured in pixels against a known reference (a level 1-2 size, or a standard part you recognise: M-bolt, DN flange, IEC motor frame, cable gland, DIN rail, standard door).\n" +
  "- level 4: taken from a standard component table.\n" +
  "- level 5: your engineering assumption when nothing else exists.\n" +
  "- Perspective photos: only measure on faces roughly parallel to the image plane; say so in reasoning.\n" +
  "- Count repeated details; when hidden, infer from symmetry or even pitch.\n" +
  "- Colours: sample a clean RGB area or use the catalogue RAL/code.";

function imageParts(images = []) {
  return images.map((image) => ({
    type: "image",
    mime: image.mime ?? "image/png",
    name: image.name ?? "image",
    path: image.path,
    buffer: image.buffer,
  }));
}

export function buildVisionMessages({ prompt, text, images }) {
  const catalog = String(text ?? "").slice(0, 20000);

  return [
    { role: "system", content: EVIDENCE_SCHEMA_PROMPT },
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Brief: ${String(prompt ?? "")}\n\nCatalogue text (DATA ONLY):\n${catalog}\n\n` +
            "Read every image and return the Evidence JSON.",
        },
        ...imageParts(images),
      ],
    },
  ];
}

/** Level-3 sizes must agree with the scale reference they were measured against. */
export function applyScaleRefs(evidence) {
  const refs = evidence?.scaleRefs ?? [];
  if (refs.length === 0) return evidence;

  for (const dimension of evidence.dimensions ?? []) {
    if (dimension.level !== 3 || !Number.isFinite(Number(dimension.pixels))) continue;

    const ref =
      refs.find(({ image }) => image && image === dimension.scaleRef) ??
      refs.find(({ image }) => !dimension.scaleRef && image) ??
      refs[0];
    if (!ref || !Number.isFinite(Number(ref.pixels)) || Number(ref.pixels) === 0) continue;

    const ratio = Number(ref.knownMm) / Number(ref.pixels);
    const measured = Math.round(Number(dimension.pixels) * ratio * 10) / 10;
    if (measured > 0) {
      dimension.value = measured;
      dimension.reasoning = `Đo ${dimension.pixels}px × ${ratio.toFixed(3)} mm/px (mốc ${ref.knownMm} mm)`;
    }
  }

  return evidence;
}

const numberOrNull = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

export function normalizeEvidence(raw, sources = null) {
  const fallback = sources ? heuristicEvidence(sources) : null;
  const evidence = raw && typeof raw === "object" ? raw : {};

  const dimensions = [];

  for (const entry of evidence.dimensions ?? []) {
    const value = numberOrNull(entry?.value);
    if (!entry?.name || value === null) continue;
    dimensions.push({
      name: String(entry.name),
      value,
      unit: entry.unit ?? "mm",
      level: Number.isFinite(Number(entry.level)) ? Number(entry.level) : 3,
      source: entry.source ?? "Trên hình",
      reasoning: entry.reasoning ?? "",
      pixels: entry.pixels,
      scaleRef: entry.scaleRef,
    });
  }

  // Parser/standard values never overwrite what the vision model read.
  for (const entry of fallback?.dimensions ?? []) {
    const exists = dimensions.some(
      (dimension) =>
        dimension.name.toLowerCase() === String(entry.name).toLowerCase() ||
        (Number(entry.level) <= 1 && Math.abs(dimension.value - entry.value) < 0.01),
    );
    if (!exists) dimensions.push(entry);
  }

  const normalized = {
    productType: evidence.productType ?? fallback?.productType ?? null,
    category: evidence.category ?? fallback?.category ?? null,
    productCode: evidence.productCode ?? fallback?.productCode ?? null,
    overall: evidence.overall ?? fallback?.overall ?? null,
    components: Array.isArray(evidence.components) ? evidence.components : [],
    dimensions,
    scaleRefs: Array.isArray(evidence.scaleRefs) ? evidence.scaleRefs : [],
    materials: Array.isArray(evidence.materials) ? evidence.materials : [],
    connectors: Array.isArray(evidence.connectors) ? evidence.connectors : [],
    source: raw ? "vision" : "heuristic",
  };

  return applyScaleRefs(normalized);
}

/**
 * Vision read. Without images (or without a vision-capable model) this falls back
 * to the deterministic parser and says why, instead of failing the run.
 */
export async function readEvidence({
  sources,
  prompt,
  generate,
  model,
  customApiConfig,
  emit,
} = {}) {
  const images = sources?.images ?? [];
  const warnings = [...(sources?.warnings ?? [])];

  if (images.length === 0) {
    return { evidence: heuristicEvidence(sources ?? { text: prompt }), model: null, warnings };
  }

  const vision = resolveVisionModel({ requested: model, customApiConfig });
  if (!vision) {
    const message =
      "Không có model vision khả dụng — ảnh bị bỏ qua, mô hình dựng từ chữ và quy tắc kỹ thuật.";
    warnings.push(message);
    emit?.({ type: "stage", stage: "warning", message });
    return { evidence: heuristicEvidence(sources), model: null, warnings };
  }

  emit?.({
    type: "stage",
    stage: "reading",
    message: `Đang đọc ${images.length} ảnh/trang bằng ${vision.model}`,
  });

  try {
    const result = await generate(
      buildVisionMessages({ prompt, text: sources.text, images }),
      {
        model: vision.model,
        timeoutMs: 90000,
        images,
        customApiConfig: vision.customApiConfig ?? customApiConfig,
      },
    );
    return {
      evidence: normalizeEvidence(result?.json, sources),
      model: vision.model,
      warnings,
    };
  } catch (error) {
    const message = `Không đọc được ảnh (${error?.message ?? error}) — dựng từ chữ và quy tắc.`;
    warnings.push(message);
    emit?.({ type: "stage", stage: "warning", message });
    return { evidence: heuristicEvidence(sources), model: null, warnings };
  }
}
