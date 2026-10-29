import { Icon } from "../ui/icon";
import type { ServerStatus } from "../../lib/server";
import { formatUptime } from "../../lib/serverLog";

type Busy = "start" | "stop" | "restart" | "kill" | null;

interface Props {
  status: ServerStatus | null;
  busy: Busy;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  /** 打开「改监听端口」弹窗（弹窗自己拉预览、自己写文件）。 */
  onEditPort: () => void;
}

const STATE_TEXT: Record<string, string> = {
  running: "运行中",
  starting: "启动中",
  stopped: "已停止",
};

/** busy 各值的人话（P2-12：按钮被锁时要悬停说得清在等什么）。 */
const BUSY_TEXT: Record<Exclude<Busy, null>, string> = {
  start: "启动",
  stop: "停止",
  restart: "重启",
  kill: "结束占用进程",
};

/**
 * 服务状态卡：状态、三个关键指标、启停。
 *
 * 状态判定全在后端（`server_cmds::build_status`），这里只负责显示——
 * 前端自己拼「进程在就算运行」会在「java 起着但端口没监听」时骗人，
 * 而那种状态恰恰最需要用户去翻日志。
 */
export function ServiceCard({ status, busy, onStart, onStop, onRestart, onEditPort }: Props) {
  const state = status?.state ?? "stopped";
  const running = state === "running";
  const starting = state === "starting";
  const portConflict = !!status?.portOwner && !status.portOwnedBySelf;
  const disabled = busy !== null || starting;
  // 端口只能启动时决定：在跑的 JVM 不会重读 prop.xml。运行中让按钮可点，
  // 用户填完、等 300ms 预览回来才被告知「先停止」——约束应该在入口就说明。
  const portLocked = running || starting;

  const desc = (() => {
    if (!status) return "正在读取状态…";
    if (portsText(status)) return portsText(status);
    if (status.reason) return status.reason;
    if (status.exitCode !== null && status.exitCode !== 0) return `上次退出码 ${status.exitCode}`;
    return "尚未启动";
  })();

  // 端口不是本应用定的，是 NC 自己在 ierp/bin/prop.xml 里配的。悬停要说清
  // 「这个数字从哪来」，否则同事把端口改成 8080 后看到界面还显示端口来源不明。
  const portHint = (() => {
    if (!status) return undefined;
    const addr = status.portAddress;
    const scope =
      addr && addr !== "127.0.0.1" && addr !== "localhost"
        ? `监听 ${addr}（同网段可访问）`
        : addr
          ? "只监听本机（127.0.0.1）"
          : null;
    const source = status.portFromConfig
      ? `读自 ${status.portConfigPath}`
      : "没读到 ierp/bin/prop.xml，按默认 80 显示";
    return [scope, source, "点击可改"].filter(Boolean).join(" · ");
  })();

  return (
    <div className="sv-card" data-state={state}>
      <div className="sv-state">
        <div className="sv-ring">
          <span className="sv-dot" />
        </div>
        <div className="sv-title">
          <div className="sv-line1">
            <span className="sv-name">中间件</span>
            <span className="sv-badge">{STATE_TEXT[state] ?? state}</span>
          </div>
          <div className="sv-desc" title={desc}>
            {desc}
          </div>
        </div>
      </div>

      <div className="sv-metrics">
        <div className="sv-metric">
          <span className="sv-k">PID</span>
          <span className="sv-v">{status?.pid ?? "—"}</span>
        </div>
        <div className="sv-metric">
          {/* 端口做成按钮：它是这个页面上最可能需要改的东西（80 常被 IIS 占），
              藏进设置页反而让人找不到 */}
          <button
            type="button"
            className="sv-k sv-k-edit"
            title={portLocked ? "服务正在运行，端口只能启动时决定：先停止再改" : portHint}
            aria-label="修改监听端口"
            disabled={portLocked}
            onClick={onEditPort}
          >
            端口 {status?.port ?? 80}
            <Icon name="settings" size={9} />
          </button>
          <span
            className="sv-v"
            style={{
              color: running
                ? "hsl(var(--success-ink))"
                : portConflict
                  ? "hsl(var(--destructive-ink))"
                  : undefined,
            }}
          >
            {running ? "监听中" : starting ? "等待监听" : portConflict ? "被占用" : "空闲"}
          </span>
        </div>
        <div className="sv-metric">
          <span className="sv-k">已运行</span>
          <span className="sv-v">{running || starting ? formatUptime(status?.uptimeMs ?? 0) : "—"}</span>
        </div>
        <div className="sv-metric">
          <span className="sv-k">classpath</span>
          <span className="sv-v">
            {status?.classpathEntries ? status.classpathEntries : "—"}
            {status?.classpathEntries ? <small> 项</small> : null}
          </span>
        </div>
      </div>

      <div className="sv-actions">
        {running && (
          <button
            type="button"
            className="sv-btn"
            disabled={busy !== null}
            title={busy ? `${BUSY_TEXT[busy]}命令进行中，请稍候` : undefined}
            onClick={onRestart}
          >
            {/* busy 时图标换 spinner：与 Button isLoading 同款「进行中视觉」，
                不再只靠文字变「XX中…」（P2-13）。 */}
            {busy === "restart" ? <Icon name="spinner" size={13} className="animate-spin" /> : <Icon name="refresh" size={13} />}
            {busy === "restart" ? "重启中…" : "重启"}
          </button>
        )}
        {running || starting ? (
          <button
            type="button"
            className="sv-btn sv-btn-danger"
            disabled={busy !== null}
            title={busy ? `${BUSY_TEXT[busy]}命令进行中，请稍候` : undefined}
            onClick={onStop}
          >
            {busy === "stop" ? <Icon name="spinner" size={13} className="animate-spin" /> : <Icon name="power" size={13} />}
            {busy === "stop" ? "停止中…" : "停止"}
          </button>
        ) : (
          <button
            type="button"
            className="sv-btn sv-btn-primary"
            disabled={disabled}
            title={starting ? "正在启动，等待监听端口…" : busy ? `${BUSY_TEXT[busy]}命令进行中，请稍候` : undefined}
            onClick={onStart}
          >
            {busy === "start" ? <Icon name="spinner" size={13} className="animate-spin" /> : <Icon name="play" size={13} />}
            {busy === "start" ? "启动中…" : "启动"}
          </button>
        )}
      </div>
    </div>
  );
}

/** 「主类 · 地址」一行副标题；没起过时返回空串（交给 reason 兜底）。 */
function portsText(s: ServerStatus): string {
  if (!s.pid) return "";
  // 用配置里的监听地址：`<address>` 被改成 0.0.0.0 时，写 127.0.0.1 会让想从
  // 同网段访问的人以为「就是这样配的」，白白怀疑网络。
  return `${s.mainClass} · ${s.portAddress ?? "127.0.0.1"}:${s.port}`;
}
