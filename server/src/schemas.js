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
  /** Keep the selected model even when the provider is overloaded (no fallback). */
  lockModel: z.boolean().optional(),
  customApiConfig: customApiConfig.optional(),
  /** Command Code API key; exported to the CLI as COMMAND_CODE_API_KEY for this run. */
  commandCodeApiKey: z.string().trim().max(400).optional(),
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
  /** Only used when the model is new; overwriting keeps the group already on disk. */
  group: z.string().trim().max(60).optional(),
  /** Viewer snapshot as a data URL (JPEG/WebP), ~320px. */
  thumbnail: z
    .string()
    .max(400_000, "Ảnh thu nhỏ quá lớn.")
    .regex(/^data:image\/(jpeg|jpg|webp|png);base64,/, "Ảnh thu nhỏ không hợp lệ.")
    .optional(),
});

/** 60 chars, no path characters — the same rules as a Revit family/type name. */
const groupName = z
  .string()
  .trim()
  .max(60, "Tên nhóm tối đa 60 ký tự.")
  .refine((value) => !/[\\/:*?"<>|]/.test(value), {
    message: 'Tên nhóm không được chứa các ký tự \\ / : * ? " < > |.',
  });

export const groupCreateRequest = z.object({
  name: groupName.refine((value) => value.length > 0, "Tên nhóm không được để trống."),
});

export const groupRenameRequest = z.object({
  name: groupName.refine((value) => value.length > 0, "Tên nhóm không được để trống."),
});

/** `""` is valid here: it moves the model back to "Chưa nhóm". */
export const modelGroupRequest = z.object({
  group: groupName,
});

/** Turns a Zod failure into the single message the studio shows in its toast. */
export function firstIssue(result) {
  const issue = result.error?.issues?.[0];
  return issue?.message || "Invalid request";
}
