import { useSyncExternalStore } from "react";
import { invoke, listen } from "./tauri";
import { registerCommands } from "./commandRegistry";
import { attachDebugger, getDebugSnapshot } from "./debugSession";
import { getSession } from "./workspaceSession";
import { workspaceEpoch } from "./workspaceEpoch";
import { toast } from "../components/ui/toast";
import { emptyJavaRunConfig, failedRunTargets, inputLines, sourceRunTarget, type JavaRunConfig } from "./javaRunConfig";
import { beginJavaRun, cancelJavaRunAndWait } from "./javaRunLifecycle";

export interface JavaTestResult { target: string; count: number; failures: number; ignored: number; }
export interface JavaTestFailure { className: string; method: string; trace: string; }
export interface JavaRunResult { id: string; ok: boolean; cancelled: boolean; exitCode: number | null; durationMs: number; tests: JavaTestResult[]; failures: JavaTestFailure[]; report: string | null; resultsTruncated: boolean; }
interface RunSnapshot { running: boolean; id: string | null; root: string; config: JavaRunConfig; log: string[]; error: string; result: JavaRunResult | null; pid: number | null; }
let snapshot: RunSnapshot = { running: false, id: null, root: "", config: emptyJavaRunConfig(), log: [], error: "", result: null, pid: null };
const listeners = new Set<() => void>();
const set = (value: Partial<RunSnapshot>) => { snapshot = { ...snapshot, ...value }; listeners.forEach(fn => fn()); };
const appendLog = (text: string) => set({ log: [...snapshot.log, ...text.replace(/\r\n/g, "\n").split("\n").filter(Boolean)].slice(-1500) });
export const getJavaRunSnapshot = () => snapshot;
export const useJavaRunSnapshot = () => useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback); }, getJavaRunSnapshot, getJavaRunSnapshot);
export function configureJavaRun(config: JavaRunConfig): void { if (!snapshot.running) set({ config }); }
export function readJavaRunConfig(root: string): JavaRunConfig {
  try { const parsed = JSON.parse(localStorage.getItem(`ncforge-java-run:${root}`) ?? "null") as JavaRunConfig | null;
    if (parsed && ["main", "test"].includes(parsed.mode) && [parsed.path, parsed.classes, parsed.args, parsed.extraClasspath].every(v => typeof v === "string")) return parsed;
  } catch { /* 未保存配置时从当前文件生成。 */ }
  return emptyJavaRunConfig();
}
export async function configureRunFromEditor(mode: "main" | "test", method = false): Promise<void> {
  const { editorSnapshot } = await import("./editorActions");
  const source = editorSnapshot();
  if (!source?.path || !source.isJava) { toast("先打开一个 Java 源文件", "info"); return; }
  if (/^(jdt|nc-library):/.test(source.path)) { toast("请选择工程内的 Java 源文件作为运行目标", "info"); return; }
  const target = sourceRunTarget(source.text, source.line, method, source.column);
  if (!target) { toast(method ? "当前光标不在可识别的方法中" : "无法识别当前 Java 类型", "info"); return; }
  configureJavaRun({ ...readJavaRunConfig(getSession().root ?? ""), path: source.path, mode, classes: target });
}
export async function runJava(config: JavaRunConfig, debug = false, coverage = false): Promise<void> {
  if (snapshot.running) return;
  const root = getSession().root ?? "", epoch = workspaceEpoch();
  if (!root || !config.path || !config.classes.trim()) { toast("请选择运行源码和完整类名", "info"); return; }
  if (getSession().tabs.some(t => t.dirty || t.eolChanged)) { toast("先保存工程中已打开的修改，再运行或测试，避免执行旧代码", "info"); return; }
  if (debug && (getDebugSnapshot().targets.remote.state === "attached" || getDebugSnapshot().targets.remote.busy)) { toast("远程调试槽正在使用，请先断开该槽，再调试本地运行任务", "info"); return; }
  const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const lifecycle = beginJavaRun(() => invoke("java_run_cancel", { id }));
  if (!lifecycle) { toast("正在停止任务或切换工程，请稍后运行", "info"); return; }
  set({ running: true, id, root, config, log: [], error: "", result: null, pid: null });
  try { localStorage.setItem(`ncforge-java-run:${root}`, JSON.stringify(config)); } catch { /* 会话内仍可用。 */ }
  const cleanup: (() => void)[] = [];
  let attachment: Promise<void> | undefined;
  try {
    cleanup.push(await listen<{ id: string; text: string }>("java-run-log", event => { if (event.id === id) appendLog(event.text); }));
    cleanup.push(await listen<{ id: string; pid: number; debugPort: number | null }>("java-run-started", event => {
      if (event.id !== id) return;
      set({ pid: event.pid });
      if (lifecycle.cancelled || epoch !== workspaceEpoch()) { void invoke("java_run_cancel", { id }); return; }
      if (event.debugPort) {
        if (getDebugSnapshot().targets.remote.state === "attached" || getDebugSnapshot().targets.remote.busy) { appendLog("远程调试槽已被占用，已取消本地调试进程。"); void invoke("java_run_cancel", { id }); return; }
        attachment = attachDebugger("remote", { host: "127.0.0.1", port: event.debugPort }).catch(error => {
          appendLog(`附加本地运行失败：${String(error)}。进程已停止。`); void invoke("java_run_cancel", { id });
        });
      }
    }));
    if (lifecycle.cancelled) return;
    const result = await invoke<JavaRunResult>("java_run", { request: { id, path: config.path, mode: config.mode, classes: inputLines(config.classes).map(v => v.trim()), args: inputLines(config.args), extraClasspath: inputLines(config.extraClasspath).map(v => v.trim()), debug, coverage } });
    set({ result });
    appendLog(result.cancelled ? "运行已取消。" : `运行结束：退出码 ${result.exitCode ?? "未知"}，${result.durationMs} ms。`);
  } catch (error) { set({ error: String(error) }); }
  finally {
    await attachment;
    cleanup.forEach(off => off()); set({ running: false, pid: null }); lifecycle.finish();
  }
}
export const cancelJavaRun = cancelJavaRunAndWait;
export async function rerunFailed(): Promise<void> {
  const failures = snapshot.result?.failures ?? [];
  if (snapshot.root !== (getSession().root ?? "")) { toast("请返回原工程后重跑失败测试", "info"); return; }
  if (failures.length) await runJava({ ...snapshot.config, mode: "test", classes: failedRunTargets(failures).join("\n") });
}
export function registerJavaRunCommands(open: () => void): () => void {
  return registerCommands([
    { id: "java.run.main", title: "运行当前 Java 类 main", run: () => { void configureRunFromEditor("main").then(open); } },
    { id: "java.run.test", title: "运行当前 JUnit 测试类（JUnit 4 / 5）", run: () => { void configureRunFromEditor("test").then(open); } },
    { id: "java.run.method", title: "运行光标所在 JUnit 测试方法", run: () => { void configureRunFromEditor("test", true).then(open); } },
    { id: "java.run.configure", title: "运行配置 / 测试 / 覆盖率 / JVM 诊断", run: open },
  ]);
}
