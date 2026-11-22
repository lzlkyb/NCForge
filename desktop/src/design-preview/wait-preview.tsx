import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { TaskFeedback } from "../components/ui/TaskFeedback";
import { QueryField } from "../components/db/QueryField";
import { toggleTheme } from "../lib/theme";
import { initializeMotionPreference, applyMotionPreference, getMotionPreference, subscribeMotionPreference } from "../lib/motionPreference";
import { useAppHiddenFlag } from "../hooks/useAppHiddenFlag";
import { CompletionCard, EtaTag, PhaseStepper, REAL_TREE, SCRIPTS, SkeletonTree, WaitTips, type Run, type Script } from "./wait-scenarios";
import "../index.css";
import "../interaction-refinements.css";
import "../forge-controls.css";
import "../motion-feedback.css";
import "../operation-feedback.css";
import "../db-execution.css";
import "../db-console.css";
import "./wait-preview.css";

/**
 * 等待体验设计稿（方案 docs/NCForge-等待体验全面重构-方案-2026-11-19.md）。
 * 几何申报：舞台固定高 360px；骨架树宽 220px；stepper 高 28px；chip 高 24px。
 * 真控件（TaskFeedback/QueryField/Button）+ 真样式表；IPC 全模拟，不连数据库。
 */

const SCENARIOS = [
  { id: "query", name: "SQL 单条查询（慢）" },
  { id: "script", name: "SQL 脚本批量" },
  { id: "compile", name: "编译构建" },
  { id: "connect", name: "数据库连接 + 表树" },
  { id: "download", name: "更新下载" },
];

function useScriptRun(script: Script, speed: number) {
  const [run, setRun] = useState<Run | null>(null);
  const timers = useRef<number[]>([]);
  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  useEffect(() => () => clear(), []);
  const start = () => {
    clear();
    const startedAt = Date.now();
    setRun({ state: "running", startedAt, phase: "" });
    for (const step of script) timers.current.push(window.setTimeout(() => {
      setRun(cur => {
        if (!cur || cur.state !== "running") return cur;
        const patch = { ...step.patch };
        if (patch.summary) patch.summary = { ...patch.summary, startedAt: cur.startedAt, endedAt: Date.now() };
        return { ...cur, ...patch };
      });
    }, step.at / speed));
  };
  const cancel = () => {
    clear();
    setRun(cur => cur?.state === "running" ? { ...cur, state: "cancelling", phase: "正在请求停止" } : cur);
    timers.current.push(window.setTimeout(() => setRun(cur => cur?.state === "cancelling" ? { ...cur, state: "cancelled" } : cur), 400));
  };
  return { run, start, cancel };
}

/** 骨架→真实内容：双 rAF 后再替换，保证布局已重量，落地零跳动。 */
function useRafReady(flag: boolean) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!flag) { setReady(false); return; }
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setReady(true)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [flag]);
  return ready;
}

const working = (run: Run | null) => run?.state === "running" || run?.state === "cancelling";
const mb = (b: number) => `${(b / 1_000_000).toFixed(1)}MB`;

function QueryStage({ run, onCancel }: { run: Run | null; onCancel: () => void }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const active = working(run);
  const rows = run?.state === "success" ? 6 : 4;
  return <div className="wp-stage">
    <div className="wp-stage-head">
      <TaskFeedback active={active} compact label={run?.phase || "正在查询"} startedAt={run?.startedAt} operationKey={run?.startedAt}
        cancelling={run?.state === "cancelling"} onCancel={onCancel}
        detail={<span className="wp-inline">{run?.detail ?? "结果区保留上次数据"}<EtaTag seconds={run?.eta} usually={run?.usually} /></span>} />
      {run?.state === "success" && <span className="dbx-query-status" data-state="success"><Icon name="check" size={12} />执行完成 · 18.0s · 500 行</span>}
      {run?.state === "cancelled" && <span className="dbx-query-status" data-state="cancelled"><Icon name="stop" size={12} />执行已停止</span>}
    </div>
    <div className="wp-grid" ref={setHost}>
      <div className="wp-grid-head"><span>VBILLCODE</span><span>CROWNO</span><span>NNUM</span><span>DBILLDATE</span></div>
      {Array.from({ length: rows }, (_, i) => <div className="wp-grid-row" key={i}>
        <span>SO2026111{i}0042</span><span>{(i + 1) * 10}</span><span>{12 + i * 3}</span><span>2026-11-1{i % 9}</span>
      </div>)}
      {host && <QueryField host={host} state={active ? "running" : "idle"} previous={!!run && run.state !== "success"} />}
    </div>
    {active && (run?.eta !== undefined || run?.stalled) && <WaitTips index={run.tipIndex ?? 0} />}
    {run?.state === "success" && run.summary && <CompletionCard summary={run.summary} />}
  </div>;
}

function PanelStage({ run, onCancel, kind }: { run: Run | null; onCancel: () => void; kind: "script" | "compile" | "download" }) {
  const active = working(run);
  const progress = kind === "download"
    ? (run?.bytes !== undefined && run.totalBytes ? { done: Math.round(run.bytes / 1_000_000), total: Math.round(run.totalBytes / 1_000_000), unit: "MB" } : undefined)
    : run?.done !== undefined ? { done: run.done, total: run.total, unit: run.unit } : undefined;
  return <div className="wp-stage">
    <div className="wp-panel">
      {run?.phases && <PhaseStepper phases={run.phases} />}
      <TaskFeedback active={active} label={run?.phase || "处理中"} startedAt={run?.startedAt} operationKey={run?.startedAt}
        cancelling={run?.state === "cancelling"} onCancel={onCancel} progress={progress}
        detail={<span className="wp-inline">{kind === "download" && run?.bytes !== undefined
          ? `${mb(run.bytes)} / ${mb(run.totalBytes!)} · ${mb(run.rate ?? 0)}/s` : run?.detail ?? ""}<EtaTag seconds={run?.eta} usually={run?.usually} /></span>} />
      {kind === "download" && active && <p className="wp-cost">取消会丢弃已下载的部分，下次需重新下载。</p>}
      {kind === "compile" && !!run?.logs?.length && <pre className="wp-logs" aria-label="构建日志">{run.logs.slice(-4).join("\n")}</pre>}
      {active && run?.eta !== undefined && run.eta > 8 && <WaitTips index={run.tipIndex ?? 0} />}
    </div>
    {run?.state === "success" && run.summary && <CompletionCard summary={run.summary} />}
    {run?.state === "cancelled" && <p className="wp-cancelled" role="status">已取消{kind === "script" ? ` · 已处理 ${run.done ?? 0} 条，结果保留` : ""}</p>}
  </div>;
}

function ConnectStage({ run, onCancel }: { run: Run | null; onCancel: () => void }) {
  const active = working(run);
  const ready = useRafReady(run?.state === "success");
  return <div className="wp-stage">
    <div className="wp-panel">
      {run?.phases && <PhaseStepper phases={run.phases} />}
      <TaskFeedback active={active} compact label={run?.phase || "正在连接"} startedAt={run?.startedAt} operationKey={run?.startedAt}
        cancelling={run?.state === "cancelling"} onCancel={onCancel} detail="连接建立后即可浏览其他页面" />
      {run?.state === "success" && <span className="dbx-query-status" data-state="success"><Icon name="check" size={12} />数据库已就绪 · 智能浏览可用</span>}
    </div>
    <div className="wp-connect-body">
      <div className="wp-tree-col">
        {!ready ? <SkeletonTree /> : <div className="wp-tree wp-tree-real">{REAL_TREE.map(t =>
          <div className="wp-tree-row" key={t}><Icon name="database" size={14} /><span>{t}</span></div>)}</div>}
      </div>
      <div className="wp-connect-note">{ready ? "表树已加载（骨架与真实行 1:1，替换经双 rAF 重量，零跳动）。" : "骨架屏占位：结构与真实表树一致，内容到达即替换。"}</div>
    </div>
    {run?.state === "success" && run.summary && <CompletionCard summary={run.summary} />}
  </div>;
}

function WaitPreview() {
  useAppHiddenFlag();
  const [scenario, setScenario] = useState("query");
  const [speed, setSpeed] = useState(1);
  const { run, start, cancel } = useScriptRun(SCRIPTS[scenario], speed);
  const preference = useSyncExternalStore(subscribeMotionPreference, getMotionPreference);
  const active = working(run);
  return <main className="wp-page">
    <header className="wp-header">
      <div><h1>等待体验设计稿</h1>
        <p>能预测的看见还要多久 · 不能预测的看见正在发生什么 · 随时能走 · 完成有摘要</p></div>
      <div className="wp-header-actions">
        <label className="wp-reduce"><input type="checkbox" checked={preference === "reduce"}
          onChange={e => applyMotionPreference(e.target.checked ? "reduce" : "system")} />减少动效</label>
        <Button variant="outline" onClick={toggleTheme}>切换主题</Button>
      </div>
    </header>
    <div className="wp-controls">
      <label htmlFor="wp-scenario">场景</label>
      <select id="wp-scenario" value={scenario} disabled={active} onChange={e => setScenario(e.target.value)}>
        {SCENARIOS.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <label htmlFor="wp-speed">速度</label>
      <select id="wp-speed" value={speed} disabled={active} onChange={e => setSpeed(Number(e.target.value))}>
        <option value={1}>正常</option><option value={0.5}>慢速（看得清）</option><option value={3}>快速</option>
      </select>
      <Button onClick={start} isLoading={active} loadingText="进行中…">{active ? "进行中" : "开始演示"}</Button>
      {active && <Button variant="outline" onClick={cancel} disabled={run?.state === "cancelling"}>请求停止</Button>}
      <span className="wp-geo">舞台固定高 360px · 骨架树宽 220px · stepper 高 28px</span>
    </div>
    {scenario === "query" && <QueryStage run={run} onCancel={cancel} />}
    {(scenario === "script" || scenario === "compile" || scenario === "download") && <PanelStage run={run} onCancel={cancel} kind={scenario} />}
    {scenario === "connect" && <ConnectStage run={run} onCancel={cancel} />}
    <footer className="wp-footer">
      <p>设计原则与出处见 <code>docs/NCForge-等待体验全面重构-方案-2026-11-19.md</code>。ETA 为历史学习估算（演示用脚本值），措辞永远带「预计/通常」；进度单调不回退；等待内容不盖进度；reduce 模式动画全降级。</p>
      <p className="wp-footer-sub">真控件：TaskFeedback / QueryField / Button · 真样式表：index.css / motion-feedback.css / operation-feedback.css / db-execution.css · 数据为模拟，不连数据库。</p>
    </footer>
  </main>;
}

initializeMotionPreference();
document.documentElement.classList.add("forge-controls");
createRoot(document.getElementById("root")!).render(<StrictMode><WaitPreview /></StrictMode>);