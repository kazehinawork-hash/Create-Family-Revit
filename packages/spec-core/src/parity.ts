import type { ResolvedModel, ResolvedPart } from "./geometry.js";

/**
 * Build-parity checks. These answer a different question than validation:
 * "will the .rfa look and flex like the studio preview?" A spec can be valid and
 * still lose native forms, dimensions or whole sections when Revit builds it.
 *
 * The rules mirror FamilyAgent.Addin/FamilyBuilder.Geometry.cs. Keep them in sync
 * when the builder strategy changes.
 */

export type PartBuildStatus =
  | "native"
  | "native-multi-hole"
  | "native-bore"
  | "native-revolve"
  | "swept-blend"
  | "sweep"
  | "blend"
  | "freeform"
  | "multi-section";

export type ParityCode =
  | "loft.multi-section"
  | "loft.axis"
  | "frustum.baked-radius"
  | "bend.baked-radius"
  | "tube.hollow"
  | "boolean.freeform"
  | "model.below-grid";

export interface ParityRisk {
  severity: "warning" | "info";
  code: ParityCode;
  path: string;
  partId?: string;
  partName?: string;
  message: string;
  hint?: string;
}

export interface PartParity {
  partId: string;
  partName: string;
  status: PartBuildStatus;
  /** True when the part stays a native Revit form (no FreeFormElement, no skipped sections). */
  native: boolean;
  risks: ParityRisk[];
}

export interface ParityReport {
  risks: ParityRisk[];
  parts: PartParity[];
}

/** Revit's short-curve tolerance, in millimetres. */
const TOLERANCE_MM = 0.78;

function distance2d(a: number, b: number): number {
  return Math.hypot(a, b);
}

/**
 * Mirrors FamilyBuilder.Geometry.CanCreateNativeFlangeExtrusion. A cylinder with
 * parallel bolt holes (and optionally a concentric bore), or a box with Z holes,
 * is extruded as one native profile instead of becoming a FreeFormElement.
 */
function isNativeMultiHole(part: ResolvedPart): boolean {
  const { cuts, solid } = part;
  if (cuts.length === 0) return false;

  if (solid.kind === "cylinder") {
    const flangeRadius = solid.radius;
    const innerBore = solid.innerRadius;

    for (let i = 0; i < cuts.length; i += 1) {
      const cut = cuts[i];
      if (cut.kind !== "cylinder" || cut.axis !== solid.axis || cut.radius <= 0) return false;

      const dx = cut.base.x - solid.base.x;
      const dy = cut.base.y - solid.base.y;
      const dz = cut.base.z - solid.base.z;
      const dist =
        solid.axis === "x"
          ? distance2d(dy, dz)
          : solid.axis === "y"
            ? distance2d(dx, dz)
            : distance2d(dx, dy);

      if (dist + cut.radius > flangeRadius - TOLERANCE_MM) return false;
      if (innerBore > 0 && dist - cut.radius < innerBore + TOLERANCE_MM) return false;

      for (let j = i + 1; j < cuts.length; j += 1) {
        const other = cuts[j];
        if (other.kind !== "cylinder" || other.axis !== solid.axis) return false;
        const ox = cut.base.x - other.base.x;
        const oy = cut.base.y - other.base.y;
        const oz = cut.base.z - other.base.z;
        const holeDist =
          solid.axis === "x"
            ? distance2d(oy, oz)
            : solid.axis === "y"
              ? distance2d(ox, oz)
              : distance2d(ox, oy);
        if (holeDist < cut.radius + other.radius + TOLERANCE_MM) return false;
      }
    }
    return true;
  }

  if (solid.kind === "box") {
    const halfX = Math.abs(solid.size.x) / 2;
    const halfY = Math.abs(solid.size.y) / 2;

    for (let i = 0; i < cuts.length; i += 1) {
      const cut = cuts[i];
      if (cut.kind !== "cylinder" || cut.axis !== "z" || cut.radius <= 0) return false;

      const dx = Math.abs(cut.base.x - solid.origin.x);
      const dy = Math.abs(cut.base.y - solid.origin.y);
      if (dx + cut.radius > halfX - TOLERANCE_MM || dy + cut.radius > halfY - TOLERANCE_MM) {
        return false;
      }

      for (let j = i + 1; j < cuts.length; j += 1) {
        const other = cuts[j];
        if (other.kind !== "cylinder" || other.axis !== "z") return false;
        const hx = cut.base.x - other.base.x;
        const hy = cut.base.y - other.base.y;
        if (distance2d(hx, hy) < cut.radius + other.radius + TOLERANCE_MM) return false;
      }
    }
    return true;
  }

  return false;
}

function analyzePart(part: ResolvedPart): PartParity {
  const risks: ParityRisk[] = [];
  const { solid } = part;
  let status: PartBuildStatus;

  const risk = (
    code: ParityCode,
    severity: "warning" | "info",
    message: string,
    hint?: string,
  ): void => {
    risks.push({
      severity,
      code,
      path: `parity.${part.id}`,
      partId: part.id,
      partName: part.name,
      message,
      hint,
    });
  };

  if (solid.kind === "loft") {
    if (solid.sections.length > 2) {
      status = "freeform";
      risk(
        "loft.multi-section",
        "warning",
        `Loft "${part.name}" có ${solid.sections.length} section; studio dựng đủ nhưng .rfa dùng FreeForm loft fallback thay vì native SweptBlend.`,
        "Auto-heal tách loft >2 section thành các part 2-section nếu muốn giữ native.",
      );
    } else if (solid.axis !== "z") {
      status = "freeform";
      risk(
        "loft.axis",
        "warning",
        `Loft "${part.name}" chạy theo trục ${solid.axis}; .rfa dùng FreeForm loft fallback để giữ đúng hướng profile.`,
        "Part vẫn hiện nhưng mất native form/constraint; Rebuild from spec khi đổi tham số.",
      );
    } else {
      status = "swept-blend";
    }
  } else if (solid.kind === "frustum") {
    status = "native-revolve";
    risk(
      "frustum.baked-radius",
      "warning",
      `Frustum "${part.name}" dựng bằng Revolution native; bán kính là reference dimension nên chưa drive, chỉ height flex.`,
      "Dùng revolve/loft nếu cần bán kính thay đổi theo tham số.",
    );
  } else if (solid.kind === "bend") {
    status = "sweep";
    risk(
      "bend.baked-radius",
      "warning",
      `Bend "${part.name}" dựng bằng Sweep; radius/tubeRadius chưa có dimension nên chưa flex theo tham số.`,
      "Đổi tham số phải dùng Rebuild from spec.",
    );
  } else if (solid.kind === "revolve") {
    status = "native-revolve";
  } else if (solid.kind === "tube") {
    status = "sweep";
    if (solid.innerRadius > 0) {
      risk(
        "tube.hollow",
        "info",
        `Tube "${part.name}" có innerRadius; Revit thử dựng ring profile native, nếu bị từ chối sẽ thành FreeFormElement.`,
        "Kiểm tra QA sau build; nếu freeform, dùng outer tube + cut hoặc Rebuild from spec.",
      );
    }
  } else if (solid.kind === "cylinder") {
    status = solid.innerRadius > 0 ? "native-bore" : "native";
  } else {
    status = "native";
  }

  if (part.cuts.length > 0) {
    if (isNativeMultiHole(part)) {
      status = "native-multi-hole";
    } else {
      status = "freeform";
      risk(
        "boolean.freeform",
        "warning",
        `Part "${part.name}" có ${part.cuts.length} cut. Nếu cut là lỗ nằm trong profile, builder giữ native prism; nếu cut sát/cắt qua mép (notch), Revit boolean trên tấm mỏng có thể fail và builder giữ thân prism chưa cắt — notch sẽ thiếu.`,
        "Bake notch vào points của prism, hoặc đưa cut vào trong profile cách mép ≥ 0.8 mm; cut tròn song song trục vẫn giữ native.",
      );
    }
  }

  return {
    partId: part.id,
    partName: part.name,
    status,
    native: status !== "freeform",
    risks,
  };
}

export function analyzeParity(model: ResolvedModel): ParityReport {
  const parts = model.parts.map(analyzePart);
  const risks = parts.flatMap((part) => part.risks);

  if (model.bounds && model.bounds.min.z < -0.5) {
    risks.push({
      severity: "info",
      code: "model.below-grid",
      path: "parity.model",
      message: `Mô hình thấp hơn mặt phẳng z=0 (${Math.round(model.bounds.min.z)} mm); grid sẽ cắt qua thân khi xem studio.`,
      hint: "Dịch model lên hoặc thêm tham số Center Height.",
    });
  }

  return { risks, parts };
}
