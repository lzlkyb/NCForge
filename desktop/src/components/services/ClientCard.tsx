import { Icon } from "../ui/icon";
import type { ClientStatus } from "../../lib/client";
import { formatUptime } from "../../lib/serverLog";
import "../../debug.css";

type Busy = "start" | "stop" | "restart" | null;

const STATE_TEXT: Record<string, string> = {
  running: "运行中",
  starting: "启动中",
  stopped: "已停止",
  loading: "正在读取…",
  unknown: "状态未知",
};

/**
 * 客户端状态卡：Swing `JStarter` 的进程、连接目标与 classpath。
 *
 * 与中间件卡分开显示的原因：客户端是「用户界面进程」，中间件是「被连的服务」。
 * 两者可以各自独立起停（客户端可以先起来再等服务），合并成一张卡会让
 * 「运行中」到底指哪一个变得含糊。
 */
export function ClientCard({
  status,
  busy,
  failed,
  debugMode,
  onToggleDebugMode,
  debugAttached,
  debugBusy,
  onAttachDebug,
  onDetachDebug,
  onStart,
  onStop,
  onRestart,
  onCommandLine,
  previewing,
}: {
  status: ClientStatus | null;
  busy: Busy;
  failed?: boolean;
  debugMode: boolean;
  onToggleDebugMode: () => void;
  /** 调试适配器是否已附加到客户端 JVM。 */
  debugAttached: boolean;
  debugBusy: boolean;
  onAttachDebug: () => void;
  onDetachDebug: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onCommandLine: () => void;
  previewing: boolean;
}) {
  const state = status?.state ?? (failed ? "unknown" : "loading");
  const running = state === "running";
  const starting = state === "starting";
  const disabled = busy !== null || starting;

  const desc = (() => {
    if (!status) return failed ? "读取客户端状态失败（可重试）" : "正在读取状态…";
    if (status.reason) return status.reason;
    if (status.exitCode !== null && status.exitCode !== 0) return `上次退出码 ${status.exitCode}`;
    if (running || starting) {
      return status.serverReachable
        ? `${status.mainClass} · 连接 ${status.host}:${status.port}`
        : `${status.mainClass} · 中间件 ${status.host}:${status.port} 还没就绪`;
    }
    return "尚未启动";
  })();

  return (
    <div className="sv-card" data-state={state}>
      <div className="sv-state">
        <div className="sv-ring">
          <span className="sv-dot" />
        </div>
        <div className="sv-title">
          <div className="sv-line1">
            <span className="sv-name">客户端</span>
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
          <span
            className="sv-k"
            title="客户端 JVM 参数 -Dnc.jstart.server / -Dnc.jstart.port，读自 ierp/bin/prop.xml"
          >
            中间件
          </span>
          <span className="sv-v">
            {status ? `${status.host}:${status.port}` : "—"}
            {status && (
              <small style={{ color: status.serverReachable ? undefined : "hsl(var(--warning-ink))" }}>
                {" "}
                {status.serverReachable ? "可连接" : "未就绪"}
              </small>
            )}
          </span>
        </div>
        <div className="sv-metric">
          <span className="sv-k">已运行</span>
          <span className="sv-v">{running || starting ? formatUptime(status?.uptimeMs ?? 0) : "—"}</span>
        </div>
        <div className="sv-metric">
          {/* 客户端是独立 JVM，有自己的 JDWP 与 DAP 会话；与中间件那条互不影响。 */}
          <span className="sv-k">JDWP</span>
          <span
            className="sv-v sv-jdwp"
            data-on={status?.debugPort ? "" : undefined}
            title={
              status?.debugPort
                ? `客户端 JVM 在本机回环监听 JDWP：127.0.0.1:${status.debugPort}（右侧可附加调试器）`
                : "这次启动没开调试。停止后勾选「调试模式」再启动"
            }
          >
            {status?.debugPort ? `127.0.0.1:${status.debugPort}` : "未开启"}
          </span>
        </div>
        <div className="sv-metric">
          <span className="sv-k" title="Eclipse 客户端规则：工程输出 + 产品公共库 + 模块 public/client + langlib">
            classpath
          </span>
          <span className="sv-v">
            {status?.classpathEntries ? status.classpathEntries : "—"}
            {status?.classpathEntries ? <small> 项</small> : null}
          </span>
        </div>
      </div>

      <div className="sv-actions">
        {/* 与中间件同一个约束：-agentlib 只在启动时读，运行中不能切 */}
        {!running && !starting && (
          <button
            type="button"
            className="sv-btn"
            data-on={debugMode || undefined}
            aria-pressed={debugMode}
            disabled={busy !== null}
            title={
              debugMode
                ? "下次启动带 JDWP（只绑 127.0.0.1，端口由系统分配）；用 IDE / jdb 附加"
                : "开启后启动：客户端 JVM 监听 JDWP 回环端口"
            }
            onClick={onToggleDebugMode}
          >
            <Icon name="bug" size={13} />
            调试模式
          </button>
        )}
        {running && status?.debugPort && (
          debugAttached ? (
            <button
              type="button"
              className="sv-btn"
              disabled={debugBusy}
              title="断开客户端调试适配器；客户端继续运行"
              onClick={onDetachDebug}
            >
              {debugBusy ? <Icon name="spinner" size={13} className="animate-spin" /> : <Icon name="plug" size={13} />}
              {debugBusy ? "断开中…" : "断开调试"}
            </button>
          ) : (
            <button
              type="button"
              className="sv-btn"
              disabled={debugBusy}
              title={`附加到客户端 JDWP 127.0.0.1:${status.debugPort}（工作台内断点/栈/变量）`}
              onClick={onAttachDebug}
            >
              {debugBusy ? <Icon name="spinner" size={13} className="animate-spin" /> : <Icon name="bug" size={13} />}
              {debugBusy ? "附加中…" : "附加调试器"}
            </button>
          )
        )}
        {running && status && !status.debugPort && (
          <button
            type="button"
            className="sv-btn"
            disabled
            title="本次客户端启动没开调试：先停止，勾选「调试模式」再启动（JVM 不会重读启动参数）"
          >
            <Icon name="bug" size={13} />
            附加调试器
          </button>
        )}
        <button
          type="button"
          className="sv-btn"
          disabled={previewing}
          title="查看客户端 JVM 的完整启动命令行（只读预览）"
          onClick={onCommandLine}
        >
          <Icon name="terminal" size={13} />
          {previewing ? "生成中…" : "命令行"}
        </button>
        {running && (
          <button
            type="button"
            className="sv-btn"
            disabled={busy !== null}
            title={busy ? "命令进行中，请稍候" : undefined}
            onClick={onRestart}
          >
            {busy === "restart" ? (
              <Icon name="spinner" size={13} className="animate-spin" />
            ) : (
              <Icon name="refresh" size={13} />
            )}
            {busy === "restart" ? "重启中…" : "重启"}
          </button>
        )}
        {running || starting ? (
          <button
            type="button"
            className="sv-btn sv-btn-danger"
            disabled={busy !== null}
            onClick={onStop}
          >
            {busy === "stop" ? (
              <Icon name="spinner" size={13} className="animate-spin" />
            ) : (
              <Icon name="power" size={13} />
            )}
            {busy === "stop" ? "停止中…" : "停止"}
          </button>
        ) : (
          <button
            type="button"
            className="sv-btn sv-btn-primary"
            disabled={disabled}
            title={starting ? "正在启动，等待 JVM 拉起 Swing 界面…" : undefined}
            onClick={onStart}
          >
            {busy === "start" ? (
              <Icon name="spinner" size={13} className="animate-spin" />
            ) : (
              <Icon name="play" size={13} />
            )}
            {busy === "start" ? "启动中…" : "启动"}
          </button>
        )}
      </div>
    </div>
  );
}
