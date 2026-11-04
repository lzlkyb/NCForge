import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { invoke, listen } from "../lib/tauri";
import { beginOperation, type OperationHandle } from "../lib/operations";
import { formatBytes, RESOURCE_IDS, resourceBusy, type PackStatusInfo, type PackSummary, type ResourceErrorCode, type ResourceErrorPayload, type ResourcePhase, type ResourceReadyPayload } from "../lib/resource";
import { RESOURCE_DOWNLOAD_EVENT, RESOURCE_OPEN_EVENT, openResourceDownloads } from "../lib/resourceActions";
import { ResourceSetupDialog } from "../components/resource/ResourceSetupDialog";

type Installed = { id: string; version: string };
interface DownloadState {
  phase: ResourcePhase; packs: PackStatusInfo[]; missing: PackSummary[]; batch: PackSummary[];
  requestedIds: string[]; panelOpen: boolean; currentId: string | null;
  downloadedBytes: number; totalBytesCurrent: number | null; bytesPerSec: number;
  lastInstalled: Installed[]; adoptedLegacy: boolean; partialInstalled: Installed[];
  error: string | null; errorCode: ResourceErrorCode | null; errorToastAllowed: boolean;
}
export interface ResourceState extends DownloadState {
  totalBytes: number; busy: boolean; missingDismissed: boolean;
  ensure: (force?: boolean, ids?: string[]) => Promise<void>;
  retry: (ids?: string[]) => Promise<void>; showDownloads: () => void; dismissMissing: () => void;
  refreshStatus: () => Promise<PackStatusInfo[] | null>;
}
const initialState: DownloadState = {
  phase: "idle", packs: [], missing: [], batch: [], requestedIds: [], panelOpen: false,
  currentId: null, downloadedBytes: 0, totalBytesCurrent: null, bytesPerSec: 0,
  lastInstalled: [], adoptedLegacy: false, partialInstalled: [], error: null,
  errorCode: null, errorToastAllowed: false,
};
const mergeInstalled = (before: Installed[], after: Installed[]) => [...new Map([...before, ...after].map(p => [p.id, p])).values()];
interface ResourceListeners {
  active: boolean; ready: Promise<boolean>; resolve: (ready: boolean) => void;
  closed: Promise<boolean>; close: () => void; start?: () => Promise<boolean>; error?: string;
}
function createResourceListeners(): ResourceListeners {
  let resolve!: ResourceListeners["resolve"], close!: ResourceListeners["close"];
  const ready = new Promise<boolean>(done => { resolve = done; });
  const closed = new Promise<boolean>(done => { close = () => done(false); });
  return { active: true, ready, resolve, closed, close };
}
const ResourceContext = createContext<ResourceState | null>(null);
export function useResources() {
  const ctx = useContext(ResourceContext);
  if (!ctx) throw new Error("useResources 必须在 ResourceProvider 内使用");
  return ctx;
}

export function ResourceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  const locked = useRef(false);
  const requestForce = useRef(false);
  const attemptIds = useRef<string[]>([]);
  const statusReads = useRef({ request: 0, revision: 0 });
  const resourceTask = useRef<OperationHandle | null>(null);
  // 子组件的 effect 可以先发起下载，握手必须在首次渲染时就存在。
  const listenersRef = useRef<ResourceListeners | null>(null);
  if (!listenersRef.current) listenersRef.current = createResourceListeners();
  const commit = useCallback((patch: Partial<DownloadState>) => {
    // 同帧事件及连点必须看到刚更新的状态，不能等待 React 下一次渲染。
    stateRef.current = { ...stateRef.current, ...patch };
    setState(stateRef.current);
  }, []);
  const refreshStatus = useCallback(async () => {
    const request = ++statusReads.current.request;
    const revision = statusReads.current.revision;
    try {
      const list = await invoke<PackStatusInfo[]>("resources_status");
      // 设置页读取与安装事件可能并行：旧快照不能覆盖新安装或更新的读取结果。
      if (request !== statusReads.current.request || revision !== statusReads.current.revision) return stateRef.current.packs;
      commit({ packs: list });
      return list;
    } catch (e) {
      console.error("[Resource] 读取本地状态失败:", e);
      return null;
    }
  }, [commit]);
  const fail = useCallback((payload: ResourceErrorPayload) => {
    locked.current = false;
    const done = mergeInstalled(stateRef.current.lastInstalled, [
      ...(payload.installed ?? []), ...(payload.adoptedLegacy ?? []).map(id => ({ id, version: "" })),
    ]);
    resourceTask.current?.finish("failed", `${payload.message}${done.length ? `；已有 ${done.length} 个组件完成，其余可重试` : ""}`);
    resourceTask.current = null;
    commit({ phase: "error", error: payload.message, errorCode: (payload.code as ResourceErrorCode) ?? null, partialInstalled: done, lastInstalled: done, bytesPerSec: 0 });
  }, [commit]);
  const start = useCallback(async (force = false, selected?: string[], resume = false) => {
    const listeners = listenersRef.current!;
    if (!listeners.active) return;
    commit({ panelOpen: true });
    if (locked.current || resourceBusy(stateRef.current.phase)) return;
    const ids = [...new Set(selected ?? (force ? [...RESOURCE_IDS] : stateRef.current.packs.filter(p => p.state === "missing").map(p => p.id)))];
    if (!ids.length) return;
    if (ids.some(id => !(RESOURCE_IDS as readonly string[]).includes(id))) {
      commit({ phase: "error", error: "未知的运行组件，请刷新组件状态后重试", errorCode: "config" });
      return;
    }
    locked.current = true;
    if (!resume) requestForce.current = force;
    attemptIds.current = ids;
    const batch = resume ? stateRef.current.batch : ids.map(id => {
      const pack = stateRef.current.packs.find(p => p.id === id);
      return { id, title: pack?.title ?? id, notes: pack?.notes ?? "", size: pack?.size ?? 0 };
    });
    commit({ phase: "checking", error: null, errorCode: null, errorToastAllowed: true,
      batch, requestedIds: resume ? stateRef.current.requestedIds : ids, missing: [],
      lastInstalled: resume ? stateRef.current.lastInstalled : [], partialInstalled: resume ? stateRef.current.partialInstalled : [],
      currentId: null, downloadedBytes: 0, totalBytesCurrent: null, bytesPerSec: 0, adoptedLegacy: false });
    resourceTask.current = beginOperation({ key: "resources.ensure", label: force ? "重新下载运行组件" : "下载运行组件", page: "settings", phase: "检查组件清单", reveal: openResourceDownloads });
    try {
      // 监听注册完毕后才能发起网络操作，否则快速完成的事件可能丢失。
      const ready = await Promise.race([listeners.start?.() ?? listeners.ready, listeners.closed]);
      if (!listeners.active) return;
      if (!ready) throw new Error(listeners.error);
      await invoke("resources_ensure", { force, ids });
    } catch (e) {
      if (listeners.active) fail({ message: e instanceof Error ? e.message : String(e) });
    }
  }, [commit, fail]);
  const ensure = useCallback((force = false, ids?: string[]) => start(force, ids), [start]);
  const retry = useCallback((selected?: string[]) => {
    const remaining = stateRef.current.requestedIds.filter(id => (!selected || selected.includes(id)) && !stateRef.current.lastInstalled.some(p => p.id === id));
    // 强制重下失败时旧包仍可能可用；保留 force 才能真正修复失败的选中包。
    return start(requestForce.current, remaining, true);
  }, [start]);
  const showDownloads = useCallback(() => commit({ panelOpen: true }), [commit]);
  const dismissMissing = useCallback(() => commit({ panelOpen: false }), [commit]);

  useEffect(() => {
    let cancelled = false;
    const reads = statusReads.current;
    const listeners = listenersRef.current!.active ? listenersRef.current! : createResourceListeners();
    listenersRef.current = listeners;
    const unlisteners: (() => void)[] = [];
    const activeTransfer = () => ["downloading", "verifying", "installing"].includes(stateRef.current.phase);
    const finishReady = (payload: ResourceReadyPayload) => {
      statusReads.current.revision++;
      const confirmed = attemptIds.current.map(id => payload.installed.find(p => p.id === id)
        ?? { id, version: stateRef.current.packs.find(p => p.id === id)?.version ?? "" });
      attemptIds.current = [];
      locked.current = false;
      resourceTask.current?.finish("success", "所选运行组件已就绪");
      resourceTask.current = null;
      commit({ phase: "ready", currentId: null, missing: [], partialInstalled: [], bytesPerSec: 0,
        lastInstalled: mergeInstalled(stateRef.current.lastInstalled, mergeInstalled(confirmed, payload.installed)), adoptedLegacy: payload.adoptedLegacy });
      void refreshStatus();
    };
    const stage = (phase: "verifying" | "installing", id: string) => {
      locked.current = true;
      commit({ phase, currentId: id, bytesPerSec: 0 });
      resourceTask.current?.update({ phase: `${phase === "verifying" ? "校验" : "安装"}组件 ${id}`, progress: undefined, detail: "下载已完成，正在准备组件" });
    };
    const register = async <T,>(event: string, handler: (payload: T) => void) => {
      if (cancelled) return;
      const stop = await listen<T>(event, payload => { if (!cancelled) handler(payload); });
      if (cancelled) stop(); else unlisteners.push(stop);
    };
    const setupListeners = async () => {
      await register("resource:checking", () => {
        if (!activeTransfer()) commit({ phase: "checking", error: null, errorCode: null });
      });
      await register<{ packs: PackSummary[]; totalBytes: number }>("resource:available", payload => {
        if (activeTransfer()) return;
        const old = stateRef.current.batch;
        const batch = old.length ? old.map(p => payload.packs.find(next => next.id === p.id) ?? p) : payload.packs;
        commit({ missing: payload.packs, batch, phase: "checking" });
      });
      await register("resource:uptodate", () => {
        // 后台仍持有单飞锁，只有随后真正的 ready 才能结束本次任务。
        if (!activeTransfer()) resourceTask.current?.update({ phase: "所选组件已存在，确认可用状态" });
      });
      await register<{ id: string }>("resource:downloading", ({ id }) => {
        locked.current = true;
        commit({ phase: "downloading", currentId: id, downloadedBytes: 0, totalBytesCurrent: null, bytesPerSec: 0 });
        resourceTask.current?.update({ phase: `下载组件 ${id}`, detail: undefined, progress: undefined });
      });
      await register<{ id: string; downloaded: number; total: number | null; bytesPerSec: number }>("resource:progress", payload => {
        if (stateRef.current.currentId && payload.id !== stateRef.current.currentId) return;
        commit({ downloadedBytes: payload.downloaded, totalBytesCurrent: payload.total, bytesPerSec: payload.bytesPerSec });
        resourceTask.current?.update({ phase: `下载组件 ${payload.id}`, progress: { done: payload.downloaded, total: payload.total ?? undefined }, detail: `${formatBytes(payload.downloaded)}${payload.total ? ` / ${formatBytes(payload.total)}` : " · 总大小未知"} · ${payload.bytesPerSec > 0 ? `${formatBytes(payload.bytesPerSec)}/s` : "计算速率中…"}` });
      });
      await register<{ id: string }>("resource:verifying", ({ id }) => stage("verifying", id));
      await register<{ id: string }>("resource:installing", ({ id }) => stage("installing", id));
      await register<Installed>("resource:installed", payload => {
        statusReads.current.revision++;
        const packs = stateRef.current.packs.map(p => p.id === payload.id ? { ...p, state: "installed" as const, version: payload.version } : p);
        commit({ packs, lastInstalled: mergeInstalled(stateRef.current.lastInstalled, [payload]) });
      });
      await register<ResourceReadyPayload>("resource:ready", finishReady);
      await register<ResourceErrorPayload>("resource:error", fail);
    };
    let registration: Promise<boolean> | null = null;
    listeners.start = () => {
      // 注册失败要释放半成品，下次请求重新注册；同一轮等待者共享一次注册。
      if (!registration) registration = setupListeners().then(() => true, e => {
        unlisteners.splice(0).forEach(stop => stop());
        listeners.error = `组件监听注册失败，请重试：${String(e)}`;
        registration = null;
        return false;
      });
      return registration;
    };
    void listeners.start().then(ready => {
      listeners.resolve(ready);
      if (cancelled) return;
      // 首启仅读取本地状态，缺失组件由用户或对应功能按需下载。
      if (ready) void refreshStatus();
      else if (!locked.current) fail({ message: listeners.error! });
    });
    const onDownload = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (id) void ensure(false, [id]);
    };
    window.addEventListener(RESOURCE_DOWNLOAD_EVENT, onDownload);
    window.addEventListener(RESOURCE_OPEN_EVENT, showDownloads);
    return () => {
      cancelled = true;
      listeners.active = false;
      listeners.close(); listeners.resolve(false);
      locked.current = false;
      reads.request++;
      unlisteners.forEach(stop => stop());
      window.removeEventListener(RESOURCE_DOWNLOAD_EVENT, onDownload);
      window.removeEventListener(RESOURCE_OPEN_EVENT, showDownloads);
      resourceTask.current?.finish("failed", "组件监听已关闭，后台结果尚未确认");
      resourceTask.current = null;
    };
  }, [commit, ensure, fail, refreshStatus, showDownloads]);
  const value = useMemo(() => ({ ...state, totalBytes: state.batch.reduce((sum, p) => sum + p.size, 0),
    busy: resourceBusy(state.phase), missingDismissed: !state.panelOpen, ensure, retry, showDownloads, refreshStatus, dismissMissing,
  }), [state, ensure, retry, showDownloads, refreshStatus, dismissMissing]);
  return <ResourceContext.Provider value={value}>
    {children}
    <ResourceSetupDialog {...state} open={state.panelOpen} onDownload={ensure} onRetry={ids => void retry(ids)} onDismiss={dismissMissing} />
  </ResourceContext.Provider>;
}
