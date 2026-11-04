/**
 * 保存后自动编译的**队列**：模块级、防抖、串行。
 *
 * 为什么不是每次保存直接调一次 IPC：
 * - 连着按 Ctrl+S、或批量保存多个文件时，一次保存一个 JVM 太浪费（每次启动 ~1 s）；
 * - 后一次在前一次还没跑完时发出去，后端编译闸会把它当「已有编译在进行」跳过，
 *   那次保存就白保存了（用户以为编过，实际没编）。
 *
 * 所以：攒 700 ms（顺带等文件系统把 mtime 落稳）→ 一次性把这一批交给 runner；
 * 一批没跑完时新来的继续攒，等当前结束后再跑下一批。**一批只发一次 IPC**，
 * 后端按模块分组、每组一轮 JVM（见 `commands::compile_file`）。
 *
 * runner 由 `useModuleCompile` 在挂载时注册：没有消费者时入队直接返回 false，
 * 不排队——否则从没挂载过文件页的会话会攒一堆永远不会执行的路径。
 */

type Runner = (paths: string[]) => Promise<void>;

/** 保存到编译之间的间隔。太短会在慢盘上读到「刚写完还没落稳」的文件。 */
export const AUTO_COMPILE_DEBOUNCE_MS = 700;
/**
 * 被「已有编译在跑」挡回来后的重试间隔。
 *
 * 手动整模块编译可能跑三十秒，这期间的保存不能就此丢掉：等它结束再编一次，
 * 否则产物停在改之前的版本，界面还显示「编译成功」。
 */
export const AUTO_COMPILE_RETRY_MS = 1_500;
/** 重试上限。够盖住一次整模块编译（30 秒 ≈ 20 次）；再多说明不是「暂时忙」。 */
export const AUTO_COMPILE_MAX_RETRIES = 40;

let runner: Runner | null = null;
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
/** 连续被挡回来的次数。真正入队新的保存时清零，避免偶尔一次忙碌用掉整个预算。 */
let retries = 0;

function schedule(delay = AUTO_COMPILE_DEBOUNCE_MS) {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, delay);
}

async function flush() {
  const run = runner;
  const paths = [...pending];
  pending.clear();
  if (!run || paths.length === 0) return;
  if (running) {
    // 上一批还没跑完（首次会先建类索引，可能几十秒）：放回去，等 finally 再排
    for (const p of paths) pending.add(p);
    return;
  }
  running = true;
  try {
    await run(paths);
  } catch (e) {
    // runner 内部已按错误类型提示过；这里只保证队列不会因为一次异常卡死
    console.warn("[auto-compile] 这一批失败：", e);
  } finally {
    running = false;
    if (pending.size > 0) schedule();
  }
}

/** 注册 / 注销执行者。注销（`null`）时清掉待跑队列与定时器。 */
export function setAutoCompileRunner(fn: Runner | null) {
  runner = fn;
  if (fn) return;
  pending.clear();
  retries = 0;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * 保存成功后把路径丢进来。返回 `false` = 没有消费者，这次不会编（调用方据此
 * 决定要不要弹「已保存」——马上会有编译结果回来时，弹两条 toast 是噪音）。
 *
 * 同一个文件在一次防抖窗口里只编一次（Set 去重）。
 */
export function queueAutoCompile(path: string): boolean {
  if (!runner) return false;
  retries = 0;
  pending.add(path);
  schedule();
  return true;
}

/**
 * 被「已有编译在跑」挡回来：把这批放回队列，稍后再试。
 *
 * 超过上限就放弃——一直重排会让「保存」在后台无限发 IPC，而真正的原因
 * （比如编译卡死）反而被这层重试盖住。
 */
export function requeueAutoCompile(paths: readonly string[]): void {
  if (!runner || paths.length === 0) return;
  if (retries >= AUTO_COMPILE_MAX_RETRIES) {
    // 不重置计数：重置会让「放弃」变成每 40 次一轮的无限循环。用户下次真的
    // 保存文件时 `queueAutoCompile` 会把它清零，那才是重试预算的新起点。
    console.warn("[auto-compile] 重试次数用尽，这批改动没有自动编译：", paths);
    return;
  }
  retries += 1;
  for (const p of paths) pending.add(p);
  schedule(AUTO_COMPILE_RETRY_MS);
}

/** 测试用：清掉队列、定时器与在跑标记（不动已注册的 runner）。 */
export function resetAutoCompileQueue() {
  pending.clear();
  running = false;
  retries = 0;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
