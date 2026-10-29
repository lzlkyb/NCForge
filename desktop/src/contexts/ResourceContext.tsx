import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { invoke, listen } from "../lib/tauri";
import type { PackStatusInfo, PackSummary, ResourceErrorCode, ResourceErrorPayload, ResourcePhase, ResourceReadyPayload } from "../lib/resource";
import { ResourceSetupDialog } from "../components/resource/ResourceSetupDialog";

// ─── 类型定义 ────────────────────────────

export interface ResourceState {
  /** 置备阶段（事件驱动，见下方监听 effect） */
  phase: ResourcePhase;
  /** 本地状态快照（resources_status，设置页用；不含联网） */
  packs: PackStatusInfo[];
  /** 待下载的包（resource:available 带全量信息，初始化对话框用） */
  missing: PackSummary[];
  /** missing 总字节数（对话框「共 X MB」） */
  totalBytes: number;
  /** 正在下载的包 id；非下载中为 null */
  currentId: string | null;
  /** 当前包已下载字节 */
  downloadedBytes: number;
  /** 当前包总字节（源不给 Content-Length 时为 null ⇒ 不确定态） */
  totalBytesCurrent: number | null;
  /** 下载速率（字节/秒），~250ms 窗口 */
  bytesPerSec: number;
  /** 刚完成的动作摘要（ready 事件）：装了什么 / 是否认领了旧版 */
  lastInstalled: { id: string; version: string }[];
  adoptedLegacy: boolean;
  /** 失败前已完成的部分（error 事件的 installed 数组）：对话框据此显示
   *  「N/3 已就绪」——这些包已在 state 里，重试会自动跳过 */
  partialInstalled: { id: string; version: string }[];
  error: string | null;
  errorCode: ResourceErrorCode | null;
  /** 本次失败是否该弹 toast（与 UpdateContext 同款：自动发起的不弹） */
  errorToastAllowed: boolean;
  /** 触发置备（force=true 无视已有状态重下，设置页用） */
  ensure: (force?: boolean) => Promise<void>;
  /** 重拉本地状态快照（不联网）；返回快照内容，调用方可基于它做判断 */
  refreshStatus: () => Promise<PackStatusInfo[] | null>;
  /** 关闭初始化对话框（仅本会话；下载在后台继续） */
  dismissMissing: () => void;
  /** 本次会话是否已手动关过对话框 */
  missingDismissed: boolean;
}

// ─── Provider ────────────────────────────

const ResourceContext = createContext<ResourceState | null>(null);

export function useResources() {
  const ctx = useContext(ResourceContext);
  if (!ctx) throw new Error("useResources 必须在 ResourceProvider 内使用");
  return ctx;
}

export function ResourceProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<ResourcePhase>("idle");
  const [packs, setPacks] = useState<PackStatusInfo[]>([]);
  const [missing, setMissing] = useState<PackSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytesCurrent, setTotalBytesCurrent] = useState<number | null>(null);
  const [bytesPerSec, setBytesPerSec] = useState(0);
  const [lastInstalled, setLastInstalled] = useState<{ id: string; version: string }[]>([]);
  const [adoptedLegacy, setAdoptedLegacy] = useState(false);
  const [partialInstalled, setPartialInstalled] = useState<{ id: string; version: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ResourceErrorCode | null>(null);
  const [errorToastAllowed, setErrorToastAllowed] = useState(true);
  const [missingDismissed, setMissingDismissed] = useState(false);
  /** 本次 ensure 是否由用户主动发起（设置页重下 / 对话框重试），决定失败弹不弹 toast */
  const userInitiatedRef = useRef(false);
  /** 下载守卫：downloading 期间 checking/available/uptodate 不回退状态（同 UpdateContext 套路） */
  const downloadingRef = useRef(false);

  const totalBytes = missing.reduce((sum, p) => sum + p.size, 0);

  // ─── 本地状态快照（不联网）─────

  const refreshStatus = useCallback(async () => {
    try {
      const list = await invoke<PackStatusInfo[]>("resources_status");
      setPacks(list);
      return list;
    } catch (e) {
      // 快照失败不置 error：它只是设置页的展示源，置错会把「没网」误报成
      // 「组件下载失败」（真正的下载状态由事件驱动，不走这里）。
      console.error("[Resource] 读取本地状态失败:", e);
      return null;
    }
  }, []);

  // ─── 触发置备 ────────────────────
  // 后端 ensure_packs 是一路下载到底的编排（拉清单 → 缺的下载安装），
  // 前端只负责发起 + 收听事件，不自己维护下载状态机（避免双真相源）。

  const ensure = useCallback(
    async (force = false) => {
      if (downloadingRef.current) return;
      setPhase("checking");
      setError(null);
      setErrorCode(null);
      setPartialInstalled([]);
      try {
        await invoke("resources_ensure", { force });
      } catch (e) {
        // invoke 直接 reject（后端没接住）才走到这里；后端的 resource:error
        // 事件覆盖不了这条路径。
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Resource] resources_ensure invoke 失败:", msg);
        setError(msg);
        setErrorCode(null);
        setErrorToastAllowed(userInitiatedRef.current);
        setPhase("error");
      }
    },
    [],
  );

  // ─── 监听后台置备事件 + 启动自检 ────────────────────
  // 两者必须在同一个 effect 里、且自检晚于**全部** listen 注册完成：
  // listen() 是异步 IPC，而 Rust 侧 main.rs 的启动自检 spawn 后很快就会 emit；
  // 若发起早于监听注册，available 等事件会在注册前发出、永久丢失
  // （UpdateContext 在 macOS CI 上抓到过同款竞态，见那里的长注释）。
  //
  // 这里即使与 Rust 启动自检撞车也无副作用：后端有单飞闸，前端这次 invoke
  // 若被挡住，Rust 自检的后续事件照样送达已注册的监听器；若自检已结束，
  // 前端这轮会真正跑一遍（本地已装则秒回 uptodate）。
  //
  // 只有本地快照显示有 missing 时才发起 ensure：快照说全部就绪就别打扰用户
  // （legacy 认领用户的快照是 installed/legacy，不会走到这里）。
  useEffect(() => {
    let cancelled = false;
    const unlisteners: (() => void)[] = [];
    // async 注册期间若组件已卸载（StrictMode/快速重挂载），立即注销刚注册的监听，
    // 避免监听器泄漏与重复注册（同 UpdateContext 的 track）。
    const track = (fn: () => void) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    };

    const setupListeners = async () => {
      track(
        await listen("resource:checking", () => {
          // 下载进行中不回退状态（后端一轮 ensure 内部顺序发
          // checking→available→downloading；这里防御的是下载中又触发一轮的场景）
          if (downloadingRef.current) return;
          setPhase("checking");
          setError(null);
          setErrorCode(null);
          setPartialInstalled([]);
        }),
      );
      track(
        await listen<{ packs: PackSummary[]; totalBytes: number }>("resource:available", (payload) => {
          if (downloadingRef.current) return;
          setMissing(payload.packs);
          setPhase("checking");
        }),
      );
      track(
        await listen("resource:uptodate", () => {
          if (downloadingRef.current) return;
          setMissing([]);
          setPartialInstalled([]);
          setPhase("idle");
        }),
      );
      track(
        await listen<{ id: string }>("resource:downloading", (payload) => {
          downloadingRef.current = true;
          setCurrentId(payload.id);
          setDownloadedBytes(0);
          setTotalBytesCurrent(null);
          setBytesPerSec(0);
          setPhase("downloading");
        }),
      );
      track(
        await listen<{ id: string; downloaded: number; total: number | null; bytesPerSec: number }>(
          "resource:progress",
          (payload) => {
            setDownloadedBytes(payload.downloaded);
            // total 为 null（源不给 Content-Length）时保持 null ⇒ UI 走不确定态。
            setTotalBytesCurrent(payload.total);
            setBytesPerSec(payload.bytesPerSec);
          },
        ),
      );
      track(
        await listen<{ id: string; version: string }>("resource:installed", () => {
          // 单包装好的展示由 ready 统一收尾；这里不切 phase，
          // 避免多包下载时每装一个包就闪一次「完成」。
        }),
      );
      track(
        await listen<ResourceReadyPayload>("resource:ready", (payload) => {
          downloadingRef.current = false;
          setCurrentId(null);
          setMissing([]);
          setPartialInstalled([]);
          setLastInstalled(payload.installed);
          setAdoptedLegacy(payload.adoptedLegacy);
          setPhase("ready");
          void refreshStatus();
        }),
      );
      track(
        await listen<ResourceErrorPayload>("resource:error", (payload) => {
          downloadingRef.current = false;
          setCurrentId(null);
          setError(payload.message);
          setErrorCode((payload.code as ResourceErrorCode) ?? null);
          // 失败前已完成的部分（后端 EnsureFailure.outcome）：旧版本后端不发
          // 这两个字段，?? [] 兜底。adoptedLegacy 在这里是 string[]（id 列表），
          // 与 ready 事件的 boolean 不同——error 路径要的是「哪些包已就绪」。
          const done = payload.installed ?? [];
          const legacyIds = payload.adoptedLegacy ?? [];
          setPartialInstalled([
            ...done,
            ...legacyIds.map((id) => ({ id, version: "" })),
          ]);
          setErrorToastAllowed(userInitiatedRef.current);
          setPhase("error");
        }),
      );
    };

    setupListeners().then(() => {
      // cancelled 时不再发起自检（组件已卸载，监听器也已注销）
      if (cancelled) return;
      void (async () => {
        const list = await refreshStatus();
        if (cancelled) return;
        if (list && list.some((p) => p.state === "missing")) {
          void ensure(false);
        }
      })();
    });
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [refreshStatus, ensure]);

  const dismissMissing = useCallback(() => setMissingDismissed(true), []);

  return (
    <ResourceContext.Provider
      value={{
        phase,
        packs,
        missing,
        totalBytes,
        currentId,
        downloadedBytes,
        totalBytesCurrent,
        bytesPerSec,
        lastInstalled,
        adoptedLegacy,
        partialInstalled,
        error,
        errorCode,
        errorToastAllowed,
        ensure: (force = false) => {
          userInitiatedRef.current = force;
          return ensure(force);
        },
        refreshStatus,
        dismissMissing,
        missingDismissed,
      }}
    >
      {children}
      {/* 初始化对话框：有缺失包且用户没手动关过才显示。下载/失败态都停着，
          完成（ready）时 missing 清空自动关闭。 */}
      {missing.length > 0 && !missingDismissed && (
        <ResourceSetupDialog
          missing={missing}
          totalBytes={totalBytes}
          phase={phase}
          currentId={currentId}
          downloadedBytes={downloadedBytes}
          totalBytesCurrent={totalBytesCurrent}
          bytesPerSec={bytesPerSec}
          partialInstalled={partialInstalled}
          error={error}
          errorCode={errorCode}
          onRetry={() => void ensure(false)}
          onDismiss={dismissMissing}
        />
      )}
    </ResourceContext.Provider>
  );
}
