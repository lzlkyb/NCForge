import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { TaskFeedback } from "../components/ui/TaskFeedback";
import { SavedHint } from "../components/ui/SavedHint";
import { LoadingState } from "../components/ui/LoadingState";
import { applyMotionPreference, getMotionPreference, subscribeMotionPreference } from "../lib/motionPreference";

type Scenario = "fast" | "normal" | "long" | "slow" | "error" | "partial";
type Run = { id: number; startedAt: number; scenario: Scenario; done: number;
  state: "running" | "cancelling" | "success" | "cancelled" | "error" | "partial" };

/** Controlled examples exercise the shipped components without touching business data. */
export function MotionTaskPreview() {
  const [scenario, setScenario] = useState<Scenario>("normal");
  const [run, setRun] = useState<Run | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const preference = useSyncExternalStore(subscribeMotionPreference, getMotionPreference);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const nextId = useRef(0);
  const working = run?.state === "running" || run?.state === "cancelling";
  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const start = () => {
    if (working) return;
    clear();
    const id = ++nextId.current;
    setRun({ id, startedAt: Date.now(), scenario, done: 0, state: "running" });
    if (scenario === "long") {
      for (const [delay, done] of [[4000, 1], [8000, 2]]) timers.current.push(setTimeout(() => {
        setRun(current => current?.id === id && current.state === "running" ? { ...current, done } : current);
      }, delay));
    }
    const delay = scenario === "fast" ? 50 : scenario === "long" || scenario === "slow" ? 12_000 : 900;
    timers.current.push(setTimeout(() => setRun(current => current?.id === id && current.state === "running"
      ? { ...current, done: scenario === "partial" ? 2 : 3,
        state: scenario === "error" ? "error" : scenario === "partial" ? "partial" : "success" } : current), delay));
  };
  const cancel = () => {
    if (!run || run.state !== "running") return;
    clear();
    const id = run.id;
    setRun({ ...run, state: "cancelling" });
    timers.current.push(setTimeout(() => setRun(current => current?.id === id && current.state === "cancelling"
      ? { ...current, state: "cancelled" } : current), 250));
  };
  return <section className="rounded-xl border bg-card p-5" data-testid="task-preview">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-sm font-semibold">等待与结果</h2>
      <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <input data-testid="reduce-motion" type="checkbox" checked={preference === "reduce"}
          onChange={event => applyMotionPreference(event.target.checked ? "reduce" : "system")} />减少动效
      </label>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <label className="text-xs text-muted-foreground" htmlFor="motion-scenario">模拟耗时与结果</label>
      <select id="motion-scenario" data-testid="motion-scenario" className="rounded border bg-background px-2 py-1 text-xs"
        value={scenario} disabled={working} onChange={event => setScenario(event.target.value as Scenario)}>
        <option value="fast">50 毫秒 · 快速完成</option><option value="normal">900 毫秒 · 正常完成</option>
        <option value="long">12 秒 · 分段进度</option><option value="error">900 毫秒 · 失败</option>
        <option value="partial">900 毫秒 · 部分完成</option>
        <option value="slow">12 秒 · 总量未知</option>
      </select>
      <Button data-testid="task-start" isLoading={working} loadingText="处理中…" onClick={start}>开始示例任务</Button>
      <button type="button" className="dbx-btn rounded border px-3 py-1 text-xs" data-testid="native-feedback"
        onClick={() => document.getElementById("motion-task-help")?.toggleAttribute("open")}>查看占位示例</button>
    </div>
    <div className="mt-3 min-h-24" data-testid="task-result" data-state={run?.state ?? "idle"}>
      <TaskFeedback active={working} label="正在生成示例产物…" startedAt={run?.startedAt} operationKey={run?.id}
        progress={run?.scenario === "long" ? { done: run.done, total: 3, unit: "个文件" } : undefined}
        detail={run?.scenario === "long" ? "根据模拟任务返回的文件结果更新" : "交互示例，不读写工作区文件"}
        onCancel={cancel} cancelling={run?.state === "cancelling"} />
      {run?.state === "success" && <SavedHint>示例任务已完成 · 3 个文件</SavedHint>}
      {run?.state === "cancelled" && <p className="text-sm text-muted-foreground" role="status">已取消 · 已处理 {run.done} 个文件</p>}
      {run?.state === "error" && <div className="text-sm text-destructive-ink" role="alert">示例任务失败：目标目录不可写。<Button variant="ghost" size="sm" onClick={start}>重试示例</Button></div>}
      {run?.state === "partial" && <p className="text-sm text-muted-foreground" role="status">部分完成 · 2 个成功，1 个失败 · 保留已完成结果</p>}
      {!run && <p className="text-xs text-muted-foreground">短任务直接完成；长任务可随时请求取消，确认后显示结果。</p>}
    </div>
    <details id="motion-task-help" className="text-xs text-muted-foreground" onToggle={event => setHelpOpen(event.currentTarget.open)}><summary className="cursor-pointer">首次加载占位</summary>
      {helpOpen && <LoadingState className="mt-4 max-w-sm" label="正在读取示例工作区…" />}
    </details>
  </section>;
}
