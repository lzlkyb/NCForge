/**
 * 两阶段自动构建的第二阶段：单文件编译空闲后，再跑一次**模块级增量**。
 *
 * 为什么需要第二阶段：单文件 ecj 只能发现这个文件自己的语法 / 缺失符号，
 * 发现不了「我把方法签名改了，引用方还在用旧签名」——那类错误要编引用方才会出现。
 * 第一阶段给 1 秒级反馈，第二阶段补上反向依赖，两件事的延迟和代价不同，
 * 不能合成一次（编整模块几十秒，每次保存都等它等于没有即时反馈）。
 *
 * 这里刻意**不**清日志、不切面板：自动构建的任何副作用都会变成骚扰。
 */
import { getSession, setSession } from "./workspaceSession";
import { captureCompileSources, stampCompileResult } from "./compileFreshness";
import { compileIncremental, isCompileCancelled } from "./compile";
import { isAutoIncrementalEnabled } from "./appConfig";
import { mergeModuleResult } from "./autoCompile";

/** 单文件编译结束后的静默期：连续保存时只跑最后一次增量。 */
export const INCREMENTAL_IDLE_MS = 2_500;
/** 手动编译占着闸时的重试间隔。 */
const BUSY_RETRY_MS = 7_000;
const MAX_PENDING = 64;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let requeueOnBusy = false;
const pending = new Set<string>();

function schedule(delay = INCREMENTAL_IDLE_MS): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, delay);
}

/**
 * 第一阶段（或外部改动）编译成功后调用。重复路径在一次静默窗口里只编一次。
 */
export function scheduleIncremental(paths: readonly string[]): void {
  for (const p of paths) {
    if (pending.size >= MAX_PENDING) break;
    pending.add(p);
  }
  if (pending.size > 0) schedule();
}

async function flush(): Promise<void> {
  if (running) {
    if (pending.size > 0) schedule();
    return;
  }
  if (pending.size === 0) return;
  if (!(await isAutoIncrementalEnabled())) {
    pending.clear();
    return;
  }
  // 手动编译在跑：先不要抢闸，等它结束。用户此刻看到的是「编译中」，
  // 再起一轮增量只会被后端挡回来。
  if (getSession().compiling) {
    requeueOnBusy = true;
    schedule(BUSY_RETRY_MS);
    return;
  }
  const root = getSession().root ?? null;
  if (!root) {
    pending.clear();
    return;
  }
  const paths = [...pending];
  const sourceVersions = captureCompileSources(getSession().tabs);
  pending.clear();
  running = true;
  setSession({ compiling: true });
  try {
    const result = stampCompileResult(await compileIncremental(paths), sourceVersions, root);
    if ((getSession().root ?? null) !== root) return;
    // 用 updater 拿最新值：这期间手动编译可能刚写完结果
    setSession({ compileResult: (prev) => mergeModuleResult(prev, result, root) });
  } catch (e) {
    if ((getSession().root ?? null) !== root) return;
    const msg = String(e instanceof Error ? e.message : e);
    // 闸被占（手动编译刚好在这一次检查之后启动）：放回去稍后再试
    if (msg.includes("已有一次编译")) {
      for (const p of paths) pending.add(p);
      requeueOnBusy = true;
      schedule(BUSY_RETRY_MS);
    } else if (!isCompileCancelled(e)) {
      // 增量失败不弹红 toast：保存流程已经给了单文件结果，这里只是补引用方。
      // 日志里有后端写的原因，问题面板也会显示错误。
      console.warn("[auto-compile] 模块增量失败：", e);
    }
  } finally {
    running = false;
    // 只有我们自己置的「编译中」才清；跑的时候没有别人能拿到编译闸
    setSession({ compiling: false });
    if (pending.size > 0) schedule();
    else requeueOnBusy = false;
  }
}

/** 测试用：清队列与定时器。 */
export function resetIncremental(): void {
  pending.clear();
  running = false;
  requeueOnBusy = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** 是否有排队中的增量（状态栏 / 测试用）。 */
export const incrementalPending = () => requeueOnBusy || pending.size > 0 || running;
