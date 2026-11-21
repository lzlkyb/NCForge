import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Icon, type IconName } from "../ui/icon";
import { SettingsRow } from "../ui/SettingsRow";
import { failureText } from "../../lib/friendlyError";
import { downloadText } from "../../lib/resultExport";
import { useOperationActive, trackOperation } from "../../lib/operations";
import { releaseIdleCompilers, sampleMemory, type MemorySnapshot } from "../../lib/storageMaintenance";
import { formatBytes } from "../../lib/utils";
import { useAppHidden } from "../../lib/appVisibility";
import type { storageMetrics } from "../../lib/storageMetrics";

const labels: Record<MemorySnapshot["rows"][number]["group"], string> = {
  main: "NCForge 主程序", webview: "界面 WebView", language: "代码智能 JVM",
  compiler: "编译 JVM", database: "数据库桥接", other: "其他子进程",
};
const icons: Record<keyof typeof labels, IconName> = {
  main: "monitor", webview: "panel", language: "code", compiler: "hammer", database: "database", other: "layers",
};
const size = (bytes: number | undefined | null) => bytes == null ? "暂不可用" : formatBytes(bytes);
const MAX_SAMPLES = 24;
type SampleState = { snapshots: MemorySnapshot[]; metrics?: ReturnType<typeof storageMetrics>; error?: string; moduleUnavailable?: boolean };

export function StorageMemory({ active: visible }: { active: boolean }) {
  const windowHidden = useAppHidden();
  const active = visible && !windowHidden;
  const [state, setState] = useState<SampleState>({ snapshots: [] });
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState(false);
  const inFlight = useRef(false);
  const shown = useRef(active);
  shown.current = active;
  const releasing = useOperationActive("storage.release-compilers");
  const refresh = useCallback(async () => {
    if (!shown.current || inFlight.current || document.hidden) return;
    inFlight.current = true;
    try {
      const snapshot = await sampleMemory();
      if (shown.current) setState(current => ({ ...current, snapshots: [...current.snapshots.slice(1 - MAX_SAMPLES), snapshot], error: undefined }));
    } catch (error) {
      if (shown.current) setState(current => ({ ...current, error: failureText("读取运行内存", error) }));
    } finally { inFlight.current = false; }
  }, []);

  useEffect(() => {
    if (!active) return;
    const update = () => void refresh();
    update();
    const timer = setInterval(update, 5000);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [active, refresh]);

  useEffect(() => {
    if (!active || !detail) return;
    let live = true;
    const update = () => {
      if (document.hidden) return;
      void import("../../lib/storageMetrics").then(({ storageMetrics: collect }) => {
        const metrics = collect();
        if (live) setState(current => ({ ...current, metrics, moduleUnavailable: false }));
      }).catch(() => {
        if (live) setState(current => ({ ...current, moduleUnavailable: true }));
      });
    };
    update();
    const timer = setInterval(update, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [active, detail]);

  const current = state.snapshots[state.snapshots.length - 1];
  const release = async () => {
    setNotice("");
    try {
      const count = await trackOperation({ key: "storage.release-compilers", label: "释放闲置编译进程",
        page: "settings", phase: "正在回收空闲 JVM" }, () => releaseIdleCompilers(),
      count => ({ state: "success", detail: `已释放 ${count} 个闲置编译 JVM` }));
      setNotice(count ? `已释放 ${count} 个闲置编译 JVM，下次编译时按需启动。` : "当前没有可释放的闲置编译进程。");
      await refresh();
    } catch (error) { setNotice(failureText("释放闲置编译进程", error)); }
  };
  const exportSummary = () => {
    const data = state.snapshots.map(snapshot => ({
      at: new Date(snapshot.sampledAt).toISOString(), partial: snapshot.partial,
      processes: snapshot.rows.map(({ group, residentBytes, privateBytes }) => ({
        module: labels[group], residentBytes, privateBytes,
      })),
    }));
    downloadText("ncforge-memory-summary.json", JSON.stringify({ samples: data, frontend: state.metrics }, null, 2), "application/json", false);
  };
  return <>
    <div className="storage-toolbar"><h2>进程内存</h2>
      <div className="storage-row-actions">
        <Button size="sm" variant="ghost" disabled={!current} onClick={exportSummary}>
          <Icon name="download" size={14} aria-hidden="true" />导出摘要
        </Button>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          <Icon name="refresh" size={14} aria-hidden="true" />立即刷新
        </Button>
      </div>
    </div>
    <div className="storage-memory-meta">
      <span>驻留内存含共享页，私有提交单独列出。</span>
      {current && <span><Icon name="clock" size={13} aria-hidden="true" />
        {current.rows.length} 个进程 · {new Date(current.sampledAt).toLocaleTimeString()} 采样
      </span>}
    </div>
    {state.error && <p className="settings-inline-error" role="alert">{state.error}{current && "，下方显示上次采样。"}</p>}
    {!current && !state.error && <p className="storage-note" role="status">正在读取进程内存…</p>}
    {current?.partial && <p className="storage-note">部分进程无法读取，已显示可确认的数据。</p>}
    {current && <ProcessTable current={current} previous={state.snapshots[0]} />}
    <div className="storage-policy"><SettingsRow label="闲置编译进程" sub="释放后，下次编译按需启动 JVM" valueText={current ? String(current.idleCompilers) : undefined}
      control={<div className="storage-row-actions"><strong>{current ? `${current.idleCompilers} 个` : "暂不可用"}</strong>
        <Button size="sm" variant="outline" disabled={!current?.idleCompilers || Boolean(state.error)} isLoading={releasing} onClick={() => void release()}>释放闲置进程</Button>
      </div>} last /></div>
    {notice && <p className="storage-note" role="status">{notice}</p>}
    <details className="storage-details" open={detail} onToggle={event => setDetail(event.currentTarget.open)}>
      <summary><Icon name="chevronRight" size={14} aria-hidden="true" />界面与查询明细</summary>
      <FrontendMetrics metrics={state.metrics} unavailable={state.moduleUnavailable} />
    </details>
  </>;
}

function ProcessTable({ current, previous }: { current: MemorySnapshot; previous: MemorySnapshot }) {
  const seconds = Math.max(0, Math.round((current.sampledAt - previous.sampledAt) / 1000));
  const peak = current.rows.reduce((max, row) => Math.max(max, row.residentBytes ?? 0), 0);
  if (!current.rows.length) return <p className="storage-note">当前没有可显示的进程读数。</p>;
  return <div className="storage-process-table">
    <table>
      <thead><tr><th scope="col">进程</th><th scope="col">驻留内存</th><th scope="col">私有提交</th><th scope="col">{seconds ? `近 ${seconds} 秒变化` : "内存变化"}</th></tr></thead>
      <tbody>{current.rows.map(row => {
        const former = seconds ? previous.rows.find(item => item.pid === row.pid && item.group === row.group)?.residentBytes : null;
        const delta = former != null && row.residentBytes != null ? row.residentBytes - former : null;
        return <tr key={row.pid}><th scope="row">
          <div className="storage-process-name">
            <Icon name={icons[row.group]} size={17} aria-hidden="true" />
            <span className="storage-item-name"><strong>{labels[row.group]}</strong><small>PID {row.pid}</small></span>
          </div>
        </th>
          <td className="storage-resident"><strong>{size(row.residentBytes)}</strong>
            {row.residentBytes != null && peak > 0 && <span className="storage-memory-bar" aria-hidden="true">
              <span style={{ transform: `scaleX(${row.residentBytes / peak})` }} />
            </span>}
          </td>
          <td>{size(row.privateBytes)}</td>
          <td className="storage-delta" data-flat={delta == null || delta === 0}>
            {delta == null ? "—" : `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${formatBytes(Math.abs(delta))}`}
          </td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function FrontendMetrics({ metrics, unavailable }: { metrics?: ReturnType<typeof storageMetrics>; unavailable?: boolean }) {
  if (!metrics) return <p className="storage-note">{unavailable ? "暂时无法读取界面明细。" : "正在读取界面明细…"}</p>;
  return <dl className="storage-summary storage-metrics">
    <div><dt>JavaScript 已用堆</dt><dd>{size(metrics.heap)}</dd></div>
    <div><dt>编辑器模型</dt><dd>{metrics.models} 个 · 文本约 {size(metrics.modelTextBytes)}</dd></div>
    <div><dt>SQL 控制台结果</dt><dd>{metrics.resultSets} 个结果集 · {metrics.resultRows.toLocaleString()} 行 · 固定 {metrics.pinned} 个</dd></div>
    <div><dt>对象定义缓存</dt><dd>约 {size(metrics.ddl.bytes)} / {size(metrics.ddl.limitBytes)} · {metrics.ddl.entries} 项</dd></div>
  </dl>;
}
