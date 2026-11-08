import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

const STORAGE_KEY = "ncforge-db-result-height";
const MIN_RESULT = 90;
const MIN_EDITOR = 140;
const SPLITTER = 5;
export type SqlConsoleFocus = "split" | "editor" | "results";
interface ConsoleLayout { preferred: number; focus: SqlConsoleFocus }
function savedHeight(): number {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value >= MIN_RESULT ? value : 300;
  } catch { return 300; }
}

/** 保存用户偏好，实际高度随可用空间限制；缩小窗口不能覆盖正常窗口的偏好。 */
export function useSqlConsoleSplit(tabId: string) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const [initialHeight] = useState(savedHeight);
  const [layouts, setLayouts] = useState<Record<string, ConsoleLayout>>({});
  const preferred = layouts[tabId]?.preferred ?? initialHeight;
  const focus = layouts[tabId]?.focus ?? "split";
  const preferredRef = useRef(new Map<string, number>());
  const [bodyHeight, setBodyHeight] = useState(0);
  const max = bodyHeight > 0 ? Math.max(MIN_RESULT, bodyHeight - MIN_EDITOR - SPLITTER) : preferred;
  const height = Math.min(preferred, max);

  // 首次绘制前限制保存的高度，避免在低窗口先用原始偏好挤压编辑器。
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => { if (body.clientHeight > 0) setBodyHeight(body.clientHeight); };
    const observer = new ResizeObserver(measure);
    observer.observe(body); measure();
    return () => { observer.disconnect(); dragCleanup.current?.(); };
  }, []);
  useLayoutEffect(() => () => { dragCleanup.current?.(); }, [tabId]);

  const currentMax = () => Math.max(MIN_RESULT, (bodyRef.current?.clientHeight || bodyHeight) - MIN_EDITOR - SPLITTER);
  const change = (value: number) => {
    const next = Math.max(MIN_RESULT, Math.min(currentMax(), value));
    preferredRef.current.set(tabId, next);
    setLayouts(current => ({ ...current, [tabId]: { preferred: next, focus: current[tabId]?.focus ?? "split" } }));
  };
  const save = () => { try { localStorage.setItem(STORAGE_KEY, String(preferredRef.current.get(tabId) ?? preferred)); } catch { /* 当前高度仍有效。 */ } };
  const setFocus = (next: SqlConsoleFocus) => {
    dragCleanup.current?.();
    // 专注模式属于当前文档，不能把隐藏后的全高写回用户的分隔比例。
    setLayouts(current => ({ ...current, [tabId]: { preferred: current[tabId]?.preferred ?? initialHeight, focus: next } }));
  };
  const startDrag = (startY: number) => {
    if (focus !== "split") return;
    dragCleanup.current?.();
    const start = height;
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      dragCleanup.current = null; save();
    };
    const move = (event: PointerEvent) => {
      if (event.buttons === 0) return finish();
      change(start + startY - event.clientY);
    };
    dragCleanup.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (focus !== "split") return;
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowUp") change(height + step);
    else if (event.key === "ArrowDown") change(height - step);
    else if (event.key === "Home") change(MIN_RESULT);
    else if (event.key === "End") change(currentMax());
    else return;
    event.preventDefault(); save();
  };
  return { bodyRef, height, resultHeight: focus === "results" ? bodyHeight || height : height, focus, setFocus, min: MIN_RESULT, max, startDrag, onKeyDown };
}
