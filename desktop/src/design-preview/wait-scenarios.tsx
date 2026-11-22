import { Icon } from "../components/ui/icon";

/** 等待体验设计稿的新设计元素与场景脚本。全部用真实 token 渲染，数据为模拟。 */

export interface Phase { name: string; state: "pending" | "active" | "done" | "skipped" }
export interface Summary { startedAt: number; endedAt: number; items: { label: string; value: string }[] }
export interface Run {
  state: "running" | "cancelling" | "success" | "cancelled" | "failed";
  startedAt: number; phase: string; detail?: string;
  done?: number; total?: number; unit?: string;
  phases?: Phase[]; eta?: number; usually?: number;
  bytes?: number; totalBytes?: number; rate?: number;
  logs?: string[]; tipIndex?: number; summary?: Summary; stalled?: boolean;
}
export type Script = { at: number; patch: Partial<Run> }[];

export const humanDuration = (s: number) => s < 60 ? `${Math.max(5, Math.ceil(s / 5) * 5)}s` : `${Math.ceil(s / 60)}min`;

/** ETA 标签：永远带「预计/通常」，向上取整到人类刻度（方案 §4.2）。 */
export function EtaTag({ seconds, usually }: { seconds?: number; usually?: number }) {
  if (seconds === undefined && usually === undefined) return null;
  const text = seconds !== undefined ? `预计还需 ~${humanDuration(seconds)}` : `通常 ${humanDuration(usually!)}`;
  return <span className="wp-eta" title="按历史耗时估算，保守向上取整">{text}</span>;
}

/** 阶段 stepper：≤5 步，当前步呼吸点，完成步打勾（IDEA 命名阶段同构）。 */
export function PhaseStepper({ phases }: { phases: Phase[] }) {
  return <ol className="wp-steps" aria-label="任务阶段">{phases.map(p =>
    <li key={p.name} data-state={p.state} aria-current={p.state === "active" ? "step" : undefined}>
      <span className="wp-step-dot">{p.state === "done" ? <Icon name="check" size={10} /> : p.state === "active" ? <span className="wp-step-pulse" /> : null}</span>
      <span>{p.name}</span>
    </li>)}</ol>;
}

/** 完成摘要卡：开始/结束/耗时 + 发生了什么 + 跳转（NN/g 长等待五准则之二）。 */
export function CompletionCard({ summary, onReveal }: { summary: Summary; onReveal?: () => void }) {
  const dur = ((summary.endedAt - summary.startedAt) / 1000).toFixed(1);
  const fmt = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
  return <div className="wp-done" role="status">
    <div className="wp-done-head"><Icon name="check" size={14} /><strong>已完成</strong>
      <span className="wp-done-time">{fmt(summary.startedAt)} → {fmt(summary.endedAt)} · 耗时 {dur}s</span></div>
    <dl className="wp-done-items">{summary.items.map(i => <div key={i.label}><dt>{i.label}</dt><dd>{i.value}</dd></div>)}</dl>
    {onReveal && <button type="button" className="dbx-btn" onClick={onReveal}>查看结果</button>}
  </div>;
}

/** 表树骨架：行结构与真实树 1:1（图标位 + 名称条），落地零跳动。 */
export function SkeletonTree({ rows = 9 }: { rows?: number }) {
  return <div className="wp-tree" aria-hidden="true">{Array.from({ length: rows }, (_, i) =>
    <div key={i} className="wp-tree-row" style={{ paddingLeft: 12 + (i % 3) * 14 }}>
      <span className="skeleton" style={{ width: 14, height: 14, flex: "none" }} />
      <span className="skeleton" style={{ width: `${55 + (i * 17) % 30}%`, height: 12 }} />
    </div>)}</div>;
}

export const REAL_TREE = ["ic_saleout_h", "ic_saleout_b", "ic_saleout_e", "so_saleorder", "so_saleorder_b", "so_saleorder_exe", "ic_purchasein_b", "bd_material", "org_orgs"];

export const TIPS = [
  "快捷键：Ctrl+Enter 执行光标处语句，整段执行在工具条。",
  "schema 下拉切换 current_schema，新开的会话会自动继承。",
  "右键表 → 结构，可以看主键与 NC 中文名。",
  "右上角任务中心可以把长任务转后台，完成会显著通知。",
  "导出的 INSERT 可以在 SQL 控制台直接回放。",
];
/** 等待内容层：预计 >15s 才出现，永远在进度下方，不盖进度（方案 §4.4）。 */
export function WaitTips({ index }: { index: number }) {
  return <p className="wp-tip"><Icon name="activity" size={12} /><span>{TIPS[index % TIPS.length]}</span></p>;
}

const phases = (active: number, names: string[]): Phase[] =>
  names.map((name, i) => ({ name, state: i < active ? "done" : i === active ? "active" : "pending" }));

/** 场景脚本（毫秒为正常速度基准）。ETA 检查点递减，演示单调收敛。 */
export const SCRIPTS: Record<string, Script> = {
  query: [
    { at: 0, patch: { phase: "正在查询 ic_saleout_b", usually: 3, tipIndex: 0 } },
    { at: 10_000, patch: { eta: 10, detail: "查询比平时慢，仍可继续其他工作" } },
    { at: 13_000, patch: { eta: 6, tipIndex: 1 } },
    { at: 15_000, patch: { stalled: true, detail: "正在等待数据库返回（已 15s）· 可随时停止" } },
    { at: 16_500, patch: { eta: 2, tipIndex: 2 } },
    { at: 18_000, patch: { state: "success", summary: { startedAt: 0, endedAt: 0, items: [{ label: "返回行数", value: "500（还有更多）" }, { label: "语句", value: "select … from ic_saleout_b" }] } } },
  ],
  script: [
    { at: 0, patch: { phase: "执行脚本", done: 0, total: 6, unit: "条", eta: 12, tipIndex: 3 } },
    { at: 2_000, patch: { done: 1, eta: 10, detail: "第 2 条：update ic_saleout_e …" } },
    { at: 4_000, patch: { done: 2, eta: 8 } },
    { at: 6_000, patch: { done: 3, eta: 6, detail: "第 4 条：insert into …" } },
    { at: 8_000, patch: { done: 4, eta: 4, tipIndex: 4 } },
    { at: 10_000, patch: { done: 5, eta: 2 } },
    { at: 12_000, patch: { state: "success", done: 6, summary: { startedAt: 0, endedAt: 0, items: [{ label: "成功", value: "5 条" }, { label: "失败", value: "1 条（第 4 条 ORA-00001）" }, { label: "影响行数", value: "128" }] } } },
  ],
  compile: [
    { at: 0, patch: { phase: "扫描模块依赖", phases: phases(0, ["扫描", "编译", "收尾"]), done: 0, total: 12, unit: "个模块", eta: 16, logs: ["[scan] 读取 994 个源文件…"], tipIndex: 0 } },
    { at: 2_000, patch: { phase: "编译模块", phases: phases(1, ["扫描", "编译", "收尾"]), eta: 14, logs: ["[scan] 依赖图就绪 · 12 个模块待编译", "[ecj] ic · 编译中…"] } },
    { at: 5_000, patch: { done: 3, eta: 11, logs: ["[ecj] ic ✓ 395ms", "[ecj] so · 编译中…"] } },
    { at: 8_000, patch: { done: 6, eta: 8, tipIndex: 1, logs: ["[ecj] so ✓ 621ms", "[ecj] bd · 编译中…"] } },
    { at: 11_000, patch: { done: 9, eta: 5, logs: ["[ecj] bd ✓", "[ecj] org · 编译中…"] } },
    { at: 14_000, patch: { done: 12, phases: phases(2, ["扫描", "编译", "收尾"]), phase: "收尾", eta: 2, logs: ["[ecj] 12/12 完成 · 1 个模块有警告"] } },
    { at: 16_000, patch: { state: "success", phases: phases(3, ["扫描", "编译", "收尾"]), summary: { startedAt: 0, endedAt: 0, items: [{ label: "模块", value: "12 编译 · 0 失败 · 1 警告" }, { label: "产物", value: "classes 已就绪" }] } } },
  ],
  connect: [
    { at: 0, patch: { phase: "建立连接", phases: phases(0, ["连接", "认证", "切 schema", "就绪"]) } },
    { at: 1_500, patch: { phase: "认证", phases: phases(1, ["连接", "认证", "切 schema", "就绪"]) } },
    { at: 3_000, patch: { phase: "切换默认 schema", phases: phases(2, ["连接", "认证", "切 schema", "就绪"]) } },
    { at: 4_500, patch: { state: "success", phase: "就绪", phases: phases(4, ["连接", "认证", "切 schema", "就绪"]), summary: { startedAt: 0, endedAt: 0, items: [{ label: "账号", value: "AIER · schema AIER633" }, { label: "表树", value: "已加载 1,204 张表" }] } } },
  ],
  download: [
    { at: 0, patch: { phase: "下载更新", bytes: 0, totalBytes: 48_000_000, rate: 4_200_000, eta: 12, tipIndex: 2 } },
    { at: 3_000, patch: { bytes: 12_600_000, rate: 4_200_000, eta: 9 } },
    { at: 6_000, patch: { bytes: 24_000_000, rate: 3_600_000, eta: 7, detail: "速率略有下降，预计时间已更新" } },
    { at: 9_000, patch: { bytes: 35_000_000, rate: 3_800_000, eta: 4, tipIndex: 3 } },
    { at: 12_000, patch: { bytes: 48_000_000, phase: "校验并安装", eta: 1 } },
    { at: 13_000, patch: { state: "success", summary: { startedAt: 0, endedAt: 0, items: [{ label: "版本", value: "v0.6.1 · 48MB" }, { label: "校验", value: "签名通过" }] } } },
  ],
};