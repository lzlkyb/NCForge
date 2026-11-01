// 底部面板的「调试」标签：控制栏 + 调用栈 + 变量。
//
// 数据全在 `lib/debugSession`（事件驱动）：这里不做轮询，也不自己拼状态。
// 断点不在这里管理——它们挂在编辑器行号槽上，按 F11 旁边那套习惯点击即可。
import { useEffect, useRef } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { failureText } from "../../lib/friendlyError";
import { baseName } from "../../lib/workspace";
import { DebugVariables } from "./DebugVariables";
import {
  attachDebugger,
  detachDebugger,
  pauseDebug,
  resumeDebug,
  selectFrame,
  stepDebug,
  useDebugSnapshot,
} from "../../lib/debugSession";
import { debugKeyLabels } from "../../lib/debugKeys";
import "../../debug.css";

export function DebugPanel({ onOpenAt }: { onOpenAt: (path: string, line: number) => void }) {
  const snap = useDebugSnapshot();
  const keys = debugKeyLabels();
  const attached = snap.status.state === "attached";
  const frame = snap.frames.find((f) => f.id === snap.frameId) ?? null;
  const threadName = snap.threads.find((t) => t.id === snap.threadId)?.name ?? (snap.threadId ? `线程 ${snap.threadId}` : "");

  // stopped 之后栈是异步拉回来的：等 frames 到位再定位一次（只认最新的那一停）
  const revealed = useRef(0);
  useEffect(() => {
    if (!snap.stopSeq || snap.stopSeq === revealed.current) return;
    const f = snap.frames.find((x) => x.id === snap.frameId);
    if (!f?.source?.path) return;
    revealed.current = snap.stopSeq;
    onOpenAt(f.source.path, f.line);
  }, [snap.stopSeq, snap.frames, snap.frameId, onOpenAt]);

  const attach = () =>
    void attachDebugger().catch((e) => toast(failureText("附加调试器", e), "error"));
  const detach = () =>
    void detachDebugger().catch((e) => toast(failureText("断开调试", e), "error"));

  const where = snap.paused && frame
    ? `已暂停 · ${threadName || "线程"} · ${frame.source?.path ? `${baseName(frame.source.path)}:${frame.line}` : frame.name}`
    : attached
      ? "运行中"
      : "未附加";

  return (
    <div className="wb-panel-body dbg-body">
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
        <span className="dbg-sp" />
        <span className="dbg-where" title={where}>
          {where}
        </span>
        {attached ? (
          <button
            type="button"
            className="dbg-btn dbg-btn-danger"
            disabled={snap.busy !== null}
            title="断开调试适配器（服务继续运行）"
            onClick={detach}
          >
            {snap.busy === "detach" ? <Icon name="spinner" size={12} className="animate-spin" /> : null}
            断开
          </button>
        ) : (
          <button
            type="button"
            className="dbg-btn dbg-btn-primary"
            disabled={snap.busy !== null}
            title="要求服务以「调试模式」启动，且代码智能已就绪"
            onClick={attach}
          >
            {snap.busy === "attach" ? <Icon name="spinner" size={12} className="animate-spin" /> : <Icon name="bug" size={12} />}
            {snap.busy === "attach" ? "附加中…" : "附加调试器"}
          </button>
        )}
      </div>

      {snap.error && <div className="dbg-error">{snap.error}</div>}

      {!attached ? (
        <div className="wb-panel-note dbg-hint">
          还没附加调试器：到「NC 服务」页勾选<b>调试模式</b>再启动（JDWP 只绑 127.0.0.1），
          服务起来后回到这里点「附加调试器」。断点可以先在行号槽点好，附加时会整批下发。
        </div>
      ) : (
        <div className="dbg-cols">
          <div className="dbg-col">
            <div className="dbg-col-h">
              调用栈
              {snap.frames.length > 0 && <span>· {snap.frames.length} 帧</span>}
            </div>
            <div className="dbg-list">
              {!snap.paused && <div className="dbg-empty">运行中：命中断点或按「暂停」后显示调用栈。</div>}
              {snap.paused && snap.frames.length === 0 && <div className="dbg-empty">读取调用栈…</div>}
              {snap.frames.map((f) => (
                <button
                  type="button"
                  key={f.id}
                  className="dbg-frame"
                  data-active={f.id === snap.frameId || undefined}
                  title={f.source?.path ? `${f.source.path}:${f.line}` : f.name}
                  onClick={() => void selectFrame(f.id)}
                >
                  <span className="dbg-frame-name">{f.name}</span>
                  <span className="dbg-frame-loc">
                    {f.source?.path ? `${baseName(f.source.path)}:${f.line}` : "—"}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="dbg-col">
            <div className="dbg-col-h">变量{frame ? <span>· {frame.name}</span> : null}</div>
            <div className="dbg-list">
              <DebugVariables paused={snap.paused} scopes={snap.scopes} variables={snap.variables} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
