import { config } from "./config.js";
import { designExperimental, turnModel } from "./designer/pipeline-experimental.js";
import { designStable } from "./designer/pipeline-stable.js";
import {
  DEFAULT_LOD,
  LOD_LEVELS,
  condensePrompt,
  designTargetsBlock,
  lodStandard,
  splitNewBrief,
  turnTimeoutMs,
} from "./designer/prompts.js";
import { autoHealSpec, fillMissingParameters } from "./designer/repair.js";

export {
  DEFAULT_LOD,
  LOD_LEVELS,
  autoHealSpec,
  condensePrompt,
  designTargetsBlock,
  fillMissingParameters,
  lodStandard,
  splitNewBrief,
  turnModel,
  turnTimeoutMs,
};

/**
 * Main entry point for designing or editing a Revit family spec.
 * Routes between the stable pipeline and experimental pipeline based on config.
 */
export async function design(options = {}) {
  if (config.agent.experimentalPipeline) return designExperimental(options);
  return designStable(options);
}
