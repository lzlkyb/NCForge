import { invoke } from "./tauri";

/**
 * 前端错误落盘（UTF-8，与 GBK 的 NC 日志分开存）。
 *
 * 🔴 为什么需要：`ErrorBoundary.componentDidCatch` 以前只 `console.error`，
 * 用户点一次「重新加载」现场就没了；操作中心也不持久化，重启即丢。
 * 结果是「用户说刚才报错了」而我们拿不到任何堆栈，只能靠他记得点「复制错误信息」。
 *
 * 🔴 三条硬约束（改这个文件前先读）：
 * 1. **绝不抛错、绝不 toast**：调用点本身就在崩溃路径上，再弹提示或抛异常会
 *    雪上加霜，甚至触发新的 error 事件形成递归。所以不用 `invokeOrToast`。
 * 2. **去重 + 节流**：React 渲染失败会在重试时反复触发同一条；爆栈的 stack 能到几 MB。
 *    同一条 5 秒内只记一次，单次会话最多记 `MAX_PER_SESSION` 条，避免刷爆磁盘。
 * 3. **不阻塞**：fire-and-forget，不 await 给调用方。
 */

/** 同一条错误的去重窗口。渲染失败重试会连发，5s 足够压掉重复又不丢真问题。 */
const DEDUPE_MS = 5000;

/** 单次会话上限：真出现「每帧都崩」时不能把磁盘写满。 */
const MAX_PER_SESSION = 200;

const seen = new Map<string, number>();
let written = 0;

export type FrontendErrorKind = "render" | "window.onerror" | "unhandledrejection";

/** 把任意抛出物转成可读消息。Tauri 拒绝的是**字符串**，不是 Error。 */
export function describeError(e: unknown): { message: string; stack?: string } {
  if (e instanceof Error) return { message: e.message || e.name, stack: e.stack };
  if (typeof e === "string") return { message: e };
  if (e && typeof e === "object") {
    const obj = e as { message?: unknown; stack?: unknown };
    if (typeof obj.message === "string") {
      return { message: obj.message, stack: typeof obj.stack === "string" ? obj.stack : undefined };
    }
    try { return { message: JSON.stringify(e) }; } catch { /* 循环引用 */ }
  }
  return { message: String(e) };
}

/** 去重键：来源 + 消息 + 堆栈首行。整条堆栈太长，首行足以区分不同故障点。 */
export function dedupeKey(kind: string, message: string, stack?: string): string {
  const head = (stack ?? "").split("\n").find(line => line.trim().length > 0) ?? "";
  return `${kind}|${message}|${head.trim()}`;
}

/** 是否该记录（纯判据，便于脱环境单测）。 */
export function shouldRecord(key: string, now: number, count: number): boolean {
  if (count >= MAX_PER_SESSION) return false;
  const last = seen.get(key);
  return last === undefined || now - last >= DEDUPE_MS;
}

/**
 * 记一条前端错误。**永不抛错**，失败只落 console（此时已经在崩溃路径上）。
 * `page` 传当前页面 id，便于定位是哪个工作面崩的。
 */
export function recordFrontendError(
  kind: FrontendErrorKind,
  error: unknown,
  page?: string,
): void {
  try {
    const { message, stack } = describeError(error);
    const key = dedupeKey(kind, message, stack);
    const now = Date.now();
    if (!shouldRecord(key, now, written)) return;
    seen.set(key, now);
    written += 1;
    // 去重表本身也要有界：只留最近 100 个键，长会话不无限增长
    if (seen.size > 100) {
      for (const [k, at] of seen) {
        if (now - at >= DEDUPE_MS) seen.delete(k);
      }
    }
    void invoke("frontend_log_append", { kind, message, stack, page }).catch(() => undefined);
  } catch {
    // 连组装都失败就彻底放弃：日志不能成为新的故障源
  }
}

/** 仅供测试：重置去重与计数状态。 */
export function resetFrontendLogForTest(): void {
  seen.clear();
  written = 0;
}

/**
 * 挂全局兜底：渲染之外的异常（事件回调、异步 rejection）ErrorBoundary 抓不到。
 * 返回卸载函数。**只装一次**，重复调用不会叠加监听。
 */
let installed: (() => void) | undefined;
export function installGlobalErrorLogging(getPage?: () => string | undefined): () => void {
  if (installed) return installed;
  const onError = (event: ErrorEvent) => {
    recordFrontendError("window.onerror", event.error ?? event.message, getPage?.());
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    recordFrontendError("unhandledrejection", event.reason, getPage?.());
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  installed = () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    installed = undefined;
  };
  return installed;
}