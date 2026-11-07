// 底部面板的「调试」标签：控制栏 + 线程/调用栈 + 监视/变量 + 断点 + 控制台。
//
// 数据全在 `lib/debugSession`（事件驱动）：这里不做轮询，也不自己拼状态。
import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { errorToast } from "../../lib/errorToast";
import { baseName } from "../../lib/workspace";
import { DebugInspectorContent } from "./DebugInspectorDock";
import { DebugStack } from "./DebugStack";
import { DebugBreakpoints } from "./DebugBreakpoints";
import { DebugConsole } from "./DebugConsole";
import { DebugStopBanner } from "./DebugStopBanner";
import { RemoteAttachForm } from "./RemoteAttachForm";
import {
  attachDebugger,
  detachDebugger,
  pauseDebug,
  resumeDebug,
  selectDebugTarget,
  stepDebug,
  useDebugSnapshot,
} from "../../lib/debugSession";
import { DEBUG_TARGETS, debugTargetLabel } from "../../lib/debug";
import { debugKeyLabels } from "../../lib/debugKeys";
import { claimDebugSourceNavigation } from "../../lib/debugSourceNavigation";
import "../../debug.css";

export function DebugPanel({ onOpenAt }: { onOpenAt: (path: string, line: number) => void }) {
  const snap = useDebugSnapshot();
  const keys = debugKeyLabels();
  const [consoleOpen, setConsoleOpen] = useState(false);
  const attached = snap.status.state === "attached";
  const frame = snap.frames.find((f) => f.id === snap.frameId) ?? null;
  const threadName = snap.threads.find((t) => t.id === snap.threadId)?.name ?? (snap.threadId ? `线程 ${snap.threadId}` : "");

  // stopped 之后栈是异步拉回来的：等 frames 到位再定位一次（只认最新的那一停）
  useEffect(() => {
    if (!snap.paused || !snap.stopSeq) return;
    const f = snap.frames.find((x) => x.id === snap.frameId);
    if (!f?.source?.path) return;
    if (claimDebugSourceNavigation(snap.target, snap.stopSeq)) onOpenAt(f.source.path, f.line);
  }, [snap.paused, snap.target, snap.stopSeq, snap.frames, snap.frameId, onOpenAt]);

  const attach = () =>
    void attachDebugger().catch((e) => errorToast("附加调试器", e));
  const attachRemote = (host: string, port: number) =>
    void attachDebugger("remote", { host, port }).catch((e) =>
      errorToast("附加远程 JVM", e),
    );
  const detach = () =>
    void detachDebugger().catch((e) => errorToast("断开调试", e));

  // 远程目标没填地址前不显示附加按钮：走下面的表单，避免点了才报「缺端口」。
  const showLocalAttach = !attached && snap.target !== "remote";
  const endpoint =
    snap.status.jdwpHost && snap.status.jdwpPort
      ? `${snap.status.jdwpHost}:${snap.status.jdwpPort}`
      : null;
  const where = snap.paused && frame
    ? `${debugTargetLabel(snap.target)} · 已暂停 · ${threadName || "线程"} · ${frame.source?.path ? `${baseName(frame.source.path)}:${frame.line}` : frame.name}`
    : attached
      ? `${debugTargetLabel(snap.target)} · 运行中${endpoint ? ` · ${endpoint}` : ""}`
      : `${debugTargetLabel(snap.target)} · 未附加`;

  return (
    <div className="wb-panel-body dbg-body">
      {/* 中间件 / 客户端 / 远程各一条会话：页签只切换「看哪一个」，不互相断开。 */}
      <div className="dbg-targets" role="tablist" aria-label="调试目标">
        {DEBUG_TARGETS.map((t) => {
          const info = snap.targets?.[t] ?? { state: "stopped", paused: false, busy: null };
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={snap.target === t}
              className="dbg-target"
              data-on={snap.target === t || undefined}
              title={`查看${debugTargetLabel(t)}的调试会话（各目标可以同时附加）`}
              onClick={() => selectDebugTarget(t)}
            >
              <span className="dbg-target-dot" data-state={info.state} data-paused={info.paused || undefined} />
              {debugTargetLabel(t)}
              {info.state === "attached" && <span className="dbg-target-state">已附加</span>}
            </button>
          );
        })}
      </div>

      <div className="dbg-bar">
        <button
          type="button"
          className="dbg-btn dbg-btn-primary"
          disabled={!snap.paused}
          title={`继续运行到下一个断点（${keys.resume}）`}
          onClick={() => void resumeDebug()}
        >
          <Icon name="play" size={12} />
          继续
          <kbd>{keys.resume}</kbd>
        </button>
        <button
          type="button"
          className="dbg-btn"
          disabled={!snap.paused}
          title={`步过：执行完当前行（${keys.over}）`}
          onClick={() => void stepDebug("over")}
        >
          <Icon name="stepOver" size={12} />
          步过
          <kbd>{keys.over}</kbd>
        </button>
        <button
          type="button"
          className="dbg-btn"
          disabled={!snap.paused}
          title={`步入：进入被调用方法（${keys.into}）`}
          onClick={() => void stepDebug("into")}
        >
          <Icon name="stepInto" size={12} />
          步入
          <kbd>{keys.into}</kbd>
        </button>
        <button
          type="button"
          className="dbg-btn"
          disabled={!snap.paused}
          title={`步出：执行完当前方法（${keys.out}）`}
          onClick={() => void stepDebug("out")}
        >
          <Icon name="stepOut" size={12} />
          步出
          <kbd>{keys.out}</kbd>
        </button>
        <button
          type="button"
          className="dbg-btn"
          disabled={!attached || snap.paused || snap.threads.length === 0}
          title={
            snap.paused
              ? "已经停在断点上"
              : snap.threads.length === 0
                ? "拿不到线程列表，暂时不能暂停"
                : "暂停第一个可停线程"
          }
          onClick={() => void pauseDebug()}
        >
          <Icon name="pause" size={12} />
          暂停
        </button>
        <button
          type="button"
          className="dbg-btn"
          data-on={consoleOpen || undefined}
          disabled={!attached}
          title={attached ? "调试控制台：对当前暂停帧试算表达式" : "附加调试器后可用"}
          onClick={() => setConsoleOpen((v) => !v)}
        >
          <Icon name="terminal" size={12} />
          控制台
          {snap.console.length > 0 ? <span className="dbg-btn-count">{snap.console.length}</span> : null}
        </button>
        <span className="dbg-sp" />
        <span className="dbg-where" title={where}>
          {where}
        </span>
        {attached ? (
          <button
            type="button"
            className="dbg-btn dbg-btn-danger"
            disabled={snap.busy !== null}
            title={`断开${debugTargetLabel(snap.target)}调试适配器（进程继续运行）`}
            onClick={detach}
          >
            {snap.busy === "detach" ? <Icon name="spinner" size={12} className="animate-spin" /> : null}
            断开
          </button>
        ) : showLocalAttach ? (
          <button
            type="button"
            className="dbg-btn dbg-btn-primary"
            disabled={snap.busy !== null}
            title={`要求${debugTargetLabel(snap.target)}以「调试模式」启动，且代码智能已就绪`}
            onClick={attach}
          >
            {snap.busy === "attach" ? <Icon name="spinner" size={12} className="animate-spin" /> : <Icon name="bug" size={12} />}
            {snap.busy === "attach" ? "附加中…" : "附加调试器"}
          </button>
        ) : null}
      </div>

      {snap.error && <div className="dbg-error">{snap.error}</div>}

      {snap.paused && (
        <DebugStopBanner reason={snap.stopReason} text={snap.stopText} exception={snap.exception} />
      )}

      {!attached ? (
        snap.target === "remote" ? (
          <RemoteAttachForm busy={snap.busy === "attach"} onAttach={attachRemote} />
        ) : (
          <div className="wb-panel-note dbg-hint">
            还没附加{debugTargetLabel(snap.target)}调试器：到「NC 服务」页
            {snap.target === "client" ? "客户端卡" : "中间件卡"}勾选<b>调试模式</b>再启动
            （JDWP 只绑 127.0.0.1），进程起来后回到这里点「附加调试器」。
            断点可以先在行号槽点好，附加时会整批下发到已附加的会话。
          </div>
        )
      ) : (
        <div className="dbg-cols">
          <div className="dbg-col">
            <DebugStack snap={snap} onOpenAt={onOpenAt} />
          </div>
          <DebugInspectorContent snap={snap} />
          <div className="dbg-col">
            <DebugBreakpoints
              availableFilters={snap.status.exceptionFilters ?? []}
              enabledFilters={snap.enabledFilters}
              onOpenAt={onOpenAt}
            />
          </div>
        </div>
      )}

      {consoleOpen && attached && <DebugConsole paused={snap.paused} entries={snap.console} />}
    </div>
  );
}
