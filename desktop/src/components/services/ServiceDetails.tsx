import { formatHeapMb } from "../../lib/server";
import { formatUptime } from "../../lib/serverLog";
import { useDbSelector } from "../../lib/dbStore";
import { serviceNames, servicePresentation, type ServiceSource, type ServiceStatus } from "../../lib/servicePresentation";

export function ServiceDetails({ source, status, failed, onCommandLine, onEditPort }: { source: ServiceSource; status: ServiceStatus | null; failed: boolean; onCommandLine: () => void; onEditPort: () => void }) {
  const dbNames = useDbSelector(s => s.conns.filter(c => s.rt[c.id]?.status === "connected").map(c => c.name).join("、"));
  const view = servicePresentation(source, status, failed);
  if (!status || failed) return <p className="sc-detail-muted">{failed ? "服务状态读取失败，请重试后查看运行详情。" : "正在读取运行详情…"}</p>;
  const values = [
    ["状态", view.label], ["进程", status.pid ? `PID ${status.pid}` : "未在运行"], [source === "client" ? "连接目标" : "监听目标", view.endpoint],
    ["已运行", formatUptime(status.uptimeMs ?? 0)], ["调试", status.debugPort ? `JDWP 127.0.0.1:${status.debugPort}` : "本次未开启 JDWP"],
    ["主类", status.mainClass], ["Java", status.java ?? "尚未选择"], ["NC 目录", status.ncHome ?? "尚未选择"],
    ["工程", status.projectRoot ?? "尚未选择"], ["堆上限", formatHeapMb(status.heapMb)], ["classpath", `${status.classpathEntries} 项`],
    ["退出码", status.exitCode === null ? "尚未退出" : String(status.exitCode)],
  ];
  return <>
    <dl className="sc-detail-list">{values.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || "—"}</dd></div>)}</dl>
    {status.reason && <p className="sc-detail-reason">{status.reason}</p>}
    <h3>可用性依据</h3><div className="sc-health-row"><span>{source === "client" ? "客户端连接目标" : "进程与端口"}</span><span className="sc-status-badge" data-tone={source === "client" && "serverReachable" in status ? status.serverReachable ? "ok" : "warn" : view.state === "running" ? "ok" : "idle"}>{source === "client" && "serverReachable" in status ? status.serverReachable ? "可达" : "未就绪" : view.state === "running" ? "本进程监听" : "尚未确认监听"}</span></div>
    <div className="sc-health-row"><span>NC 业务健康</span><span className="sc-status-badge">未验证</span></div><p className="sc-detail-muted">端口可达不能证明登录与业务模块正常。</p>
    <h3>工作台数据库</h3><p>{dbNames || "尚无已连接的数据库"}</p><p className="sc-detail-muted">供工作台查询使用，独立于{serviceNames[source]}运行状态。</p>
    <div className="sc-detail-actions"><button type="button" className="sv-btn" onClick={onCommandLine}>完整启动命令</button>{source === "middleware" && <button type="button" className="sv-btn" disabled={status.state !== "stopped"} title={status.state !== "stopped" ? "先停止服务再修改端口" : undefined} onClick={onEditPort}>修改监听端口</button>}</div>
  </>;
}
