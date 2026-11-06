import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { serverLog, type LogChunk } from "../lib/server";
import { serviceLogRead, serviceLogTail, type ServiceLogPage, type ServiceLogTarget } from "../lib/serviceConsoleApi";
import { appendChunk, emptyLogState, flushLogPending, type LogLine, type LogState } from "../lib/serverLog";

export type FetchLog = (offset: number) => Promise<LogChunk>;
export interface ServiceLogOptions { target: ServiceLogTarget; previous: boolean; runId?: string | null; projectRoot?: string | null; }
interface Entry {
  identity: string; state: LogState; history: LogLine[] | null; historyStart: number; historyEnd: number;
  offset: number; startOffset: number; size: number; fileId?: string; initialized: boolean;
  pendingOffset: number | null; error: string | null; updatedAt: number | null; truncated: boolean;
}
const entries = new Map<string, Entry>();
function entryFor(key: string, identity: string): Entry {
  const cached = entries.get(key);
  if (cached?.identity === identity) return cached;
  const entry: Entry = { identity, state: emptyLogState(), history: null, historyStart: 0, historyEnd: 0, offset: 0, startOffset: 0, size: 0, initialized: false, pendingOffset: null, error: null, updatedAt: null, truncated: false };
  entries.set(key, entry);
  // 两来源 × 两次运行的固定窗口，不随工程切换无限累积。
  if (entries.size > 4) entries.delete(entries.keys().next().value!);
  return entry;
}
function consumePage(entry: Entry, page: ServiceLogPage) {
  const before = entry.state;
  const state = appendChunk(before, page.text);
  state.lines = state.lines.map(line => line.id < before.nextId ? line : {
    ...line, offset: line.id === before.nextId && before.pending ? entry.pendingOffset ?? page.startOffset : page.lineOffsets[line.id - before.nextId] ?? page.startOffset,
  });
  entry.pendingOffset = state.pending ? page.lineOffsets[page.lineOffsets.length - 1] ?? page.offset : null;
  entry.state = state; entry.offset = page.offset; entry.startOffset = state.lines[0]?.offset ?? page.startOffset;
  entry.size = page.size; entry.fileId = page.fileId; entry.initialized = true;
  entry.truncated ||= page.truncated;
  if (page.text) entry.updatedAt = Date.now();
}

/** 增量单飞 + 文件身份 + 换工程 epoch；暂停跟随不停止数据接收。 */
export function useServerLog(active: boolean, generation: number, appHidden = false, fetchLog: FetchLog = serverLog, options?: ServiceLogOptions) {
  const key = options ? `${options.target}:${options.previous}` : "legacy";
  const instanceId = useId();
  const identity = `${key}:${options?.projectRoot ?? ""}:${options?.previous ? "previous" : `${generation}:${options?.runId ?? ""}`}:${options ? "" : instanceId}`;
  const [snapshot, setSnapshot] = useState(() => ({ ...entryFor(key, identity) }));
  const entryRef = useRef<Entry>(entryFor(key, identity));
  const epoch = useRef(0), inFlight = useRef<Promise<void> | null>(null), mounted = useRef(true);
  const invalidate = useCallback(() => { epoch.current++; }, []);
  const fetchRef = useRef(fetchLog), optionsRef = useRef(options), hiddenRef = useRef(appHidden), activeRef = useRef(active);
  fetchRef.current = fetchLog; optionsRef.current = options; hiddenRef.current = appHidden; activeRef.current = active;
  if (entryRef.current.identity !== identity || entryRef.current !== entries.get(key)) { entryRef.current = entryFor(key, identity); invalidate(); }
  const publish = useCallback(() => { if (mounted.current) setSnapshot({ ...entryRef.current }); }, []);
  const tick = useCallback(async () => {
    if (inFlight.current) { await inFlight.current; return; }
    if (hiddenRef.current || !mounted.current) return;
    const stamp = epoch.current, entry = entryRef.current, spec = optionsRef.current;
    const work = (async () => {
      try {
        if (!spec) {
          const chunk = await fetchRef.current(entry.offset);
          if (stamp !== epoch.current) return;
          entry.offset = chunk.offset; entry.state = appendChunk(entry.state, chunk.text); entry.initialized = true;
          if (chunk.text) entry.updatedAt = Date.now();
        } else {
          let page = entry.initialized ? await serviceLogRead(spec.target, spec.previous, entry.offset, entry.fileId) : await serviceLogTail(spec.target, spec.previous);
          if (stamp !== epoch.current) return;
          if (page.reset && entry.initialized) {
            page = await serviceLogTail(spec.target, spec.previous);
            if (stamp !== epoch.current) return;
            entry.state = emptyLogState(); entry.history = null; entry.pendingOffset = null;
          }
          consumePage(entry, page);
          if (page.eof && (!activeRef.current || spec.previous)) {
            const pendingId = entry.state.nextId, pendingOffset = entry.pendingOffset;
            entry.state = flushLogPending(entry.state);
            // 文件已结束的半行也需要原始起点，不能把下一块 offset 当成行位置。
            entry.state.lines = entry.state.lines.map(line => line.id === pendingId ? { ...line, offset: pendingOffset ?? page.offset } : line);
            entry.pendingOffset = null;
          }
        }
        entry.error = null;
      } catch (error) { if (stamp === epoch.current) entry.error = String(error); }
      if (stamp === epoch.current) publish();
    })();
    inFlight.current = work;
    try { await work; } finally { inFlight.current = null; if (stamp !== epoch.current && !hiddenRef.current && mounted.current) void tick(); }
  }, [publish]);
  const query = useQuery({ queryKey: ["service-console-log", key, identity], queryFn: async () => { await tick(); return Date.now(); }, enabled: !appHidden, refetchInterval: appHidden || !active || options?.previous ? false : 500, retry: false, staleTime: 0 });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; invalidate(); }; }, [invalidate]);
  useEffect(() => { publish(); }, [key, identity, publish]);
  const wasActive = useRef(active);
  useEffect(() => {
    const stopped = wasActive.current && !active; wasActive.current = active;
    if (!stopped || appHidden || options?.previous) return;
    let disposed = false;
    void (async () => { await tick(); await new Promise(resolve => setTimeout(resolve, 800)); if (!disposed) await tick(); })();
    return () => { disposed = true; };
  }, [active, appHidden, options?.previous, tick]);

  const currentEntry = entryRef.current;
  const reset = useCallback((from = 0) => {
    const entry = currentEntry;
    if (entry === entryRef.current) invalidate();
    entry.state = emptyLogState(); entry.history = null; entry.offset = from; entry.startOffset = from;
    entry.pendingOffset = null; entry.initialized = from > 0; entry.truncated = false; entry.error = null;
    publish();
  }, [currentEntry, publish, invalidate]);
  const [readingOlder, setReadingOlder] = useState(false);
  const olderLock = useRef(false);
  const readOlder = useCallback(async () => {
    const spec = optionsRef.current, entry = entryRef.current;
    if (!spec || olderLock.current || !(entry.history ? entry.historyStart : entry.startOffset)) return;
    olderLock.current = true; setReadingOlder(true); const stamp = epoch.current;
    try {
      if (inFlight.current) await inFlight.current;
      if (stamp !== epoch.current || hiddenRef.current) return;
      const before = entry.history ? entry.historyStart : entry.startOffset;
      const page = await serviceLogTail(spec.target, spec.previous, before, entry.fileId);
      if (stamp !== epoch.current) return;
      if (page.reset) { reset(); await tick(); return; }
      const state = flushLogPending(appendChunk(emptyLogState(), page.text));
      entry.history = state.lines.map((line, index) => ({ ...line, id: -(state.lines.length - index), offset: page.lineOffsets[line.id - 1] ?? page.startOffset }));
      entry.historyStart = entry.history[0]?.offset ?? page.startOffset;
      entry.historyEnd = page.offset;
      entry.truncated ||= page.truncated; entry.error = null; publish();
    } catch (error) { if (stamp === epoch.current) { entry.error = String(error); publish(); } }
    finally { olderLock.current = false; if (mounted.current) setReadingOlder(false); }
  }, [publish, reset, tick]);
  const showLatest = useCallback(() => { entryRef.current.history = null; publish(); }, [publish]);
  const data = snapshot.identity === identity ? snapshot : entryRef.current;
  return {
    lines: data.history ?? data.state.lines, error: data.error, reset, retry: () => void query.refetch(), readOlder, readingOlder,
    loading: query.isFetching && !data.initialized, updatedAt: data.updatedAt, fileId: data.fileId,
    startOffset: data.history ? data.historyStart : data.startOffset, endOffset: data.history ? data.historyEnd : data.offset, size: data.size,
    truncated: data.truncated, historical: data.history !== null, newestId: data.state.nextId - 1, showLatest,
  };
}
