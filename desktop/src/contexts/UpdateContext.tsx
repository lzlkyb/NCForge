import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "../lib/tauri";
import { beginOperation, type OperationHandle } from "../lib/operations";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { UpdateNotesDialog } from "../components/update/UpdateNotesDialog";
import { RestartOverlay } from "../components/update/RestartOverlay";
import { recordUpdateResult } from "../lib/updateResult";
import { APP_SLUG } from "../lib/about";
import { prepareRestart } from "../lib/terminatePreflight";
import { useUpdateDownloadPreference } from "../lib/updateDownloadPreference";
import { useAppHidden } from "../lib/appVisibility";

// ─── 类型定义 ────────────────────────────

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error" | "uptodate";

/** 更新信息（由后端 check_update / start_update 通过事件推送，仅含展示所需字段，不再依赖插件 Update 对象） */
export interface UpdateInfo {
  version?: string;
  body?: string | null;
  /** 发布日期（ISO 8601 / RFC 3339），如 "2026-07-17T00:00:00Z" */
  date?: string | null;
  /** 当前运行版本，用于弹框里展示 "v旧 → v新" */
  currentVersion?: string;
}

export interface UpdateState {
  status: UpdateStatus;
  update: UpdateInfo | null;
  /** 下载进度 0-100 */
  progress: number;
  /** 进度未知（total=null，无法计算百分比）时为 true，UI 显示不确定态 */
  progressIndeterminate: boolean;
  /** 下载速率（字节/秒），~250ms 窗口重算一次；下载刚开始第一个窗口还没算完时为 0。 */
  bytesPerSec: number;
  /** 已下载字节数（后端每 chunk 都发 downloaded）；无总大小时用于展示"已下载 X MB" */
  downloadedBytes: number;
  /** 下载总量（字节）；后端拿不到 Content-Length 时为 null ⇒ UI 走不确定态 */
  totalBytes: number | null;
  /** 用户确认安装后展示过渡层，安装返回后再 relaunch。 */
  restarting: boolean;
  /** 安装前的文件、事务与运行任务检查尚未结束。 */
  preparing: boolean;
  notesOpen: boolean;
  error: string | null;
  /** 错误原因码（见 `UpdateErrorCode`）；旧后端或未知错误为 null */
  errorCode: string | null;
  failureStage?: "check" | "download";
  tryingBackup?: boolean;
  installBlock?: string | null;
  openInstallBlock?: () => void;
  /**
   * 本次失败是否该弹 toast。
   *
   * 自动检查（启动自检 / 24 小时定时）失败时**只更新徽章与关于页状态**，不弹红 toast ——
   * 用户什么都没点，不该在开机时收到「更新服务器连不上」的警报（尤其在公司网络封了
   * Gitee/GitHub 的环境里，那会是每天都来一次的噪音）。用户主动点击的检查、以及
   * 下载安装失败，仍然弹。
   */
  errorToastAllowed: boolean;
  checkForUpdate: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  retryUpdate: () => Promise<void>;
  restart: () => Promise<void>;
  /** 打开「查看更新内容」弹窗 */
  openUpdateNotes: () => void;
  closeUpdateNotes: () => void;
  /** 明确忽略当前版本；关闭或稍后仅抑制本次运行。 */
  dismissUpdate: () => void;
  /** 判断某版本是否已被明确忽略。 */
  isDismissed: (version?: string) => boolean;
  /** 本次「已是最新」提示是否来自手动检查：自动检查（启动/定时）不弹框，只在版本号 pill 提示 */
  manualCheck: boolean;
  /** 手动检查「已是最新」toast 已消费后复位 manualCheck */
  acknowledgeUptodate: () => void;
  /** 手动触发检查更新（用户主动点击，命中 uptodate 时才弹「已是最新」提示框） */
  manualCheckForUpdate: () => Promise<void>;
}

// ─── 友好错误翻译 ────────────────────────

export interface FriendlyError {
  /** 用户友好文案 */
  friendly: string;
  /** 原始错误信息（技术细节） */
  raw: string;
}

/**
 * 后端 `update:error` 的机器可读原因码（Rust 侧 `classify_update_error` 产出）。
 *
 * 为什么要有它：原先只有一段原始英文错误，前端靠 `includes("fetch")` 猜原因。
 * 插件的 manifest 错误文案恰好含 "fetch"，于是「源上 404」被翻译成「你的网络有问题」，
 * 而真正的 `error sending request` 反而落到兜底 —— 两个方向都错（2026-10-22 实测）。
 * 有了 code 之后文案由后端定性、前端只负责措辞。
 */
export type UpdateErrorCode =
  | "manifest"
  | "network"
  | "timeout"
  | "signature"
  | "install"
  | "config"
  | "stale"
  | "unknown";

/** code → 用户文案。键必须与 Rust 侧 `classify_update_error` 的返回值一一对应。 */
const ERROR_TEXT: Record<string, string> = {
  manifest: "更新服务器上暂时没有可用的更新信息，请稍后重试",
  network: "无法连接更新服务器，请检查网络或代理设置",
  timeout: "连接更新服务器超时，请稍后重试",
  signature: "更新包校验失败，已阻止安装，请重试",
  install: "更新包安装失败，请重试，或到 GitHub Releases 手动下载",
  config: "更新源配置有误，请检查更新源设置",
  stale: "这个版本刚有变动，请重新检查更新",
};

/**
 * 将原始错误信息拆分为友好提示 + 原始错误。
 *
 * `code` 优先；缺失或为 `unknown` 时回退到字符串启发式（兼容旧后端与未覆盖的错误类型）。
 * 🔴 回退分支的**判断顺序不能换**：具体判定必须排在泛化的 "fetch" 之前，否则插件那句
 * `Could not fetch a valid release JSON from the remote` 又会被当成网络故障。
 */
export function friendlyError(raw: string, code?: string | null): FriendlyError {
  const mapped = code ? ERROR_TEXT[code] : undefined;
  if (mapped) return { friendly: mapped, raw };

  const lower = raw.toLowerCase();
  if (lower.includes("could not fetch a valid release json")) {
    return { friendly: ERROR_TEXT.manifest, raw };
  }
  if (lower.includes("signature") || lower.includes("minisign")) {
    return { friendly: ERROR_TEXT.signature, raw };
  }
  if (lower.includes("enotfound") || lower.includes("getaddrinfo") || lower.includes("dns")) {
    return { friendly: "无法解析更新服务器地址，请检查网络连接", raw };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { friendly: ERROR_TEXT.timeout, raw };
  }
  if (
    lower.includes("networkerror") ||
    lower.includes("failed to fetch") ||
    lower.includes("error sending request") ||
    lower.includes("connection")
  ) {
    return { friendly: ERROR_TEXT.network, raw };
  }
  if (lower.includes("403") || lower.includes("rate limit")) {
    // 第一候选源是 Gitee，文案不再写死 GitHub。
    return { friendly: "更新服务器拒绝访问（可能触发了限流），请稍后重试", raw };
  }
  return { friendly: "更新失败，请重试", raw };
}

const UpdateContext = createContext<UpdateState | null>(null);

export function useUpdate() {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate 必须在 UpdateProvider 内使用");
  return ctx;
}

// ─── 常量 ──────────────────────────────

/** 自动检查间隔：24 小时 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// 存储键带 APP_SLUG 前缀（与 windowState/appearance 同一套机制）：多个 Tauri 应用
// 可能共用同一个 webview origin，不带前缀会互相串台——A 应用记了"24 小时内查过"，
// B 应用的启动自检就被悄悄吞掉。改名天然跟随，无需在此维护。
const LAST_CHECK_KEY = `${APP_SLUG}.last_update_check`;
/** 单独存储明确忽略，旧版“稍后”的持久记录不能继续阻止启动提醒。 */
const DISMISSED_KEY = `${APP_SLUG}.ignored_update_version`;
/** 重启过渡层停留时长：这段刻意的等待本身就是「正在应用更新」的载体（方案 C） */
const RESTART_OVERLAY_MS = 1100;

interface UpdateListeners {
  active: boolean;
  ready: Promise<boolean>;
  resolve: (ready: boolean) => void;
  closed: Promise<boolean>;
  close: () => void;
  start?: () => Promise<boolean>;
  error?: string;
}

function createUpdateListeners(): UpdateListeners {
  let resolve!: UpdateListeners["resolve"];
  let close!: UpdateListeners["close"];
  const ready = new Promise<boolean>(done => { resolve = done; });
  const closed = new Promise<boolean>(done => { close = () => done(false); });
  return { active: true, ready, resolve, closed, close };
}

// ─── Provider ────────────────────────────

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressIndeterminate, setProgressIndeterminate] = useState(false);
  const [bytesPerSec, setBytesPerSec] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failureStage, setFailureStage] = useState<"check" | "download">("check");
  const [tryingBackup, setTryingBackup] = useState(false);
  const [installBlock, setInstallBlock] = useState<string | null>(null);
  const [installBlockTarget, setInstallBlockTarget] = useState<"db">();
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorToastAllowed, setErrorToastAllowed] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const appHidden = useAppHidden();
  const autoDownload = useUpdateDownloadPreference();
  const attemptedDownloads = useRef(new Set<string>());
  const promptedVersions = useRef(new Set<string>());
  const [preparing, setPreparing] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY);
    } catch {
      return null;
    }
  });
  const checkTask = useRef<OperationHandle | null>(null);
  const downloadTask = useRef<OperationHandle | null>(null);
  const installTask = useRef<OperationHandle | null>(null);
  const checkingRef = useRef(false);
  const downloadingRef = useRef(false);
  const updateRef = useRef(update);
  updateRef.current = update;
  const statusRef = useRef(status);
  statusRef.current = status;
  const installedRef = useRef(false);
  /** 重启重入防护（与 downloadingRef 同理：state 在同帧内是旧值，挡不住连点） */
  const restartingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uptodateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 标记当前这次检查是否为用户手动触发（区分自动/手动，决定是否弹「已是最新」框） */
  const manualCheckRef = useRef(false);
  /**
   * 本轮更新动作是否由用户主动发起（手动检查 / 点「下载安装」）。
   *
   * 与 `manualCheckRef` 分开：后者只服务「已是最新」弹框，下载不经过它。
   * 失败 toast 一律看这个 —— 自动检查失败只更新状态，不弹红条。
   */
  const userInitiatedRef = useRef(true);
  const [manualCheck, setManualCheck] = useState(false);
  // 子组件的 effect 可能先于 Provider effect 调用检查，握手必须在首次渲染就存在。
  const listenersRef = useRef<UpdateListeners | null>(null);
  if (!listenersRef.current) listenersRef.current = createUpdateListeners();

  // ─── 静默检查（不改变 UI 状态，仅内部记录）─────
  // 统一走后端 check_update 命令，状态由事件驱动（update:available / update:uptodate）。

  const silentCheck = useCallback(async () => {
    // 与 runCheck 同样挡 downloading：下载进行中并发检查，后端的 update:checking /
    // update:available 复查事件会被监听器的 downloadingRef 守卫吃掉，没有任何事件
    // 能把状态救回来（runCheck 处的同款注释）。静默检查只是"顺手问问"，不值得冒险。
    const listeners = listenersRef.current!;
    if (!listeners.active || checkingRef.current || downloadingRef.current || restartingRef.current || statusRef.current === "ready" || statusRef.current === "installing") return;
    checkingRef.current = true;
    setFailureStage("check");
    setTryingBackup(false);
    userInitiatedRef.current = false; // 这一轮失败不弹 toast
    let requested = false;
    try {
      const ready = await Promise.race([listeners.start?.() ?? listeners.ready, listeners.closed]);
      if (!listeners.active) return;
      if (!ready) throw new Error(listeners.error);
      requested = true;
      await invoke("check_update");
    } catch {
      if (listeners.active) checkingRef.current = false;
      // 静默检查失败不处理
    } finally {
      try {
        if (requested && listeners.active) localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
      } catch {
        // 存储不可用只影响「24 小时内不重复自动检查」的抑制，不值得打断更新流程
      }
    }
  }, []);

  // ─── 检查更新 ───────────────────────────
  // 统一走后端 check_update 命令；checking/available/uptodate/error 全部由后端事件驱动，
  // 前端不再各自维护一份检查逻辑（避免与 Rust 双真相源）。

  // ─── 检查更新（manual=false 自动/启动/定时；manual=true 用户主动点击）──
  // 自动检查只更新版本号区域状态、不弹「已是最新」提示框；手动检查命中 uptodate 才弹框。
  const runCheck = useCallback(async (manual: boolean) => {
    // 下载进行中不接受检查：状态会被打成 checking，而 start_update 内部复查发的
    // checking/available 事件又被监听器的 downloadingRef 守卫吃掉，没有任何事件
    // 能把状态救回来 → 徽章永远停在「检查中」。下载完成后可再查。
    const listeners = listenersRef.current!;
    if (!listeners.active || checkingRef.current || downloadingRef.current || restartingRef.current || statusRef.current === "ready" || statusRef.current === "installing") return;
    checkingRef.current = true;
    if (manual) checkTask.current = beginOperation({ key: "update.check", label: "检查软件更新", page: "settings", phase: "读取更新信息" });
    manualCheckRef.current = manual;
    userInitiatedRef.current = manual;
    setStatus("checking");
    setFailureStage("check");
    setTryingBackup(false);
    setError(null);
    setErrorCode(null);

    let requested = false;
    try {
      // 先占检查守卫再等待完整监听，防止连点与启动自检抢发；只等待注册，不能等待自检本身。
      const ready = await Promise.race([listeners.start?.() ?? listeners.ready, listeners.closed]);
      if (!listeners.active) return;
      if (!ready) throw new Error(listeners.error);
      requested = true;
      await invoke("check_update");
    } catch (e) {
      if (!listeners.active) return;
      checkingRef.current = false;
      manualCheckRef.current = false;
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Update] 检查更新失败:", msg);
      setError(msg);
      setErrorCode(null); // invoke 直接 reject 时没有 code，走字符串启发式
      // 只有用户主动点击才弹 toast；启动时「超过 24 小时」的那次自动检查也算自动。
      checkTask.current?.finish("failed", msg);
      checkTask.current = null;
      setErrorToastAllowed(manual);
      setStatus("error");
    } finally {
      try {
        if (requested && listeners.active) localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
      } catch {
        // 同 silentCheck：写不进只丢「24 小时抑制」，不影响检查本身
      }
    }
  }, []);
  const checkForUpdate = useCallback(() => runCheck(false), [runCheck]);
  const manualCheckForUpdate = useCallback(() => runCheck(true), [runCheck]);

  // ─── 定时检查（启动自检见下方监听 effect）──────────

  useEffect(() => {
    if (appHidden) return;
    // 定时检查不涉及竞态（首次触发在 CHECK_INTERVAL_MS 之后，监听器早已就绪），留在这里。
    // 启动自检已移到下方「监听后台更新事件」的 effect 里、await 完所有 listen 之后，
    // 原因见那里的注释。
    timerRef.current = setInterval(() => {
      checkForUpdate();
    }, CHECK_INTERVAL_MS);

    // cleanup 同时管两个定时器：24h 检查的 interval 在本 effect 里设，
    // 「已是最新」4 秒回 idle 的 timeout 在下方监听 effect 里设（存进 uptodateTimerRef）。
    // React 卸载时按声明**逆序**跑 cleanup——监听 effect 后声明先清，两个都归这里收尾，
    // 顺序无关紧要，缺任何一个都会在卸载后留下一次 setStatus（ React 会静默忽略，
    // 但 fake-timer 环境下会炸出 "not wrapped in act"）。
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (uptodateTimerRef.current) clearTimeout(uptodateTimerRef.current);
    };
  }, [appHidden, checkForUpdate]);

  // ─── 下载并安装（Rust 侧后台线程，不阻塞 UI）────

  // ─── 下载并安装（Rust 侧后台线程，不阻塞 UI）────
  // 重入防护：连点不会触发 start_update 并发双下载；调用即乐观置 downloading，
  // 由 update:ready / update:error 复位守卫。

  const startDownload = useCallback(async (automatic = false) => {
    if (!update || checkingRef.current || downloadingRef.current || restartingRef.current || statusRef.current === "ready" || statusRef.current === "installing") return;
    downloadingRef.current = true;
    downloadTask.current = beginOperation({ key: "update.download", label: "下载软件更新", page: "settings", phase: "检查更新包并开始下载" });
    installedRef.current = false;
    userInitiatedRef.current = !automatic; // 后台失败只显示状态，不打断工作。
    setStatus("downloading");
    setFailureStage("download");
    setTryingBackup(false);
    setProgress(0);
    setProgressIndeterminate(false);
    setDownloadedBytes(0);
    setTotalBytes(null);
    setBytesPerSec(0);
    setError(null);
    setErrorCode(null);
    try {
      await invoke("start_update");
    } catch (e) {
      downloadTask.current?.finish("failed", String(e));
      downloadTask.current = null;
      console.error("[Update] start_update invoke 失败:", e);
      setError(String(e));
      setErrorCode(null);
      setErrorToastAllowed(!automatic);
      setStatus("error");
      downloadingRef.current = false;
    }
  }, [update]);

  const downloadAndInstall = useCallback(() => startDownload(false), [startDownload]);

  useEffect(() => {
    const version = update?.version;
    // 每版本本次运行最多自动尝试一次；复查事件及失败后的重渲染不能触发下载循环。
    if (!autoDownload || status !== "available" || !version || dismissedVersion === version || attemptedDownloads.current.has(version)) return;
    attemptedDownloads.current.add(version);
    void startDownload(true);
  }, [autoDownload, status, update?.version, dismissedVersion, startDownload]);

  // ─── 监听后台更新事件 ────────────────────

  useEffect(() => {
    let cancelled = false;
    const listeners = listenersRef.current!.active ? listenersRef.current! : createUpdateListeners();
    listenersRef.current = listeners;
    const unlisteners: UnlistenFn[] = [];
    // async 注册期间若组件已卸载（StrictMode/快速重挂载，cleanup 会早于 await 完成），
    // 立即注销刚注册的监听，避免监听器泄漏与重复注册。
    const track = (fn: UnlistenFn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    };
    const register = async <T,>(event: string, handler: EventCallback<T>) => {
      if (cancelled) return () => {};
      return listen<T>(event, e => { if (!cancelled) handler(e); });
    };

    const setupListeners = async () => {
      track(
        await register("update:checking", () => {
          // 下载进行中（start_update 内部复查也会发 checking），不回退状态
          if (downloadingRef.current || statusRef.current === "ready" || statusRef.current === "installing") return;
          checkingRef.current = true;
          setStatus("checking");
          setError(null);
          setErrorCode(null);
        }),
      );
      track(
        await register<{ version: string; body: string | null; date?: string | null; currentVersion?: string }>("update:available", (e) => {
          // 下载进行中（start_update 内部复查会再发 available），保持 downloading 不被回退
          if (downloadingRef.current || statusRef.current === "ready" || statusRef.current === "installing") return;
          checkingRef.current = false;
          checkTask.current?.finish("success", `发现版本 ${e.payload.version}`);
          checkTask.current = null;
          setStatus("available");
          setUpdate({ version: e.payload.version, body: e.payload.body, date: e.payload.date, currentVersion: e.payload.currentVersion });
          if (manualCheckRef.current) setShowNotes(true);
          manualCheckRef.current = false;
        }),
      );
      track(
        await register("update:downloading", () => {
          checkingRef.current = false;
          downloadingRef.current = true;
          setStatus("downloading");
          setProgress(0);
          setProgressIndeterminate(false);
          setBytesPerSec(0);
          setDownloadedBytes(0);
          setTotalBytes(null);
        }),
      );
      track(
        await register<{ downloaded: number; total: number | null; bytesPerSec?: number }>("update:progress", (e) => {
          const { downloaded, total, bytesPerSec: bps } = e.payload;
          downloadTask.current?.update({ phase: "下载更新包", progress: { done: downloaded, total: total ?? undefined } });
          setDownloadedBytes(downloaded);
          // totalBytes 是顶栏读数算「已下载/总量」与「剩余时间」的唯一来源；
          // total 为 null（源未返回 Content-Length）时保持 null ⇒ 读数走不确定态。
          setTotalBytes(total);
          if (total) {
            setProgress(Math.round((downloaded / total) * 100));
            setProgressIndeterminate(false);
          } else {
            // total 未知（如某些源不返回 Content-Length）：无法计算百分比，标记不确定态
            setProgressIndeterminate(true);
          }
          setBytesPerSec(bps ?? 0);
        }),
      );
      track(await register("update:source", () => setTryingBackup(true)));
      track(
        await register<UpdateInfo | undefined>("update:ready", (event) => {
          checkingRef.current = false;
          setProgress(100);
          setProgressIndeterminate(false);
          downloadTask.current?.finish("success", "更新包已下载并验签，等待用户安装");
          downloadTask.current = null;
          setStatus("ready");
          if (event.payload?.version) setUpdate(event.payload);
          downloadingRef.current = false;
        }),
      );
      track(
        await register<{ message: string; code?: string }>("update:error", (e) => {
          checkingRef.current = false;
          const { message, code } = e.payload;
          checkTask.current?.finish("failed", message);
          downloadTask.current?.finish("failed", message);
          checkTask.current = downloadTask.current = null;
          console.error("[Update] 更新失败:", code ?? "unknown", message);
          setError(message);
          setErrorCode(code ?? null);
          // 自动检查（启动自检 / 24h 定时）失败只更新状态，不弹红 toast；
          // 用户主动发起的检查与下载失败仍然弹。
          setErrorToastAllowed(userInitiatedRef.current);
          // 复位手动标记：不清掉的话，下一次自动检查命中 uptodate 会误弹「已是最新」框。
          manualCheckRef.current = false;
          setStatus("error");
          downloadingRef.current = false;
        }),
      );
      track(
        await register("update:uptodate", () => {
          // 与 checking / available 同款守卫：下载进行中不回退状态。后端 check_update
          // 与 start_update 是两条独立命令（各自的单飞闸），前端调用侧虽已挡过一轮，
          // 这里作为双保险——状态被打回 uptodate 会让进度读数与徽章全部错乱。
          if (downloadingRef.current || statusRef.current === "ready" || statusRef.current === "installing") return;
          checkingRef.current = false;
          // 进入「已是最新」可见状态（版本号 pill 显示）；4 秒后自动回到 idle。
          // 仅手动检查才弹「已是最新」提示框（manualCheck），自动检查（启动/定时）不弹框。
          checkTask.current?.finish("success", "当前软件已是最新版本");
          checkTask.current = null;
          setStatus("uptodate");
          setUpdate(null);
          if (manualCheckRef.current) setManualCheck(true);
          manualCheckRef.current = false;
          if (uptodateTimerRef.current) clearTimeout(uptodateTimerRef.current);
          uptodateTimerRef.current = setTimeout(() => {
            setStatus((s) => (s === "uptodate" ? "idle" : s));
          }, 4000);
        }),
      );
    };

    // 启动自检必须等到**监听器全部注册完**才能发。
    //
    // 原来它在上方一个单独的 useEffect 里，而那个 effect 声明在本 effect 之前——
    // React 按声明顺序执行，于是「发起检查」早于「注册监听」。而 `listen()` 是异步的
    // （上面 7 个监听器每个都要一次 IPC 往返），而 Rust 侧 `check_update` 是 spawn 后
    // 很快就 emit。更新源响应够快时，`update:available` 会在监听注册完之前发出去、
    // **永久丢失** → 后端已经发现新版本，界面却显示「无更新」。
    //
    // 这是 CI 在真实 macOS 上抓到的：runner 到 GitHub 是同机房级延迟，启动后约 1 秒
    // 就拿到了新版本，稳定跑赢前端注册，于是重现了“有更新但不提示”。
    // 国内用户走 ghproxy/Gitee 通常慢，所以不易触发——但内网/快网下会命中。
    //
    // 仅交换两个 effect 的顺序不够：两边的 async 部分都在微任务队列里排队，
    // IPC 完成先后仍不保证。只有把它放在 `await` 完所有 listen 之后才真正无竞态。
    const doStartupCheck = async () => {
      // 读不到上次检查时间（隐私模式/存储被禁/配额满）不能中断启动自检链：
      // getItem 抛错会让这个 async 函数 reject，而调用方是 setupListeners().then(...)，
      // 异常被 then 链静默吞掉——表现是"永远不检查更新"。降级为"当作超过 24 小时"，
      // 最坏多查一次，好过永远不查。
      let lastCheck: string | null = null;
      try {
        lastCheck = localStorage.getItem(LAST_CHECK_KEY);
      } catch {
        lastCheck = null;
      }
      const now = Date.now();
      if (lastCheck && now - Number(lastCheck) < CHECK_INTERVAL_MS) {
        await silentCheck();
        return;
      }
      await checkForUpdate();
    };

    let registration: Promise<boolean> | null = null;
    listeners.start = () => {
      // 注册失败后清理半成品，下一次手动重试重新注册；同一轮等待者共享一次注册。
      if (!registration) registration = setupListeners().then(() => true, e => {
        unlisteners.splice(0).forEach(fn => fn());
        listeners.error = `更新事件监听初始化失败，请重试：${e instanceof Error ? e.message : String(e)}`;
        registration = null;
        return false;
      });
      return registration;
    };
    void listeners.start().then(ready => {
      listeners.resolve(ready);
      if (cancelled) return;
      if (ready) void doStartupCheck();
      else if (!checkingRef.current) {
        setError(listeners.error ?? null);
        setErrorCode(null);
        setErrorToastAllowed(false);
        setStatus("error");
      }
    });
    return () => {
      cancelled = true;
      listeners.active = false;
      // IPC 注册不能撤销，但调用者必须立即退出等待，旧结果也不能影响新生命周期。
      listeners.close();
      listeners.resolve(false);
      unlisteners.forEach((fn) => fn());
      checkTask.current?.finish("failed", "更新监听已关闭，结果尚未确认");
      downloadTask.current?.finish("failed", "更新监听已关闭，后台下载结果尚未确认");
      installTask.current?.finish("failed", "安装监听已关闭，最终版本需重启后确认");
      checkTask.current = downloadTask.current = installTask.current = null;
      checkingRef.current = false;
      manualCheckRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 重启应用（方案 C 2026-10-16：先播 1.1s 过渡层，再真正 relaunch）────

  const restart = useCallback(async () => {
    // 重入防护用 ref 而非 state：state 在同一次渲染里恒为旧值，双击 / 连按 Enter
    // 会在同一帧内拿到两次 `restarting === false` ⇒ 两次 relaunch（双杀进程）。
    // 本文件对下载用的是同一个套路（downloadingRef），保持一致。
    if (restartingRef.current || statusRef.current !== "ready") return;
    restartingRef.current = true;
    installTask.current = beginOperation({ key: "update.install", label: "请求安装并重启软件", page: "settings", phase: "检查未保存文件、事务与运行任务" });
    setPreparing(true);
    setInstallBlock(null);
    setInstallBlockTarget(undefined);
    setError(null);
    setShowNotes(false);
    // Windows 安装器本身就会关闭应用，保护必须放在 install_update 之前。
    try {
      if (!(await prepareRestart((message, target) => { setInstallBlock(message); setInstallBlockTarget(target); }))) {
        setInstallBlock(message => message ?? "安装已暂停，准备好后可继续安装。");
        installTask.current?.finish("cancelled", "用户取消了安装前检查");
        installTask.current = null;
        restartingRef.current = false;
        return;
      }
    } catch (e) {
      installTask.current?.finish("failed", String(e));
      installTask.current = null;
      console.error("[Update] 重启前检查失败:", e);
      restartingRef.current = false;
      setError(String(e));
      setShowNotes(true);
      return;
    } finally {
      setPreparing(false);
    }
    setShowNotes(true);
    installTask.current?.update({ phase: "请求应用更新包；最终版本在重启后确认" });
    setStatus("installing");
    setRestarting(true);
    const { currentVersion, version } = updateRef.current ?? {};
    if (currentVersion && version) recordUpdateResult({ from: currentVersion, to: version, status: "pending" });
    try {
      // 下载成功仅表示包已验签；安装失败仍可重试同一个包。
      if (!installedRef.current) {
        await invoke("install_update");
        installedRef.current = true;
      }
      // Windows 由安装器重启；其它平台在安装返回后重启当前进程。
      await new Promise((r) => setTimeout(r, RESTART_OVERLAY_MS));
      await relaunch();
    } catch (e) {
      // 🔴 必须复位。忘了这一步，过渡层会永久盖住界面、用户只能杀进程 ——
      // 那比现在「闪一下」更糟，也是本方案唯一需要专门验收的失败路径。
      installTask.current?.finish("failed", String(e));
      installTask.current = null;
      console.error("[Update] 重启失败:", e);
      if (currentVersion && version) recordUpdateResult({ from: currentVersion, to: version, status: "failed" });
      restartingRef.current = false;
      setRestarting(false);
      setStatus("ready");
      setError(String(e));
      // 保留就绪态与已验签包；安装或重启失败都不要求重新下载。
    }
  }, []);

  // 最小化期间保留就绪状态，用户回到窗口时再展示安装选择。
  useEffect(() => {
    const version = update?.version;
    if (appHidden || status !== "ready" || !version || promptedVersions.current.has(version)) return;
    promptedVersions.current.add(version);
    setShowNotes(true);
  }, [appHidden, status, update?.version]);

  // ─── 更新内容弹窗 ────────────────────────

  const openUpdateNotes = useCallback(() => {
    setShowNotes(true);
  }, []);
  const closeUpdateNotes = useCallback(() => {
    if (restartingRef.current) return;
    setShowNotes(false);
  }, []);

  const openInstallBlock = useCallback(() => {
    if (!installBlockTarget) return;
    setShowNotes(false);
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: installBlockTarget }));
  }, [installBlockTarget]);

  const retryUpdate = useCallback(async () => {
    if (statusRef.current !== "error") return;
    if (failureStage === "download" && update && errorCode !== "stale") await downloadAndInstall();
    else await manualCheckForUpdate();
  }, [update, failureStage, errorCode, downloadAndInstall, manualCheckForUpdate]);

  // ─── 明确忽略版本（换版本自动解除）────
  const dismissUpdate = useCallback(() => {
    const v = update?.version;
    if (!v) return;
    try {
      localStorage.setItem(DISMISSED_KEY, v);
    } catch {
      // 存储失败忽略
    }
    setDismissedVersion(v);
    setShowNotes(false);
  }, [update?.version]);

  const isDismissed = useCallback(
    (version?: string) => {
      if (!version) return false;
      return dismissedVersion === version;
    },
    [dismissedVersion],
  );

  /**
   * 「知道了」：标记手动检查的「已是最新」已读。
   *
   * 必须是稳定引用：`UpdateBadge` 里有一个 effect 拿它当依赖，以前它是内联箭头，
   * 每次 provider 渲染（下载期间 250ms 一次）都换身份 → effect 跟着重跑一遍。
   */
  const acknowledgeUptodate = useCallback(() => setManualCheck(false), []);

  /**
   * value 用 `useMemo` 包住：provider 挂在 `main.tsx` 最外层，父级任何渲染都会
   * 重建 value 对象，四个消费方（徽章 / 收起态圆点 / 首页 / 进度读数）就得跟着
   * 全量重渲染，即便它们关心的字段一个没变。
   */
  const value = useMemo(
    () => ({
      status, update, progress, progressIndeterminate, bytesPerSec, downloadedBytes, totalBytes,
      restarting, preparing, notesOpen: showNotes, error, errorCode, errorToastAllowed, failureStage, tryingBackup, installBlock,
      openInstallBlock: installBlockTarget ? openInstallBlock : undefined,
      checkForUpdate, manualCheckForUpdate, downloadAndInstall, restart, openUpdateNotes,
      closeUpdateNotes, retryUpdate, dismissUpdate, isDismissed, manualCheck, acknowledgeUptodate,
    }),
    [
      status, update, progress, progressIndeterminate, bytesPerSec, downloadedBytes, totalBytes,
      restarting, preparing, showNotes, error, errorCode, errorToastAllowed, failureStage, tryingBackup, installBlock, installBlockTarget, openInstallBlock,
      checkForUpdate, manualCheckForUpdate, downloadAndInstall, restart, openUpdateNotes,
      closeUpdateNotes, retryUpdate, dismissUpdate, isDismissed, manualCheck, acknowledgeUptodate,
    ],
  );

  return (
    <UpdateContext.Provider value={value}>
      {children}
      {restarting && <RestartOverlay current={update?.currentVersion} next={update?.version} />}
      <UpdateNotesDialog open={showNotes} update={update} process={value} onClose={closeUpdateNotes} onDownload={downloadAndInstall} onDismiss={dismissUpdate} onRestart={restart} onRetry={retryUpdate} />
    </UpdateContext.Provider>
  );
}
