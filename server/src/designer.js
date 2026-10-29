import fs from "node:fs";
import path from "node:path";
import { analyzeSpec, formatIssues } from "@family/spec-core";
import { config } from "./config.js";
import { generateJson } from "./agents.js";
import { extractDocumentText } from "./documents.js";

const designerPrompt = fs.readFileSync(path.join(config.dirs.prompts, "designer.md"), "utf8");
const repairPrompt = fs.readFileSync(path.join(config.dirs.prompts, "repair.md"), "utf8");

const MAX_ATTEMPTS = 3;

const PROSE_REPAIR = `That answer was not a JSON object, so it cannot be built. Reply with ONE JSON object and nothing else:
no headings, no bullet lists, no design document, no commentary, no code fences.
It must start with { and end with }, and contain schemaVersion, name, category, parameters, materials and parts.`;

export const LOD_LEVELS = [200, 300, 350, 400];
export const DEFAULT_LOD = 300;

const LOD_STANDARDS = {
  200: `Mức chi tiết đang dựng: **LOD 200 — Khối bao (massing)**.

- **Số lượng parts**: 3 đến 8 parts, chỉ khối bao chính và các cổng kết nối lớn.
- Được dựng: thân máy dạng khối hộp/trụ, miệng gió hoặc cổ bích chính, các đầu ống chính nhô ra, chân đế/tai treo đơn giản.
- KHÔNG dựng: nội bộ (quạt, mô tơ, coil, filter), cửa thăm, tấm ốp nhỏ, bulông, gioăng, ren, lỗ khoan, gân gia cường.
- **Tham số**: 4 đến 10 tham số, chỉ kích thước bao (dài, rộng, cao) và thông số MEP chính.
- Mục tiêu: phối cảnh, định tuyến sơ bộ, kiểm tra khối tích — không dùng để bóc khối lượng chi tiết.`,

  300: `Mức chi tiết đang dựng: **LOD 300 — Thiết kế thực tế, gọn nhẹ**.

Mục tiêu: family đáp ứng thiết kế, định tuyến MEP và xuất khối lượng, **tuyệt đối không làm nặng file Revit (No Over-modeling / No Micro-details)**:
- **Số lượng parts**: 4 đến 16 parts gọn gàng, rõ ràng.
- **Không dựng chi tiết siêu vi mô**: KHÔNG dựng từng vòng ren răng ốc, từng bulông đai ốc li ti, hàng chục cánh tản nhiệt rời. Ren hay rãnh chỉ thể hiện bằng khối bao chính và vật liệu.
- **Tập trung vào 3 yếu tố quyết định của LOD 300**:
  1. **Hình khối bao chính xác**: kích thước dài x rộng x cao, tỷ lệ chuẩn catalog.
  2. **Cổng kết nối MEP chuẩn vị trí**: miệng gió, cổ bích, đầu ống cấp/hồi/xả nhô ra đúng vị trí và đường kính danh định.
  3. **Hệ thống tham số thông minh**: kích thước gắn với tham số nhóm \`Dimensions\` để co dãn khi đổi Type.`,

  350: `Mức chi tiết đang dựng: **LOD 350 — Chi tiết phối hợp / lắp đặt (coordination)**.

Dùng cho phối hợp MEP và kiểm tra va chạm: chi tiết hơn LOD 300 nhưng chưa tới mức chế tạo.
- **Số lượng parts**: 10 đến 30 parts.
- Dựng thêm so với LOD 300: cổ bích và mặt bích kết nối, tai treo / giá đỡ / thanh treo ren, gối đỡ ống, cửa thăm có bản lề, tấm chắn, vùng bảo dưỡng (clearance) và các chi tiết định vị cụm thiết bị.
- Thể hiện rõ **điểm kết nối** (miệng gió, đầu ống, hộp điện) đúng vị trí và đường kính danh định để phối hợp với ống gió/ống nước trong mô hình.
- **Không** dựng bulông li ti, gioăng, ren, lỗ khoan ren, đường hàn — đó là LOD 400.
- **Tham số**: 10 đến 26 tham số, gồm kích thước bao, kích thước cụm lắp đặt (khoảng cách tai treo, cao độ đầu ống) và thông số MEP.`,

  400: `Mức chi tiết đang dựng: **LOD 400 — Chi tiết chế tạo / lắp ráp**.

- **Số lượng parts**: 18 đến 45 parts (tối đa 60 để file vẫn nhẹ).
- Dựng thêm so với LOD 300: bích, gioăng, bulông/đai ốc (dùng \`array\`), gân gia cường, tấm ốp, cửa thăm, lỗ khoan bulông, chi tiết hàn, đế máy, mặt bích kết nối.
- Nội bộ (quạt, mô tơ, coil, filter) dựng rõ ràng nhưng vẫn bằng khối đơn giản, không ren/rãnh siêu vi mô.
- **Tham số**: 16 đến 40 tham số, gồm cả kích thước chi tiết: dày bích, đường kính bulông, khoảng cách bulông, dày tấm, khe gioăng.
- Mọi chi tiết nhỏ (bích, bulông, lỗ) đều phải tham chiếu tham số, không hardcode.`,
};

export function lodStandard(lod) {
  const level = LOD_LEVELS.includes(Number(lod)) ? Number(lod) : DEFAULT_LOD;
  return `${LOD_STANDARDS[level]}

Ghi rõ mức LOD ${level} đã dựng vào mảng \`notes\` (tiếng Việt).`;
}

function systemPrompt(lod) {
  return designerPrompt.replace("{{lodStandard}}", lodStandard(lod));
}

function summarise(spec, model) {
  const bounds = model.bounds;
  return {
    parameters: spec.parameters.length,
    parts: model.parts.length,
    instances: model.instances,
    materials: spec.materials?.length ?? 0,
    bounds: bounds
      ? {
          x: Math.round(bounds.size.x),
          y: Math.round(bounds.size.y),
          z: Math.round(bounds.size.z),
        }
      : null,
  };
}

export async function design({ prompt, currentSpec, lod, emit, model, attachments, signal }) {
  const startedAt = Date.now();
  const level = LOD_LEVELS.includes(Number(lod)) ? Number(lod) : DEFAULT_LOD;
  const messages = [{ role: "system", content: systemPrompt(level) }];

  if (currentSpec) {
    messages.push({
      role: "user",
      content: `Here is the current spec. Apply my next request to it.\n${JSON.stringify(currentSpec)}`,
    });
  }

  if (attachments && attachments.length > 0) {
    let extracted = [];

    try {
      emit({ type: "stage", stage: "reading", message: "Reading the document" });
      for (const file of attachments) {
        const text = await extractDocumentText(file);
        if (text.length > 40) extracted.push({ name: file.name, text });
      }
    } catch (error) {
      console.error("document extraction failed:", error);
      extracted = [];
    }

    if (extracted.length > 0) {
      messages.push({
        role: "user",
        content:
          "Text extracted from the attached document(s). These numbers come straight from the " +
          "datasheet: use them exactly, and map the drawing reference letters (A, B, C, D, E, F, " +
          "a1, c1, ...) to the matching dimensions.\n\n" +
          extracted.map((doc) => `--- ${doc.name} ---\n${doc.text}`).join("\n\n"),
      });
    } else {
      messages.push({
        role: "user",
        content: `Attached document(s): ${attachments.map((file) => file.name).join(", ")}.\n` +
          "Read each one with the read_file tool before you design. Take every dimension, component, " +
          "connection and material from the document, and keep the family consistent with it. " +
          "Do not guess sizes the document already gives you. " +
          "Apply the Usable & Production-Ready Family standards: ensure all piping stubs (Cooling, Heating, Drain, Humidifier) " +
          "and duct collars protrude properly from the casing with accurate nominal diameters, all driving parameters are declared " +
          "in group Dimensions, and internal components (fans, coils, filters) are modeled cleanly inside the casing.",
      });
    }
  }

  messages.push({
    role: "user",
    content: `${prompt}\n\n---\nReturn the family spec as ONE JSON object only — no markdown, no headings, no explanation.`,
  });

  const modelOptions = {
    ...(model ? { model } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(signal ? { signal } : {}),
    onProgress: (message) => emit({ type: "stage", stage: "working", message }),
  };

  emit({ type: "stage", stage: "thinking", message: "Reading the brief" });

  let analysis = null;
  let attempts = 0;
  let usage = null;
  let layoutPassUsed = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    if (attempt === 1) {
      emit({ type: "stage", stage: "generating", message: "Sketching the outline" });
    } else if (analysis) {
      emit({
        type: "stage",
        stage: "repairing",
        message: `Repairing ${analysis.errors.length} problem${analysis.errors.length === 1 ? "" : "s"}`,
      });
    }

    let result;

    try {
      result = await generateJson(messages, modelOptions);
    } catch (error) {
      // The model sometimes answers with a design document instead of the JSON object.
      // Feed it back and ask again instead of failing the whole run.
      if (error?.name !== "LlmError" || attempt >= MAX_ATTEMPTS) throw error;

      emit({ type: "stage", stage: "repairing", message: "The answer was prose — asking for the JSON spec again" });

      if (typeof error.text === "string" && error.text.trim()) {
        messages.push({ role: "assistant", content: error.text.slice(0, 20000) });
      }

      messages.push({ role: "user", content: PROSE_REPAIR });
      continue;
    }

    usage = result.usage ?? usage;

    console.log(
      `[design] attempt ${attempt} answered in ${Math.round((Date.now() - startedAt) / 1000)}s` +
        `${result.usage?.total_tokens ? `, ${result.usage.total_tokens} tokens` : ""}`,
    );

    emit({ type: "stage", stage: "checking", message: "Checking the model" });
    analysis = analyzeSpec(result.json);

    if (analysis.ok) {
      // A valid spec can still be physically wrong (e.g. a drain pan above the coil).
      // Give the model one corrective pass with those layout warnings.
      const layoutIssues = analysis.issues.filter((issue) => issue.path.startsWith("logic."));
      if (layoutIssues.length > 0 && !layoutPassUsed && attempt < MAX_ATTEMPTS) {
        layoutPassUsed = true;
        emit({
          type: "stage",
          stage: "repairing",
          message: `Fixing ${layoutIssues.length} layout problem${layoutIssues.length === 1 ? "" : "s"}`,
          issues: layoutIssues.slice(0, 12),
        });
        messages.push({ role: "assistant", content: result.text });
        messages.push({
          role: "user",
          content: repairPrompt.replace("{{issues}}", formatIssues(layoutIssues, 25)),
        });
        continue;
      }
      break;
    }

    if (attempt < MAX_ATTEMPTS) {
      emit({
        type: "stage",
        stage: "repairing",
        message: `${analysis.errors.length} problem${analysis.errors.length === 1 ? "" : "s"} found`,
        issues: analysis.errors.slice(0, 12),
      });
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content: repairPrompt.replace("{{issues}}", formatIssues(analysis.errors, 25)),
      });
    }
  }

  if (analysis?.spec) analysis.spec.lod = level;

  const stats = {
    ...summarise(analysis.spec, analysis.model),
    lod: level,
    attempts,
    elapsedMs: Date.now() - startedAt,
    usage,
  };

  return { analysis, stats };
}
