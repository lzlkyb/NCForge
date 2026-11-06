import { toast } from "../components/ui/toast";
import { beginOperation, operationActive, type OperationHandle } from "./operations";
import { isNcTaskRunning } from "./ncTasks";
import { getSession, subscribe } from "./workspaceSession";
import { createSessionStore } from "./sessionStore";
import { developmentRuntime } from "./developmentFlowRuntime";
import { executeDevelopmentFlow, isDevelopmentCancelled, sameDevelopmentRoot, type DevelopmentExecution, type DevelopmentOptions } from "./developmentFlow";

export interface DevelopmentSnapshot {
  state: "idle" | "running" | "cancelling" | "success" | "failed" | "cancelled";
  root: string | null;
  phase: string;
  detail: string;
  startedAt: number | null;
  operationId: number | null;
  prefsVersion: number;
}
export const developmentFlowStore = createSessionStore<DevelopmentSnapshot>({
  state: "idle", root: null, phase: "", detail: "", startedAt: null, operationId: null, prefsVersion: 0,
});
const changedListeners = new Set<() => void>();
export const subscribeDevelopmentChanged = (listener: () => void) => { changedListeners.add(listener); return () => { changedListeners.delete(listener); }; };
const notifyChanged = () => changedListeners.forEach((listener) => listener());
let flight: { execution: DevelopmentExecution; operation: OperationHandle } | null = null;
export const isDevelopmentFlowRunning = () => flight !== null;
export const developmentControlsBusy = () => getSession().compiling || isNcTaskRunning() || ["service.start", "service.stop", "client.start", "client.stop", "service.kill"].some(operationActive);
export async function cancelDevelopmentFlow(reason?: string): Promise<void> {
  if (!flight) return;
  const owned = flight;
  developmentFlowStore.set({ state: "cancelling", phase: reason ?? "正在取消，等待当前步骤收尾" });
  try { await owned.execution.cancel(reason); }
  catch (error) {
    if (flight === owned) developmentFlowStore.set({ state: "running", phase: "取消请求失败，可重试或等待当前步骤结束", detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
export function dismissDevelopmentResult(): void {
  if (!flight) developmentFlowStore.set({ state: "idle", phase: "", detail: "", operationId: null });
}
export async function runDevelopmentFlow(options: DevelopmentOptions, compileAll?: () => Promise<boolean>): Promise<void> {
  const root = getSession().root;
  if (!root) { toast("先打开工程再开始开发", "warning"); return; }
  if (flight || developmentControlsBusy()) { toast("已有编译、服务操作或开发流程在运行，请等待完成", "info"); return; }
  const operation = beginOperation({ key: "nc.development", label: "开始开发", scope: root, root, page: "files", panel: "svc", phase: "检查环境", cancel: () => cancelDevelopmentFlow() });
  if (!operation) return;
  developmentFlowStore.set({ state: "running", root, phase: "检查环境", detail: "", startedAt: Date.now(), operationId: operation.id });
  const execution = executeDevelopmentFlow(options, developmentRuntime(root, compileAll), (phase) => {
    if (developmentFlowStore.get().state === "running") developmentFlowStore.set({ phase });
    operation.update({ phase });
  }, () => { if (sameDevelopmentRoot(getSession().root, root)) notifyChanged(); });
  flight = { execution, operation };
  // 执行活在会话中：切换底部标签不会取消编译；切工作区则立即阻止后续启动。
  let rootCancellationSent = false;
  const off = subscribe(() => {
    if (!rootCancellationSent && !sameDevelopmentRoot(getSession().root, root)) {
      rootCancellationSent = true;
      void cancelDevelopmentFlow("工程已切换，旧工程的后续步骤未执行").catch(() => {});
    }
  });
  try {
    const result = await execution.done;
    const name = (target: string) => target === "middleware" ? "中间件" : "客户端";
    const detail = [result.started.length ? `已启动${result.started.map(name).join("、")}` : "", result.reused.length ? `已复用${result.reused.map(name).join("、")}` : "", options.autoAttach ? "调试器已附加" : "", "业务健康尚未验证"].filter(Boolean).join("；");
    operation.finish("success", detail);
    developmentFlowStore.set({ state: "success", phase: "开发流程已完成", detail });
    if (sameDevelopmentRoot(getSession().root, root)) toast(detail, "success");
  } catch (error) {
    const cancelled = isDevelopmentCancelled(error), message = error instanceof Error ? error.message : String(error);
    const detail = `${message}${cancelled ? "；原有运行服务保留" : "；后续步骤未执行，已运行服务保留"}`;
    operation.finish(cancelled ? "cancelled" : "failed", detail);
    developmentFlowStore.set({ state: cancelled ? "cancelled" : "failed", phase: cancelled ? "开发流程已取消" : "开发流程未完成", detail });
    if (sameDevelopmentRoot(getSession().root, root)) toast(detail, cancelled ? "info" : "error");
  } finally {
    off(); flight = null;
    if (sameDevelopmentRoot(getSession().root, root)) notifyChanged();
  }
}
