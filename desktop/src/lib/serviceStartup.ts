import { beginOperation, type OperationHandle } from "./operations";
import { isAppHidden } from "./appVisibility";
import type { StopOutcome } from "./server";

type Target = "server" | "client";
interface Snapshot { state: "stopped" | "starting" | "running"; runId?: string | null; reason: string | null; launchPhase?: string | null; port?: number }
interface Startup { id: string; stopping: boolean; requestDone: boolean; task: OperationHandle }
const active = new Map<Target, Startup>();
interface StartOptions {
  target: Target; debug: boolean; requestId?: string;
  request: (id: string) => Promise<string>; status: () => Promise<Snapshot>;
  stop: (id: string) => Promise<StopOutcome>;
}
export function markServiceStopping(target: Target, expectedId?: string, outcome?: StopOutcome): void {
  const startup = active.get(target);
  if (!startup || (expectedId && startup.id !== expectedId)) return;
  startup.stopping = true;
  if (outcome === "stopped" || outcome === "idle") startup.task.finish("cancelled", "本次启动已停止");
}
/** Per-request identity prevents a late watcher/cancellation from touching an independent newer JVM. */
export async function startServiceOperation(options: StartOptions): Promise<string> {
  const { target } = options;
  const id = options.requestId ?? crypto.randomUUID();
  let stopping = false;
  const task = beginOperation({ key: target === "server" ? "service.start" : "client.start", label: `${options.debug ? "调试启动" : "启动"}${target === "server" ? "中间件" : "客户端"}`, scope: target === "server" ? "NC 中间件" : "NC 客户端", page: "files", panel: "svc", phase: "检查环境", cancel: async () => {
    stopping = true; markServiceStopping(target, id);
    try { await options.stop(id); }
    catch (error) {
      stopping = false;
      const current = active.get(target); if (current?.id === id) current.stopping = false;
      throw error;
    }
  } });
  if (!task) throw new Error("此服务正在启动，请等待完成或取消");
  const startup = { id, stopping, requestDone: false, task }; active.set(target, startup);
  try {
    const request = options.request(id);
    void observePreparation(options, startup).catch(() => {});
    const actualId = await request;
    startup.requestDone = true;
    // Older fixtures may omit the return identity; live commands always return the reserved ID.
    startup.id = actualId || id;
    if (startup.stopping) await options.stop(startup.id);
    task.update({ phase: target === "server" ? "等待监听端口" : "等待客户端进程" });
    void watch(options, startup).catch(error => task.finish("failed", `无法确认启动结果：${String(error)}，请重新读取服务状态`));
    return startup.id;
  } catch (error) {
    startup.requestDone = true;
    task.finish(startup.stopping || String(error).includes("CANCELLED:") ? "cancelled" : "failed", String(error));
    if (active.get(target) === startup) active.delete(target);
    throw error;
  }
}
async function observePreparation(options: StartOptions, startup: Startup): Promise<void> {
  let polls = 0; const start = Date.now();
  while (!startup.requestDone && active.get(options.target) === startup && polls < 1800 && Date.now() - start < 24 * 60 * 60 * 1000) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (startup.requestDone || active.get(options.target) !== startup) return;
    if (isAppHidden()) continue;
    polls++;
    const status = await options.status();
    // A queued start may still see the previous stopped run. Only its own identity supplies phases.
    if (!startup.requestDone && active.get(options.target) === startup && status.runId === startup.id) {
      startup.task.update({ phase: startup.stopping ? "等待取消启动完成" : status.launchPhase || "准备启动" });
    }
  }
}
async function watch(options: StartOptions, startup: Startup): Promise<void> {
  const start = Date.now(); let polls = 0;
  try {
    // Only visible checks count against 30 minutes. Hidden windows perform no status IPC.
    while (polls < 1800 && Date.now() - start < 24 * 60 * 60 * 1000) {
      if (active.get(options.target) !== startup) { startup.task.finish("cancelled", "已切换到另一次启动"); return; }
      if (!isAppHidden()) {
        polls++;
        const status = await options.status();
        if (status.runId && status.runId !== startup.id) { startup.task.finish("cancelled", "本次运行已被替换"); return; }
        if (status.state === "running" && !startup.stopping) { startup.task.finish("success", options.target === "server" ? `本进程已监听端口 ${status.port}` : "客户端 JVM 已启动，登录与业务健康未验证"); return; }
        if (status.state === "stopped") { startup.task.finish(startup.stopping ? "cancelled" : "failed", status.reason || "服务在就绪前已退出，请检查本次日志"); return; }
        startup.task.update({ phase: startup.stopping ? "等待取消启动完成" : status.launchPhase || "等待服务就绪" });
      }
      // Each iteration yields; the two explicit time/count limits prevent a stuck lifetime watcher.
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    startup.task.finish("failed", "启动状态观察超时，请读取当前服务状态；进程不会被自动停止");
  } finally { if (active.get(options.target) === startup) active.delete(options.target); }
}
