import { invoke, listen } from "./tauri";
import { getDebugSnapshot, resumeDebug } from "./debugSession";
import { installTemporaryBreakpoint, clearTemporaryBreakpoint } from "./debugSync";
import { registerCommands } from "./commandRegistry";
import { getSession } from "./workspaceSession";
import { toast } from "../components/ui/toast";
import type { DebugEvent } from "./debug";

let cleanupReady: Promise<void> = Promise.resolve();
let cleanupAvailable = true;

export async function runToCursor(): Promise<void> {
  const { editorSnapshot } = await import("./editorActions");
  const source = editorSnapshot(), snap = getDebugSnapshot();
  if (!source?.path || !source.isJava || !snap.paused || !snap.threadId) {
    toast("先暂停调试，再把光标放到要运行至的 Java 代码行", "info"); return;
  }
  try {
    await cleanupReady;
    if (!cleanupAvailable) throw new Error("临时断点清理事件尚未连接，请重新打开代码页后重试");
    await installTemporaryBreakpoint(snap.target, source.path, source.line);
    const current = getDebugSnapshot();
    if (current.target !== snap.target || !current.paused || current.stopSeq !== snap.stopSeq) {
      await clearTemporaryBreakpoint(snap.target); return;
    }
    await resumeDebug(snap.target);
    if (getDebugSnapshot().paused) await clearTemporaryBreakpoint(snap.target);
  } catch (error) { toast(`运行到光标失败：${String(error)}`, "error"); }
}

export const DEFAULT_STEP_FILTERS = "java.*,javax.*,sun.*,com.sun.*,jdk.*";
export function readStepFilters(): string {
  try { return localStorage.getItem(`ncforge-step-filters:${getSession().root ?? ""}`) ?? DEFAULT_STEP_FILTERS; }
  catch { return DEFAULT_STEP_FILTERS; }
}
export async function applyStepFilters(value: string): Promise<void> {
  const filters = value.split(/[\n,;]+/).map(v => v.trim()).filter(Boolean);
  if (filters.length > 64 || filters.some(v => !/^[\w$.*]+$/.test(v))) throw new Error("最多 64 条包名过滤规则，只能含字母、数字、点、下划线、$ 和 *");
  const snap = getDebugSnapshot();
  const root = getSession().root ?? "";
  await invoke("debug_set_step_filters", { target: snap.target, filters });
  try { localStorage.setItem(`ncforge-step-filters:${root}`, filters.join(",")); } catch { /* 会话内设置已生效。 */ }
}

/** Temporary breakpoints disappear at the next stop, even when another breakpoint wins. */
export function registerDebugAdvancedCommands(): () => void {
  let alive = true, unlisten: (() => void) | undefined;
  cleanupAvailable = true;
  cleanupReady = listen<DebugEvent>("debug-event", event => {
    if (["stopped", "terminated", "exited"].includes(event.event)) void clearTemporaryBreakpoint(event.target).catch(error => toast(`移除临时断点失败：${String(error)}`, "error"));
  }).then(off => { if (alive) unlisten = off; else off(); }).catch(error => { cleanupAvailable = false; toast(`无法接收临时断点清理事件：${String(error)}`, "error"); });
  const unregister = registerCommands([{ id: "debug.runToCursor", title: "运行到光标（临时断点，不保存到断点列表）", run: () => void runToCursor(), enabled: () => getDebugSnapshot().paused }]);
  return () => { alive = false; unlisten?.(); unregister(); };
}
