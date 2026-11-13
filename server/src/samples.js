import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";

/**
 * Reusing a saved family as a starting point is far cheaper than creating one from
 * scratch: the model only has to patch an existing spec.
 */

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "make", "create", "design", "family", "model",
  "tao", "tao", "cho", "va", "voi", "cua", "mot", "cac", "hay", "giup", "lam", "thiet", "ke",
  "revit", "type", "mm", "cm", "inch",
]);

const KIND_WORDS = [
  "tee", "elbow", "bend", "cross", "tray", "ladder", "cable", "pipe", "duct", "valve",
  "pump", "tank", "hood", "fan", "beam", "column", "door", "window",
];

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenize(text) {
  return new Set(
    normalizeText(text)
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  );
}

function entryText(entry) {
  const spec = entry.spec ?? {};
  const parts = (spec.parts ?? []).map((part) => `${part.name ?? ""} ${part.solid?.kind ?? ""}`);
  const tags = Array.isArray(spec.tags) ? spec.tags : [];
  return [
    entry.name,
    spec.name,
    spec.typeName,
    spec.category,
    spec.description,
    ...tags,
    ...parts,
  ]
    .filter(Boolean)
    .join(" ");
}

/** 0..1 overlap between the request and a saved family, with a kind gate. */
export function scoreSample(prompt, entry) {
  const request = tokenize(prompt);
  if (request.size === 0) return 0;

  const sample = tokenize(entryText(entry));
  let matched = 0;
  for (const token of request) {
    if (sample.has(token)) matched += 1;
  }

  // One shared generic word is not a match.
  if (matched < 2) return 0;

  let score = matched / request.size;

  const requestText = normalizeText(prompt);
  const sampleText = normalizeText(entryText(entry));
  const requestKinds = KIND_WORDS.filter((kind) => requestText.includes(kind));
  const sampleKinds = KIND_WORDS.filter((kind) => sampleText.includes(kind));

  if (requestKinds.length > 0) {
    score += requestKinds.some((kind) => sampleKinds.includes(kind)) ? 0.25 : -0.25;
  }

  return Math.min(1, Math.max(0, Math.round(score * 1000) / 1000));
}

export function listSavedModels(dir = config.dirs.saved) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }

  const entries = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const spec = data?.spec ?? data;
      if (!spec || typeof spec !== "object") continue;
      entries.push({ id: data?.id ?? file.replace(/\.json$/, ""), name: spec.name ?? file, spec });
    } catch {
      // A broken saved file must not break routing.
    }
  }
  return entries;
}

/** Best saved family for this request, or null when nothing is close enough. */
export function findClosestSample(prompt, { dir = config.dirs.saved, minScore = 0.45 } = {}) {
  const entries = listSavedModels(dir);
  let best = null;

  for (const entry of entries) {
    const score = scoreSample(prompt, entry);
    if (score < minScore) continue;
    if (!best || score > best.score) best = { id: entry.id, name: entry.name, score };
  }

  return best;
}
