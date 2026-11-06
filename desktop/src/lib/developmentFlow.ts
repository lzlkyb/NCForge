export type DevelopmentTarget = "middleware" | "client";
export interface DevelopmentOptions {
  compile: boolean;
  deploy: boolean;
  client: boolean;
  debug: boolean;
  autoAttach: boolean;
}
export const DEFAULT_DEVELOPMENT_OPTIONS: DevelopmentOptions = {
  compile: false, deploy: true, client: true, debug: false, autoAttach: false,
};
export interface DevelopmentService {
  state: "stopped" | "starting" | "running";
  runId?: string | null;
  projectRoot?: string | null;
  launchPhase?: string | null;
  reason?: string | null;
  exitCode?: number | null;
  debugPort?: number | null;
  serverReachable?: boolean;
  host?: string;
  port?: number;
  portConflict?: boolean;
}
export interface DevelopmentRuntime {
  root: string;
  currentRoot: () => string | null | undefined;
  status: (target: DevelopmentTarget) => Promise<DevelopmentService>;
  compile: () => Promise<boolean>;
  cancelCompile: () => Promise<unknown>;
  deploy: () => Promise<unknown>;
  start: (target: DevelopmentTarget, debug: boolean, requestId: string) => Promise<string>;
  stop: (target: DevelopmentTarget, expectedRunId: string) => Promise<unknown>;
  attach: (target: DevelopmentTarget) => Promise<unknown>;
  requestId: () => string;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  waitMs?: number;
}
export interface DevelopmentResult { started: DevelopmentTarget[]; reused: DevelopmentTarget[]; }
export interface DevelopmentExecution {
  done: Promise<DevelopmentResult>;
  cancel: (reason?: string) => Promise<void>;
}
export const sameDevelopmentRoot = (a: string | null | undefined, b: string) =>
  typeof a === "string" && a.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
export const isDevelopmentCancelled = (error: unknown) =>
  error instanceof Error && (error.name === "AbortError" || error.message.startsWith("CANCELLED:"));
const label = (target: DevelopmentTarget) => target === "middleware" ? "中间件" : "客户端";
type OwnedStep = { kind: "compile" } | { kind: "start"; target: DevelopmentTarget; runId: string } | null;
function cancellation(reason: string): Error { const e = new Error(reason); e.name = "AbortError"; return e; }
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancellation(String(signal.reason))); return; }
    const abort = () => { clearTimeout(timer); reject(cancellation(String(signal.reason))); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** 有界串行流程；取消只针对本流程认领的准备/启动，不接管原有进程。 */
export function executeDevelopmentFlow(
  options: DevelopmentOptions,
  rt: DevelopmentRuntime,
  onPhase: (phase: string) => void,
  onChanged: () => void = () => {},
): DevelopmentExecution {
  const controller = new AbortController(), signal = controller.signal;
  const now = rt.now ?? Date.now, sleep = rt.sleep ?? pause;
  const timeout = rt.waitMs ?? 10 * 60 * 1000;
  let active: OwnedStep = null;
  let cancelWork: Promise<void> | null = null;
  let cancelFailed = false;
  let cancellationOwner: OwnedStep = null;
  let finished = false;
  const started: DevelopmentTarget[] = [], reused: DevelopmentTarget[] = [];
  const expectedRuns = new Map<DevelopmentTarget, string>();
  const cancel = (reason = "已取消开发流程，后续步骤未执行"): Promise<void> => {
    if (finished) return Promise.resolve();
    if (signal.aborted && !cancelFailed) return cancelWork ?? Promise.resolve();
    if (!signal.aborted) { controller.abort(reason); cancellationOwner = active; }
    const owned = cancellationOwner;
    cancelFailed = false;
    cancelWork = Promise.resolve().then(async () => {
      if (owned?.kind === "compile") await rt.cancelCompile();
      if (owned?.kind === "start") await rt.stop(owned.target, owned.runId);
    }).catch((error) => { cancelFailed = true; throw error; });
    // 订阅取消可能不等待 Promise；失败仍在 done 的 finally 中向调用方传播。
    void cancelWork.catch(() => {});
    return cancelWork;
  };
  const guard = () => {
    if (!sameDevelopmentRoot(rt.currentRoot(), rt.root)) void cancel("工程已切换，旧工程的后续步骤未执行");
    if (signal.aborted) throw cancellation(String(signal.reason));
  };
  const read = async (target: DevelopmentTarget) => { guard(); const s = await rt.status(target); guard(); return s; };
  const checkIdentity = (target: DevelopmentTarget, s: DevelopmentService) => {
    const expected = expectedRuns.get(target);
    if (expected && s.runId && expected !== s.runId) throw new Error(`${label(target)}运行已被其他操作替换，后续步骤未执行`);
  };
  const validateReuse = (target: DevelopmentTarget, s: DevelopmentService) => {
    if (s.portConflict) throw new Error("中间件监听端口被其他进程占用，请先检查端口");
    if (s.state === "starting") throw new Error(`${label(target)}已有启动操作，等待完成后再开始开发`);
    if (s.state !== "running") return;
    if (s.projectRoot && !sameDevelopmentRoot(s.projectRoot, rt.root)) throw new Error(`${label(target)}属于另一工作区，请先停止后再启动当前工程`);
    if (options.autoAttach && !s.debugPort) throw new Error(`运行中的${label(target)}未开启调试，请先停止并选择调试启动`);
  };
  const waitReady = async (target: DevelopmentTarget, runId: string) => {
    const start = now();
    for (;;) {
      const s = await read(target);
      if (s.runId && s.runId !== runId) throw new Error(`${label(target)}的启动已被其他操作替换，后续步骤未执行`);
      if (s.state === "running") return;
      if (s.state === "stopped") throw new Error(s.reason || `${label(target)}在启动完成前退出${s.exitCode !== null && s.exitCode !== undefined ? `，退出码 ${s.exitCode}` : ""}`);
      if (now() - start >= timeout) throw new Error(`等待${label(target)}启动超过 10 分钟，请检查日志后重试；已运行服务保留`);
      onPhase(s.launchPhase || `等待${label(target)}${target === "middleware" ? "监听端口" : "进程启动"}`);
      // 每轮一次状态读取、至多每秒一次；取消会打断等待，结束后不再轮询。
      await sleep(1000, signal);
    }
  };
  const ensureStarted = async (target: DevelopmentTarget) => {
    const s = await read(target); validateReuse(target, s);
    if (s.state === "running") { if (s.runId) expectedRuns.set(target, s.runId); reused.push(target); onPhase(`复用运行中的${label(target)}`); return; }
    const requestId = rt.requestId();
    active = { kind: "start", target, runId: requestId };
    onPhase(`准备启动${label(target)}`);
    // 身份在发送请求前认领，准备阶段取消也不会误停另一请求的 JVM。
    const runId = await rt.start(target, options.debug, requestId);
    guard(); active = { kind: "start", target, runId };
    onChanged(); await waitReady(target, runId); guard();
    expectedRuns.set(target, runId); started.push(target); active = null; onChanged();
  };
  const execute = async (): Promise<DevelopmentResult> => {
    try {
      guard(); onPhase("检查服务与当前工作区");
      const server = await read("middleware"); validateReuse("middleware", server);
      if (options.client) validateReuse("client", await read("client"));
      if (options.compile) {
        onPhase("编译工程"); active = { kind: "compile" };
        const ok = await rt.compile(); guard(); active = null;
        if (!ok) throw new Error("编译未通过，元数据投送与服务启动未执行");
      }
      if (options.deploy) { onPhase("投送元数据"); await rt.deploy(); guard(); onChanged(); }
      await ensureStarted("middleware"); guard();
      if (options.client) {
        const start = now();
        for (;;) {
          const server = await read("middleware"), client = await read("client");
          checkIdentity("middleware", server);
          if (server.state !== "running") throw new Error("中间件已停止，客户端启动未执行");
          if (client.serverReachable) break;
          if (now() - start >= timeout) throw new Error(`客户端连接目标 ${client.host ?? "未知地址"}:${client.port ?? "?"} 尚未可达，请检查配置和日志；客户端启动未执行`);
          onPhase(`等待客户端连接目标 ${client.host ?? "未知地址"}:${client.port ?? "?"} 可达`);
          await sleep(1000, signal);
        }
        await ensureStarted("client"); guard();
      }
      if (options.autoAttach) {
        for (const target of options.client ? ["middleware", "client"] as const : ["middleware"] as const) {
          const s = await read(target);
          checkIdentity(target, s);
          if (!s.debugPort) throw new Error(`${label(target)}未开启 JDWP，无法自动附加调试`);
          onPhase(`附加${label(target)}调试器`); await rt.attach(target); guard();
        }
      }
      return { started, reused };
    } finally {
      try { await cancelWork; } finally { finished = true; active = null; }
    }
  };
  return { done: execute(), cancel };
}
