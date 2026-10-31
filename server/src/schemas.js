import { z } from "zod";

const customApiConfig = z
  .object({
    baseUrl: z.string().trim().max(500).optional(),
    apiKey: z.string().max(500).optional(),
    model: z.string().trim().max(160).optional(),
  })
  .passthrough();

export const designRequest = z.object({
  prompt: z.preprocess(
    (value) => (typeof value === "string" ? value : ""),
    z
      .string()
      .trim()
      .min(1, "A prompt is required")
      .max(50000, "The prompt is too long (50000 characters max)"),
  ),
  spec: z.unknown().nullish(),
  lod: z.coerce.number().int().optional(),
  model: z.string().trim().max(160).optional(),
  customApiConfig: customApiConfig.optional(),
  attachments: z
    .array(z.object({ path: z.string().min(1), name: z.string().optional() }))
    .max(4)
    .optional(),
});

export const buildRequest = z.object({
  spec: z.unknown(),
});

export const uploadRequest = z.object({
  name: z.string().trim().min(1).max(240),
  data: z.string().min(1),
});

export const modelSaveRequest = z.object({
  id: z.string().trim().max(200).optional(),
  name: z.string().trim().max(200).optional(),
  spec: z.object({ name: z.string().min(1) }).passthrough(),
  entries: z.array(z.unknown()).optional(),
});

/** Turns a Zod failure into the single message the studio shows in its toast. */
export function firstIssue(result) {
  const issue = result.error?.issues?.[0];
  return issue?.message || "Invalid request";
}
