import { useEffect, useState } from "react";
import type { ToastState } from "./types";

/** Manages timed toast notifications with automatic cleanup. */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.action ? 6000 : 9000);
    return () => clearTimeout(timer);
  }, [toast]);

  return { toast, setToast };
}
