import { useEffect, useState } from "react";

export const DEFAULT_LEFT_WIDTH = 322;
export const DEFAULT_RIGHT_WIDTH = 342;
const MIN_LEFT_WIDTH = 240;
const MAX_LEFT_WIDTH = 560;
const MIN_RIGHT_WIDTH = 270;
const MAX_RIGHT_WIDTH = 620;
const MIN_VIEWER_WIDTH = 420;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredWidth(key: string, fallback: number): number {
  try {
    const stored = Number(window.localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  } catch {
    return fallback;
  }
}

function storeWidth(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* private mode, ignore */
  }
}

/** Manages left/right workspace pane widths (pointer + keyboard resize), mobile tabs, and storage. */
export function usePanelLayout() {
  const [mobileTab, setMobileTab] = useState<"chat" | "viewer" | "params">("chat");
  const [paramsOpen, setParamsOpen] = useState(false);
  const [leftWidth, setLeftWidth] = useState(() =>
    readStoredWidth("fa.leftWidth", DEFAULT_LEFT_WIDTH),
  );
  const [rightWidth, setRightWidth] = useState(() =>
    readStoredWidth("fa.rightWidth", DEFAULT_RIGHT_WIDTH),
  );

  useEffect(() => {
    storeWidth("fa.leftWidth", leftWidth);
  }, [leftWidth]);

  useEffect(() => {
    storeWidth("fa.rightWidth", rightWidth);
  }, [rightWidth]);

  const beginResize = (
    side: "left" | "right",
    event: { clientX: number; button: number; preventDefault: () => void },
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startLeft = leftWidth;
    const startRight = rightWidth;

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      if (side === "left") {
        const available = window.innerWidth - startRight - MIN_VIEWER_WIDTH - 12;
        setLeftWidth(clamp(startLeft + delta, MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, available)));
      } else {
        const available = window.innerWidth - startLeft - MIN_VIEWER_WIDTH - 12;
        setRightWidth(
          clamp(startRight - delta, MIN_RIGHT_WIDTH, Math.min(MAX_RIGHT_WIDTH, available)),
        );
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing");
    };

    document.body.classList.add("resizing");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const nudgeWidth = (side: "left" | "right", key: "ArrowLeft" | "ArrowRight") => {
    const step = key === "ArrowRight" ? 16 : -16;
    if (side === "left") {
      setLeftWidth((width) => clamp(width + step, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH));
    } else {
      setRightWidth((width) => clamp(width - step, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH));
    }
  };

  const resetWidth = (side: "left" | "right") => {
    if (side === "left") setLeftWidth(DEFAULT_LEFT_WIDTH);
    else setRightWidth(DEFAULT_RIGHT_WIDTH);
  };

  return {
    mobileTab,
    setMobileTab,
    paramsOpen,
    setParamsOpen,
    leftWidth,
    rightWidth,
    beginResize,
    nudgeWidth,
    resetWidth,
  };
}
