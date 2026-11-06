import { useCallback, useEffect, useLayoutEffect, useState } from "react";

const STORAGE_KEY = "ncforge.meta.layout";
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
function storedWidths() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return { resource: clamp(Number(data?.resource) || 224, 190, 320), inspector: clamp(Number(data?.inspector) || 280, 260, 400) };
  } catch { return { resource: 224, inspector: 280 }; }
}

/** 按停靠区的实际尺寸适配；全局侧栏/分屏也会减少元数据的可用空间。 */
export function useMetaLayout() {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  // DockRegion 首次渲染还没有 portal 宿主；回调 ref 在真正挂载后才开始监听。
  const ref = useCallback((element: HTMLDivElement | null) => setNode(element), []);
  const [size, setSize] = useState({ width: 1600, height: 800 });
  const [widths, setWidths] = useState(storedWidths);
  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      if (width > 0 && height > 0) setSize({ width, height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(widths)); } catch { /* 禁用本地存储仍可调整。 */ }
  }, [widths]);
  return {
    ref, size, widths, setWidths,
    resourceDrawer: size.width <= 1100,
    inspectorDrawer: size.width < 1480,
    compact: size.height <= 660 || size.width <= 720,
  };
}
