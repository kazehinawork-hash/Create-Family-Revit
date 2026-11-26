import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  fetchLatestExternalSpec,
  subscribeExternalSpecStream,
  type ExternalSpecPayload,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useStudio } from "./StudioContext";
import type { ToastState } from "./types";

export function useExternalSpecSync(setToast: Dispatch<SetStateAction<ToastState | null>>) {
  const { t, formatNumber } = useI18n();
  const { dispatch } = useStudio();
  const lastExternalHashRef = useRef("");
  const liveRef = useRef({ t, formatNumber, dispatch, setToast });
  liveRef.current = { t, formatNumber, dispatch, setToast };

  useEffect(() => {
    let alive = true;

    const handleExternalSpec = (data: ExternalSpecPayload) => {
      if (!alive || !data || !data.spec || !data.spec_hash) return;
      if (data.spec_hash === lastExternalHashRef.current) return;

      const { t: strings, formatNumber: fmtNum, dispatch: emit, setToast: showToast } =
        liveRef.current;
      lastExternalHashRef.current = data.spec_hash;

      const partsCount = data.geometry_summary?.parts_count ?? (data.spec.parts?.length || 0);
      const paramsCount =
        data.geometry_summary?.parameters_count ?? (data.spec.parameters?.length || 0);
      const bounds = data.geometry_summary?.bounds;
      const dims = bounds
        ? ` · ${fmtNum(bounds.x)} × ${fmtNum(bounds.y)} × ${fmtNum(bounds.z)} mm`
        : "";
      const summary = strings.appPartsParams(fmtNum(partsCount), fmtNum(paramsCount));

      emit({
        type: "APPLY_DESIGN_RESULT",
        spec: data.spec,
        entry: {
          role: "agent",
          text: strings.appMcpSpecReceived(data.spec.name || "Family", `${summary}${dims}`),
          notes: data.spec.notes,
          meta: "⚡ MCP Real-time Sync",
          issues: (data.warnings || []).map((w) => ({
            message: w,
            severity: "warning",
            path: "spec",
          })),
        },
      });

      showToast({
        text: strings.appMcpLoadedTitle(data.spec.name || "Family"),
        sub: strings.appMcpLoadedSub(summary),
        tone: "ok",
      });
    };

    void fetchLatestExternalSpec().then((latest) => {
      if (alive && latest && latest.spec && latest.spec_hash) {
        handleExternalSpec(latest);
      }
    });

    const unsubscribe = subscribeExternalSpecStream(handleExternalSpec);

    const pollInterval = window.setInterval(async () => {
      if (!alive) return;
      const latest = await fetchLatestExternalSpec();
      if (alive && latest && latest.spec && latest.spec_hash) {
        handleExternalSpec(latest);
      }
    }, 2500);

    return () => {
      alive = false;
      unsubscribe();
      window.clearInterval(pollInterval);
    };
  }, []);
}
