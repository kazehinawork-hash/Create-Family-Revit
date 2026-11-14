/**
 * designer.md is one big document sent on every call. Most of it is universal, but
 * a few sections only matter for one product family or one kind of turn. Splitting it
 * by `##` heading lets a call carry the common core plus just its own blocks.
 *
 * Nothing is removed from the file: every block stays available and is selected here.
 */

/** Product families that have their own section, with the words that trigger them. */
const FAMILY_RULES = [
  {
    block: "Physical layout rules",
    // Air-handling units are the only family with pan/coil/filter/fan relations.
    pattern:
      /\bahu\b|air[\s-]?handling|air[\s-]?handler|fcu\b|fan[\s-]?coil|coil\b|filter\b|\bfan\b|casing\b|dàn lạnh|dàn nóng|hộp gió|quạt|cuộn coil|lọc gió|bộ xử lý không khí/i,
  },
  {
    block: "Duct and pipe fittings",
    pattern:
      /\belbow\b|\btee\b|\bcross\b|transition|reducer|branch|fitting|ống gió|cút|tê\b|chữ\s?y|ngã\s?(ba|tư)|thu\s?hẹp|côn|reducer/i,
  },
];

/** Sections that only help when they apply. Everything else is always sent. */
const CONDITIONAL = {
  "Physical layout rules": "family",
  "Duct and pipe fittings": "family",
  "Datasheet handling": "datasheet",
  "Reasoning about a parameter change": "edit",
  "Output shape": "build",
};

/** Target size of the system prompt; a cable-ladder brief must fit under 10 KB. */
export const DEFAULT_BUDGET = 10000;

/** When over budget, drop in this order (least harmful first). */
const TRIM_ORDER = [
  "Build parity (studio ↔ .rfa)",
  "Notes",
  "Output shape",
  "Geometry quality checklist (self-check before returning)",
  "Missing information",
  "Orientation and hosting",
];

export function splitPromptBlocks(markdown) {
  const text = String(markdown ?? "");
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let intro = [];
  let current = null;

  const flush = () => {
    if (current) blocks.push({ title: current.title, body: current.lines.join("\n").trim() });
    current = null;
  };

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = { title: heading[1], lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
    else intro.push(line);
  }
  flush();

  return { intro: intro.join("\n").trim(), blocks };
}

/** Which optional blocks a brief and a turn need. */
export function selectBlocks({ text = "", options = {} } = {}) {
  const brief = String(text ?? "");
  const wanted = new Set();

  if (options.edit) wanted.add("Reasoning about a parameter change");
  if (options.datasheet) wanted.add("Datasheet handling");
  // Section/patch turns get their shape from the patch contract, not the example spec.
  if (!options.patch) wanted.add("Output shape");
  wanted.add("Build parity (studio ↔ .rfa)");

  for (const rule of FAMILY_RULES) {
    if (rule.pattern.test(brief)) wanted.add(rule.block);
  }

  return wanted;
}

/**
 * The system prompt for one call: intro + every unconditional section + the optional
 * sections this brief/turn needs. Returns the markdown and the blocks used, so the
 * caller can log the size.
 */
export function buildSystemPrompt(markdown, { text = "", options = {} } = {}) {
  const { intro, blocks } = splitPromptBlocks(markdown);
  const wanted = selectBlocks({ text, options });
  let kept = blocks.filter((block) => !(block.title in CONDITIONAL) || wanted.has(block.title));
  const dropped = [];

  const render = (list) =>
    compactMarkdown([intro, ...list.map((block) => block.body)].filter(Boolean).join("\n\n"));

  // Stay inside the per-call prompt budget. Blocks are dropped lowest-value first so
  // a short brief is cheap and a complex one still keeps its geometry rules.
  let prompt = render(kept);
  for (const title of TRIM_ORDER) {
    if (prompt.length <= (options.budget ?? DEFAULT_BUDGET)) break;
    const next = kept.filter((block) => block.title !== title);
    if (next.length === kept.length) continue;
    kept = next;
    dropped.push(title);
    prompt = render(kept);
  }

  return {
    prompt,
    blocks: kept.map((block) => block.title),
    dropped: [
      ...blocks.filter((block) => !kept.includes(block)).map((block) => block.title),
      ...dropped.filter((title) => blocks.some((block) => block.title === title)),
    ].filter((title, index, all) => all.indexOf(title) === index),
  };
}

/** Collapse the blank-line padding the markdown uses for readability on disk. */
export function compactMarkdown(markdown) {
  return String(markdown ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
