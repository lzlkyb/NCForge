import type { ServerStatus } from "../../lib/server";
import { useDbSelector } from "../../lib/dbStore";

type Tone = "ok" | "warn" | "bad" | "busy" | "idle";

/**
 * 服务链路：进程 → 端口 → NC 应用 → 数据库。
 *
 * 服务卡上的三个指标回答「是什么」，链路条回答「断在哪」：
 * java 起着但端口被别的程序占了、端口通了但模块还没加载完、或者一切都好却没连数据库，
 * 在几个分散的数字里看不出来，排成一条线才能一眼定位。
 */
export function ServiceChain({
  status,
  failed,
  onEditPort,
}: {
  status: ServerStatus | null;
  failed: boolean;
  onEditPort: () => void;
}) {
  const dbOn = useDbSelector((s) => s.conns.filter((c) => s.rt[c.id]?.status === "connected").length);
  const dbName = useDbSelector((s) => s.conns.find((c) => s.rt[c.id]?.status === "connected")?.name ?? "");
  const go = (tab: string) =>
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: tab }));

  const state = status?.state ?? (failed ? "unknown" : "loading");
  const running = state === "running";
  const starting = state === "starting";
  const conflict = !!status?.portOwner && !status.portOwnedBySelf;

  const nodes: { key: string; tone: Tone; text: string; title: string; onClick?: () => void }[] = [
    {
      key: "proc",
      tone: running ? "ok" : starting ? "busy" : failed ? "warn" : "idle",
      text: running && status?.pid ? `进程 ${status.pid}` : starting ? "进程启动中" : "进程未起",
      title: running && status?.pid ? `PID ${status.pid} · 主类 ${status.mainClass ?? "—"}` : "中间件 JVM 没有在运行",
    },
    {
      key: "port",
      tone: running ? (conflict ? "bad" : "ok") : starting ? "busy" : conflict ? "bad" : "idle",
      text: `端口 ${status?.port ?? 80}`,
      title: conflict
        ? `端口被 ${status?.portOwner?.name ?? "其它进程"}（PID ${status?.portOwner?.pid ?? "?"}）占着；点击修改监听端口`
        : running
          ? `已在 ${status?.portAddress ?? "127.0.0.1"}:${status?.port ?? 80} 监听；点击可改端口`
          : "服务没起时端口空闲；点击可改端口",
      onClick: onEditPort,
    },
    {
      key: "app",
      tone: running ? "ok" : starting ? "busy" : "idle",
      text: starting ? "NC 应用加载中" : running ? "NC 应用就绪" : "NC 应用未就绪",
      title: running
        ? "端口已由本进程监听，可以开始从浏览器访问"
        : "服务起来、端口监听后才算就绪；加载模块通常要 10 秒左右",
    },
    {
      key: "db",
      tone: dbOn > 0 ? "ok" : "warn",
      text: dbOn > 0 ? `DB · ${dbName || `${dbOn} 个`}` : "DB 未连接",
      title: dbOn > 0 ? "点一下打开数据库页" : "当前没有已连接的数据库：点表结构核对或 SQL 时会用到",
      onClick: () => go("db"),
    },
  ];

  return (
    <div className="sv-chain" role="group" aria-label="服务链路">
      {nodes.map((n, i) => (
        <span key={n.key} className="sv-chain-cell">
          {i > 0 && <span className="sv-chain-arrow" aria-hidden="true">›</span>}
          {n.onClick ? (
            <button type="button" className="sv-chain-node" data-tone={n.tone} title={n.title} onClick={n.onClick}>
              <i aria-hidden="true" />
              {n.text}
            </button>
          ) : (
            <span className="sv-chain-node" data-tone={n.tone} title={n.title}>
              <i aria-hidden="true" />
              {n.text}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
