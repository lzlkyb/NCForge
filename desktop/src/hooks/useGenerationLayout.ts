import { useEffect, useRef, useState } from "react";

export function useGenerationLayout() {
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"wide" | "medium" | "narrow">("wide");
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setMode(width >= 1080 ? "wide" : width >= 760 ? "medium" : "narrow");
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, mode };
}
