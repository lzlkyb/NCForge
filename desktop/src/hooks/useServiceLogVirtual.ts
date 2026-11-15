import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { rowAtOffset, type ServiceLogRow } from "../lib/serviceLogRows";
import { useScrollFrame } from "./useScrollFrame";
import { retainViewport } from "../lib/scrollViewport";

/** 动态换行与栈展开逐行测高；滚动只挂可见窗口，不截掉已加载历史。 */
export function useServiceLogVirtual(rows: ServiceLogRow[], body: RefObject<HTMLDivElement>, follow: boolean, visible: boolean, wrap: boolean, fontSize: number, savedTop: number) {
  const [viewport, setViewport] = useState({ top: savedTop, height: 240, width: 0 });
  const [version, setVersion] = useState(0);
  const heights = useRef(new Map<string, number>());
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const anchor = useRef<{ key: string; delta: number } | null>(null);
  const requested = useRef<string | null>(null);
  const config = useRef("");
  const indexes = useMemo(() => {
    const next = new Map(rows.map((row, index) => [row.key, index]));
    // 行窗口有上限，但日志 id 会持续递增；移除被淘汰行，测高缓存才同样有界。
    for (const key of heights.current.keys()) if (!next.has(key)) heights.current.delete(key);
    return next;
  }, [rows]);
  const offsets = useMemo(() => {
    void version;
    const values = [0], estimate = Math.ceil(fontSize * 1.75);
    for (const row of rows) values.push(values[values.length - 1] + (heights.current.get(row.key) ?? estimate));
    return values;
  }, [rows, fontSize, version]);
  const latest = useRef({ rows, offsets, indexes }); latest.current = { rows, offsets, indexes };
  const padding = Math.max(160, Math.ceil(fontSize * 1.75) * 8);
  const refresh = useScrollFrame(() => {
    const element = body.current;
    if (element) setViewport(previous => retainViewport(previous, { top: element.scrollTop, height: element.clientHeight, width: element.clientWidth }, padding));
  });
  const measured = useScrollFrame(() => setVersion(value => value + 1));
  const onScroll = useCallback(() => {
    const element = body.current; if (!element) return;
    const data = latest.current, index = rowAtOffset(data.offsets, element.scrollTop);
    const row = data.rows[index]; anchor.current = row ? { key: row.key, delta: element.scrollTop - data.offsets[index] } : null;
    refresh.schedule();
  }, [body, refresh]);
  useLayoutEffect(() => {
    if (!visible || !body.current) return;
    const element = body.current;
    const measure = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        if (entry.target === element) { refresh.schedule(); continue; }
        const key = entry.target.getAttribute("data-row-key");
        if (!key) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
        if (height > 0 && Math.abs(height - (heights.current.get(key) ?? 0)) > .25) { heights.current.set(key, height); changed = true; }
      }
      if (changed) measured.schedule();
    });
    observer.current = measure; measure.observe(element); nodes.current.forEach(node => measure.observe(node)); refresh.flush();
    return () => { observer.current = null; measure.disconnect(); refresh.cancel(); measured.cancel(); };
  }, [body, refresh, measured, visible]);
  useLayoutEffect(() => {
    const next = `${wrap}:${fontSize}:${viewport.width}`;
    if (config.current === next) return;
    config.current = next; heights.current.clear();
    // ResizeObserver 不一定为样式未变的节点再发事件，所以主动补测当前窗口。
    nodes.current.forEach((node, key) => { const height = node.getBoundingClientRect().height; if (height > 0) heights.current.set(key, height); });
    setVersion(value => value + 1);
  }, [wrap, fontSize, viewport.width]);
  useLayoutEffect(() => {
    const element = body.current; if (!element || !visible) return;
    const total = offsets[offsets.length - 1];
    if (requested.current && indexes.has(requested.current)) {
      element.scrollTop = offsets[indexes.get(requested.current)!]; requested.current = null; anchor.current = null;
    } else if (follow) element.scrollTop = Math.max(0, total - element.clientHeight);
    else if (anchor.current && indexes.has(anchor.current.key)) element.scrollTop = offsets[indexes.get(anchor.current.key)!] + anchor.current.delta;
    else element.scrollTop = Math.min(savedTop, Math.max(0, total - element.clientHeight));
    refresh.flush();
  }, [body, offsets, indexes, follow, visible, savedTop, refresh]);
  const rowRef = useCallback((key: string, node: HTMLDivElement | null) => {
    const previous = nodes.current.get(key); if (previous) observer.current?.unobserve(previous);
    if (!node) { nodes.current.delete(key); return; }
    nodes.current.set(key, node); observer.current?.observe(node);
  }, []);
  const jumpTo = useCallback((key: string) => {
    requested.current = key;
    const element = body.current, data = latest.current, index = data.indexes.get(key);
    if (element && index !== undefined) { element.scrollTop = data.offsets[index]; requested.current = null; anchor.current = null; refresh.flush(); }
  }, [body, refresh]);
  const start = Math.max(0, rowAtOffset(offsets, Math.max(0, viewport.top - padding)));
  const end = Math.min(rows.length, rowAtOffset(offsets, viewport.top + viewport.height + padding) + 2);
  return { start, end, offsets, height: offsets[offsets.length - 1], rowRef, onScroll, jumpTo };
}
